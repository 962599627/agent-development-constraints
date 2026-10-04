<#
.SYNOPSIS
    把「智能体开发约束包」安装到目标项目。

.DESCRIPTION
    设计原则：**幂等**。重复安装不会破坏你已经积累的规则。

    - core/constraints.md（你的规则库）  → 已存在则**保留不覆盖**
    - core/DISTILL.md / PRUNE.md（流程）  → 总是更新（随包升级）
    - templates/                          → 总是更新
    - AGENTS.md                           → 追加一段引用（带标记，重复安装不重复追加）

.PARAMETER Target
    目标项目根目录。默认当前目录。

.PARAMETER Force
    连 constraints.md 也覆盖。**会丢失你积累的规则**，请先备份。

.PARAMETER SkipAgents
    不往 AGENTS.md 注入引用。

.EXAMPLE
    .\install.ps1                       # 装到当前目录
    .\install.ps1 F:\my-project         # 装到指定项目
    .\install.ps1 -SkipAgents           # 只复制文件，不改 AGENTS.md
#>
param(
    [Parameter(Position = 0)]
    [string]$Target = ".",

    [switch]$Force,
    [switch]$SkipAgents
)

$ErrorActionPreference = "Stop"
$src = $PSScriptRoot

# ---------- 校验 ----------
if (-not (Test-Path $Target)) {
    throw "目标不存在：$Target"
}
$targetRoot = (Resolve-Path $Target).Path

# 防止把包装进自己
if ($targetRoot -eq (Resolve-Path $src).Path) {
    throw "目标就是包本身，请指定项目目录"
}

$pkgDir = Join-Path $targetRoot "agent-constraints"

Write-Host ""
Write-Host "智能体开发约束包 → $pkgDir" -ForegroundColor Cyan

# ---------- 1. 目录 ----------
foreach ($d in @($pkgDir, "$pkgDir\core", "$pkgDir\core\stacks", "$pkgDir\templates")) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

