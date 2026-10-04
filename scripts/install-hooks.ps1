<#
.SYNOPSIS
    安装 git hooks —— 让脱敏检查在每次提交时自动运行。

.DESCRIPTION
    git 的 .git/hooks/ 目录**不会随仓库分发**，所以团队成员的仓库里默认没有 hook。
    本脚本把 core.hooksPath 指向仓库里的 .githooks/ 目录，
    这样 hook 跟着代码走，clone 后跑一次本脚本就生效。

.EXAMPLE
    .\scripts\install-hooks.ps1
#>
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent

Push-Location $root
try {
    if (-not (Test-Path (Join-Path $root '.git'))) {
        throw "$root 不是 git 仓库"
    }
    if (-not (Test-Path (Join-Path $root '.githooks\pre-commit'))) {
        throw "找不到 .githooks\pre-commit"
    }

    git config core.hooksPath .githooks

    Write-Host ""
    Write-Host "✓ git hooks 已启用（core.hooksPath = .githooks）" -ForegroundColor Green
    Write-Host ""
    Write-Host "  现在每次 git commit 都会先跑脱敏检查：" -ForegroundColor Cyan
    Write-Host "    scripts/sanitize-check.ps1 -Path <本次暂存的文件>"
    Write-Host ""
    Write-Host "  检查不通过会**拒绝提交**，并告诉你哪一行、命中哪条规则。" -ForegroundColor Cyan
    Write-Host "  确有需要绕过时：git commit --no-verify（请说明理由）" -ForegroundColor DarkGray
    Write-Host ""
}
finally {
    Pop-Location
}
