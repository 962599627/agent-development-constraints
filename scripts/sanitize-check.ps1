<#
.SYNOPSIS
    脱敏检查 —— 扫描仓库内容，找出可能暴露自身安全的信息。

.DESCRIPTION
    读 .sanitize-deny.txt 里的正则，逐行扫描 **git 跟踪的文件**，
    这是"会被推上去的东西"，也是唯一需要担心的范围。

    设计要点：
    - 默认只查已跟踪文件（未跟踪的东西还不会被推送出去）
    - 支持 `!` 开头的允许清单，放过示例占位符（如 your_password）
    - 自动跳过黑名单文件自己（它就是模式的来源，必然自匹配）
    - 命中即以退出码 1 结束，可直接用作 pre-commit hook

.PARAMETER Path
    只检查指定路径（默认全部已跟踪文件）。适合在 hook 里只查本次改动的文件。

.PARAMETER All
    连未跟踪的文件一起检查（用于首次公开前的全量体检）。

.PARAMETER Quiet
    只输出结论，不逐条列出命中。

.EXAMPLE
    .\scripts\sanitize-check.ps1                # 全量检查
    .\scripts\sanitize-check.ps1 -All           # 含未跟踪文件
    .\scripts\sanitize-check.ps1 -Path a.md     # 只查指定文件
#>
param(
    [string[]]$Path,
    [switch]$All,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

# ---------- 读黑名单 ----------
$denyFile = Join-Path $root '.sanitize-deny.txt'
if (-not (Test-Path $denyFile)) {
    Write-Host "找不到 $denyFile" -ForegroundColor Red
    exit 2
}

$denyRules = @()   # 拦截规则
$allowRules = @()  # 允许清单（命中即放过这一行）

foreach ($line in [System.IO.File]::ReadAllLines($denyFile, [System.Text.Encoding]::UTF8)) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    if ($t.StartsWith('!')) {
        $allowRules += $t.Substring(1)
    } else {
        $denyRules += $t
    }
}

if ($denyRules.Count -eq 0) {
    Write-Host "黑名单里没有任何规则" -ForegroundColor Yellow
    exit 0
}

# ---------- 收集要检查的文件 ----------
Push-Location $root
try {
    if ($Path) {
        $files = $Path | Where-Object { Test-Path $_ } | ForEach-Object { (Resolve-Path $_).Path }
    }
    elseif ($All) {
        $files = Get-ChildItem -Recurse -File -Force |
            Where-Object { $_.FullName -notmatch '\\\.git\\' } |
            ForEach-Object { $_.FullName }
    }
    else {
        $files = git ls-files | ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path $_ }
    }
}
finally {
    Pop-Location
}

if (-not $files -or $files.Count -eq 0) {
    Write-Host "没有需要检查的文件" -ForegroundColor DarkGray
    exit 0
}

# ---------- 逐文件扫描 ----------
$denyFileFull = (Resolve-Path $denyFile).Path
$binaryExt = @('.exe', '.dll', '.zip', '.gz', '.tar', '.png', '.jpg', '.jpeg', '.gif',
               '.webp', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.mp4', '.webm', '.pyc')
$findings = @()
$checked = 0

foreach ($f in $files) {
    # 跳过黑名单自己（它必然包含所有模式）、二进制文件
    if ($f -eq $denyFileFull) { continue }
    if ($binaryExt -contains ([System.IO.Path]::GetExtension($f).ToLower())) { continue }

    $rel = $f.Replace($root + '\', '').Replace('\', '/')
    $checked++

    # ⚠️ 读不了的文件要**跳过**，不能让它把整次检查弄崩。
    #    实测（2026-10-05）：-All 模式撞上 PyInstaller 的 _MEI 临时目录，
    #    报 "Access to the path ... is denied"，整次检查以异常结束 ——
    #    而那个文件根本不在检查范围内，不该影响结论。
    try {
        $lines = [System.IO.File]::ReadAllLines($f, [System.Text.Encoding]::UTF8)
    }
    catch {
        Write-Host ("  ⚠️  跳过（读不了）: " + $rel) -ForegroundColor DarkYellow
        continue
    }
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $text = $lines[$i]

        foreach ($rule in $denyRules) {
            if ($text -notmatch $rule) { continue }

            # 允许清单：这一行若命中任一允许规则，就放过
            $allowed = $false
            foreach ($a in $allowRules) {
                if ($text -match $a) { $allowed = $true; break }
            }
            if ($allowed) { continue }

            $findings += [PSCustomObject]@{
                File = $rel
                Line = $i + 1
                Rule = $rule
                Text = if ($text.Length -gt 90) { $text.Substring(0, 90) + '…' } else { $text }
            }
            break   # 一行只报一次
        }
    }
}

# ---------- 输出 ----------
# 语气说明：这是一个**提醒**，不是审判。
# 它的定位是"别把该留在家里的东西带出门"，不是"审查你"。
# 所以输出刻意避免"违规""错误"这类字眼。
Write-Host ""
if ($findings.Count -eq 0) {
    Write-Host "脱敏检查通过（$checked 个文件，$($denyRules.Count) 条规则）" -ForegroundColor Green
    exit 0
}

Write-Host "提醒：有 $($findings.Count) 处内容可能不适合带出去。" -ForegroundColor Yellow
Write-Host "（这是安全网，不是审判 —— 确认无害就加进允许清单即可）" -ForegroundColor DarkGray
Write-Host ""
if (-not $Quiet) {
    $grouped = $findings | Group-Object File
    foreach ($g in $grouped) {
        Write-Host "  $($g.Name)" -ForegroundColor Yellow
        foreach ($x in $g.Group) {
            Write-Host "    第 $($x.Line) 行  ←  匹配: $($x.Rule)"
            Write-Host "      $($x.Text)" -ForegroundColor DarkGray
        }
    }
}
Write-Host ""
Write-Host "三种处理方式：" -ForegroundColor Cyan
Write-Host "  1. 脱敏：把具体值改成通用描述（如 项目名 → 某项目）"
Write-Host "  2. 无害示例：把它的特征加进 .sanitize-deny.txt 的允许清单（以 ! 开头）"
Write-Host "  3. 误报：调整 .sanitize-deny.txt 里对应的正则"
Write-Host ""
Write-Host "不想要这道检查？删掉 scripts/ .githooks/ .sanitize-deny.txt 即可，" -ForegroundColor DarkGray
Write-Host "规则库与提炼流程照常工作 —— 脱敏是外围，学习才是内核。" -ForegroundColor DarkGray
Write-Host ""
exit 1