# ---------- 2. 流程文档（总是更新）----------
Copy-Item "$src\core\DISTILL.md"     "$pkgDir\core\" -Force
Copy-Item "$src\core\PRUNE.md"       "$pkgDir\core\" -Force
Copy-Item "$src\core\MERGE.md"       "$pkgDir\core\" -Force
# 技术栈坑位库（按语言分组：python / javascript / shell / git / platform）
Copy-Item "$src\core\stacks\*"       "$pkgDir\core\stacks\" -Force
Copy-Item "$src\templates\*"         "$pkgDir\templates\" -Force
Copy-Item "$src\README.md"           "$pkgDir\" -Force
Copy-Item "$src\README.zh-CN.md"     "$pkgDir\" -Force
Copy-Item "$src\CONTRIBUTING.md"     "$pkgDir\" -Force
Copy-Item "$src\PRIVACY.md"          "$pkgDir\" -Force
Copy-Item "$src\CHANGELOG.md"        "$pkgDir\" -Force
Copy-Item "$src\VERSION"             "$pkgDir\" -Force
if (Test-Path "$src\contribute.ps1") { Copy-Item "$src\contribute.ps1" "$pkgDir\" -Force }
if (Test-Path "$src\contribute.sh")  { Copy-Item "$src\contribute.sh"  "$pkgDir\" -Force }

# 脱敏检查（防止把自身安全信息推上去）—— 黑名单随包分发，可自行增删
Copy-Item "$src\.sanitize-deny.txt"  "$pkgDir\" -Force
New-Item -ItemType Directory -Force -Path "$pkgDir\scripts" | Out-Null
Copy-Item "$src\scripts\*"           "$pkgDir\scripts\" -Force

# ⚠️ git hooks 必须放在**目标项目根**（git 只认仓库根的 .githooks），
#    放在 agent-constraints/ 下面是不会生效的
if (Test-Path "$src\.githooks") {
    New-Item -ItemType Directory -Force -Path "$targetRoot\.githooks" | Out-Null
    Copy-Item "$src\.githooks\*" "$targetRoot\.githooks\" -Force
}
Write-Host "  ✓ 流程文档与模板已更新" -ForegroundColor Green

# ---------- 3. 规则库（默认不覆盖）----------
$constraints = Join-Path $pkgDir "core\constraints.md"
if ((Test-Path $constraints) -and -not $Force) {
    Write-Host "  ⚠ 已存在 core\constraints.md —— 保留你积累的规则不动" -ForegroundColor Yellow
    Write-Host "    （新版本规则模板见 $src\core\constraints.md，如需覆盖加 -Force）" -ForegroundColor DarkGray
}
else {
    Copy-Item "$src\core\constraints.md" "$pkgDir\core\" -Force
    Write-Host "  ✓ 规则库已安装" -ForegroundColor Green
}

# ---------- 4. 注入 AGENTS.md 引用（幂等，靠标记判断）----------
if (-not $SkipAgents) {
    $beginMark = "<!-- agent-constraints:begin -->"
    $endMark   = "<!-- agent-constraints:end -->"
    # ⚠️ 这里必须用**单引号**字符串：PowerShell 双引号里反引号是转义符，
    # `a 会被解析成 BEL 控制字符，把路径开头的 "a" 吃掉（实测踩过这个坑）。
    $block = @(
        $beginMark,
        '## 开发约束（必读）',
        '',
        '本项目所有开发约束见 `agent-constraints/core/constraints.md`。',
        '动手前先读它；每完成一个功能或修完一个 bug，按 `agent-constraints/core/DISTILL.md` 提炼新规则。',
        $endMark
    ) -join "`r`n"

    # 优先写进 AI 会读的文件，按顺序找第一个存在的
    $agentsFile = $null
    foreach ($name in @("AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules")) {
        $p = Join-Path $targetRoot $name
        if (Test-Path $p) { $agentsFile = $p; break }
    }
    if (-not $agentsFile) { $agentsFile = Join-Path $targetRoot "AGENTS.md" }

    $content = if (Test-Path $agentsFile) { Get-Content $agentsFile -Raw -Encoding UTF8 } else { "" }

    if ($content -match [regex]::Escape($beginMark)) {
        # 已注入过：替换旧块，保证升级后引用是最新的
        $pattern = "(?s)" + [regex]::Escape($beginMark) + ".*?" + [regex]::Escape($endMark)
        $content = [regex]::Replace($content, $pattern, $block)
        Write-Host "  ✓ $(Split-Path $agentsFile -Leaf) 中的引用已刷新" -ForegroundColor Green
    }
    else {
        $content = ($content.TrimEnd() + "`r`n`r`n" + $block + "`r`n")
        Write-Host "  ✓ 已向 $(Split-Path $agentsFile -Leaf) 注入引用" -ForegroundColor Green
    }

    # UTF8 无 BOM（BOM 会让某些工具的 markdown 解析出现多余字符）
    [System.IO.File]::WriteAllText($agentsFile, $content, (New-Object System.Text.UTF8Encoding $false))
}

# ---------- 4.5 保存基线 ----------
# 记录本版本包含哪些规则 ID，供 contribute.ps1 识别"**你**新增的规则"。
# 关键设计：**只在首次安装时写**，之后**永不更新** ——
# 若每次都刷新，你后续自己加的规则就会被当成主库原有内容而漏报（丢失你的资产）。
# 代价是主库升级带来的新规则可能出现在你的贡献包里，这属于可接受的噪音。
$baselineFile = Join-Path $pkgDir ".baseline"
if (-not (Test-Path $baselineFile)) {
    $ver = "unknown"
    $vf = Join-Path $src "VERSION"
    if (Test-Path $vf) { $ver = (Get-Content $vf -Raw).Trim() }

    $ids = @()
    if (Test-Path $constraints) {
        $ids = Select-String -Path $constraints -Pattern '^###\s+([A-Z]-\d+)' |
               ForEach-Object { $_.Matches[0].Groups[1].Value }
    }

    $bl = @(
        "# version: $ver",
        "# installed: $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
        "# 本文件记录安装时的规则 ID，供 contribute 脚本识别你新增的规则。",
        "# 请勿手工修改，也请勿在升级时重建它（会丢失你已积累的规则记录）。"
    ) + $ids
    [System.IO.File]::WriteAllText($baselineFile, ($bl -join "`r`n"), (New-Object System.Text.UTF8Encoding $false))
    Write-Host "  ✓ 已保存基线（$($ids.Count) 条规则），贡献脚本靠它识别你的新增" -ForegroundColor Green
}
else {
    Write-Host "  · 基线已存在，保留不动（避免把你新增的规则误判为主库原有）" -ForegroundColor DarkGray
}

# ---------- 5. 提示 ----------
Write-Host ""
Write-Host "完成。下一步：" -ForegroundColor Cyan
Write-Host "  1. 打开 core\constraints.md —— 删掉不适用的 L0 / L1 条目"
Write-Host "     （重点看「快速定位 · 按症状查」表，那是出问题时的入口）"
Write-Host "  2. 打开 core\stacks\ —— 技术栈坑位库，整组替换成你自己的栈"
Write-Host "     （python / javascript / shell / git / platform）"
Write-Host "  3. 每完成一个功能/修完一个 bug，跑一次 core\DISTILL.md 的流程"
Write-Host "  4. L0 超过 15 条时，跑一次 core\PRUNE.md"
Write-Host "  5. 想把你的规则贡献回主库：跑 contribute.ps1，再按 CONTRIBUTING.md 提交"
Write-Host "  6. 启用脱敏检查（每次提交自动拦截敏感信息）：scripts\install-hooks.ps1" -ForegroundColor Yellow
Write-Host ""
