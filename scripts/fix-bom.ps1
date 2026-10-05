# 给所有 .ps1 补 UTF-8 BOM
#
# ## 为什么需要它
#
# Windows PowerShell 5.1 对**无 BOM** 的 .ps1 按 ANSI/GBK 读取 ——
# 中文注释会变成乱码（`锛坱ests/...`），脚本报「字符串缺少终止符」直接跑不起来。
# 规则库 `stacks/shell.md` 记录了这类症状。
#
# 而这个坑会**反复出现**：用不带 BOM 的编辑器/工具（很多 AI 编辑工具就是）
# 改一次 .ps1，BOM 就没了。测试 `【发布】所有 .ps1 必须带 UTF-8 BOM`
# 会拦住它 —— 跑这个脚本即可修好。
#
# 用法：
#   pwsh scripts/fix-bom.ps1          # 只补缺的
#   pwsh scripts/fix-bom.ps1 -Check   # 只检查，不改（缺就退出码 1）

param(
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$fixed = @()

Get-ChildItem -Path $root -Recurse -Include *.ps1 -File |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\\.git\\' } |
  ForEach-Object {
    $path = $_.FullName
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $hasBom = $bytes.Length -ge 3 -and
      $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $rel = $path.Replace($root + '\', '')
    if ($hasBom) {
      if ($Check) { Write-Host "  OK   $rel" }
      return
    }
    if ($Check) {
      Write-Host "  缺 BOM  $rel" -ForegroundColor Red
      $script:fixed += $rel
      return
    }
    $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($true)))
    Write-Host "  已补 BOM  $rel" -ForegroundColor Green
    $script:fixed += $rel
  }

if ($Check -and $fixed.Count -gt 0) {
  Write-Host "`n$($fixed.Count) 个 .ps1 缺 UTF-8 BOM，跑 pwsh scripts/fix-bom.ps1 修。" -ForegroundColor Red
  exit 1
}
if (-not $Check) {
  if ($fixed.Count -eq 0) { Write-Host "  全部 .ps1 都已有 BOM" }
  else { Write-Host "`n  共修复 $($fixed.Count) 个文件" }
}
