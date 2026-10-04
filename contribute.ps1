<#
.SYNOPSIS
    从项目里提取你新增的开发约束，生成可提交的贡献包。

.DESCRIPTION
    原理：安装时会把当时主库的规则 ID 列表存进 agent-constraints/.baseline。
    本脚本对比「当前规则库」与「基线」，找出**你新增的规则**，
    导出成一个独立的贡献文件 —— 只包含你的东西，不含主库原有内容。

    找不到基线时（比如手工复制的包），退化为导出全部规则并提示确认。

.PARAMETER Project
    项目根目录。默认当前目录。

.PARAMETER OutFile
    输出文件路径。默认 <项目>/contribution-<日期>.md

.PARAMETER All
    忽略基线，导出全部规则（用于首次贡献或基线丢失时）。

.EXAMPLE
    .\contribute.ps1
    .\contribute.ps1 F:\my-project
    .\contribute.ps1 -All
#>
param(
    [Parameter(Position = 0)]
    [string]$Project = ".",

    [string]$OutFile,
    [switch]$All
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Project)) { throw "项目不存在：$Project" }
$root = (Resolve-Path $Project).Path
$pkg  = Join-Path $root "agent-constraints"
$constraints = Join-Path $pkg "core\constraints.md"

if (-not (Test-Path $constraints)) {
    throw "没找到 $constraints —— 该规则库未安装到这个项目"
}

if (-not $OutFile) {
    $OutFile = Join-Path $root ("contribution-" + (Get-Date -Format "yyyyMMdd") + ".md")
}

Write-Host ""
Write-Host "扫描规则库…" -ForegroundColor Cyan

# ---------- 1. 读出当前所有规则（含完整正文）----------
$raw = [System.IO.File]::ReadAllText($constraints, [System.Text.Encoding]::UTF8)
$lines = $raw -split "`r?`n"

# 规则起始行：### X-001 标题   （X 为 R/C/T 等层级前缀）
$starts = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^###\s+([A-Z]-\d+)\s+(.+)$') {
        $starts += [PSCustomObject]@{ Index = $i; Id = $Matches[1]; Title = $Matches[2].Trim() }
    }
}

if ($starts.Count -eq 0) {
    Write-Host "  规则库里没找到规则（格式应为 '### R-001 标题'）" -ForegroundColor Yellow
    exit 0
}

# 每条规则的正文：从它的标题行到下一个规则标题之前
$rules = @()
for ($k = 0; $k -lt $starts.Count; $k++) {
    $from = $starts[$k].Index
    $to   = if ($k + 1 -lt $starts.Count) { $starts[$k + 1].Index - 1 } else { $lines.Count - 1 }
    $body = ($lines[$from..$to] -join "`n").TrimEnd()
    $rules += [PSCustomObject]@{
        Id    = $starts[$k].Id
        Title = $starts[$k].Title
        Body  = $body
    }
}

# ---------- 2. 读基线 ----------
$baselineFile = Join-Path $pkg ".baseline"
$baselineIds = @()
$hasBaseline = $false

if ((Test-Path $baselineFile) -and -not $All) {
    $hasBaseline = $true
    foreach ($l in (Get-Content $baselineFile -Encoding UTF8)) {
        if ($l -match '^([A-Z]-\d+)') { $baselineIds += $Matches[1] }
    }
    # 基线里还有版本信息行（形如 "# version: 0.1.0"），忽略
}

# ---------- 3. 找新增 ----------
if ($All -or -not $hasBaseline) {
    $newRules = @($rules)
    $mode = if ($All) { "全部规则（-All）" } else { "全部规则（无基线，首次贡献或手工复制的包）" }
}
else {
    # ⚠️ 必须用 @() 强制成数组：只匹配到 1 条时 Where-Object 返回单个对象，
    # 而 Windows PowerShell 5.1 下单个 PSCustomObject 取不到 .Count（显示为空白）。
    $newRules = @($rules | Where-Object { $_.Id -notin $baselineIds })
    $mode = "新增规则（对比安装时的基线）"
}

Write-Host "  规则总数：$($rules.Count)，基线：$($baselineIds.Count)"
Write-Host "  本次导出：$($newRules.Count) 条 —— $mode" -ForegroundColor Green

if ($newRules.Count -eq 0) {
    Write-Host ""
    Write-Host "没有发现新增规则。" -ForegroundColor Yellow
    Write-Host "  如果你确实加了规则，请确认格式是 '### R-0XX 标题'；"
    Write-Host "  或用 -All 导出全部。"
    exit 0
}

# ---------- 4. 生成贡献包 ----------
$version = "unknown"
$vf = Join-Path $pkg "VERSION"
if (Test-Path $vf) { $version = (Get-Content $vf -Raw).Trim() }

$header = @(
    "# 开发约束贡献包",
    "",
    "- 生成时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm')",
    "- 来源项目：$(Split-Path $root -Leaf)",
    "- 基于约束包版本：$version",
    "- 导出模式：$mode",
    "- 规则数：$($newRules.Count)",
    "",
    "> 提交方式见仓库的 CONTRIBUTING.md。维护者合并时会把同一「违反场景」的规则合并，",
    "> 并让你的来源计入该规则的**独立发现次数**（≥3 次会升级为铁律）。",
    "",
    "---",
    ""
)

$bodyParts = @()
foreach ($r in $newRules) {
    $bodyParts += $r.Body
    $bodyParts += ""
    $bodyParts += "---"
    $bodyParts += ""
}

$final = ($header -join "`n") + ($bodyParts -join "`n")
[System.IO.File]::WriteAllText($OutFile, $final, (New-Object System.Text.UTF8Encoding $false))

Write-Host ""
Write-Host "已生成：$OutFile" -ForegroundColor Green
Write-Host ""
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  1. 检查这份文件，删掉不想公开的项目细节（项目名可以匿名成「某电商后台」）"
Write-Host "  2. 确认每条规则四要素齐全（规则/触发/检查/证据）"
Write-Host "  3. 提交到 https://github.com/962599627/agent-development-constraints"
Write-Host ""
