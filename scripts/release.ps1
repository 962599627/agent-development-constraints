# 发版一处搞定：校验 -> 打标签 -> 推送 -> 打印发布步骤
#
# ## 为什么要有这个脚本（用户发现的问题）
#
# 用户："我看有老的版本 也没发布包"
# 实测：
#   · git 标签只有 v0.6.0 / v0.7.0  -> GitHub 上只看得见老版本
#   · npm 上这个包**不存在**（404）  -> README 教的 `npx agent-development-constraints`
#                                      从第一天起就是一条不可能成功的指令
#
# 根因是"发版是手工的、且没有清单"：版本号改了、CHANGELOG 忘了；
# 标签忘了打；包从来没发。所以把机械部分收进这一个脚本。
#
# 用法：
#   pwsh scripts/release.ps1            # 校验 + 打标签 + 推送
#   pwsh scripts/release.ps1 -DryRun    # 只校验，不动 git

param(
  [switch]$DryRun
)

# ⚠️ 这里用 'Continue' 而不是 'Stop'。
#    原因：`git push` 会把进度写到 **stderr**，而 PowerShell 在
#    $ErrorActionPreference='Stop' 下会把原生命令的 stderr 当成
#    NativeCommandError 当场中断 —— 实测推送已经成功了，
#    脚本却报失败并停在了打标签之前。
#    （规则库 stacks/shell.md 记录过："退出码 1，但命令实际成功了"。）
#    正确性不受影响：每个关键步骤都用 $LASTEXITCODE 显式判断，
#    失败时调 Fail() 退出。
$ErrorActionPreference = 'Continue'

# 原生命令的 stderr 不要触发 NativeCommandError（PS 7.3+ 才有该变量）
if ($PSVersionTable.PSVersion.Major -ge 7) { $PSNativeCommandUseErrorActionPreference = $false }
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Fail($msg) {
  Write-Host "  ✗ $msg" -ForegroundColor Red
  exit 1
}
function Ok($msg) {
  Write-Host "  ✓ $msg" -ForegroundColor Green
}

$version = (Get-Content VERSION -Encoding UTF8).Trim()
Write-Host "`n发版校验（VERSION = $version）`n" -ForegroundColor Cyan

# ---------- 1) 测试 ----------
Write-Host "[1/5] 单元测试"
npm test 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "npm test 失败" }
Ok "npm test 通过"

# ---------- 2) 脱敏检查 ----------
Write-Host "[2/5] 脱敏检查"
# ⚠️ 直接调用脚本文件，**不要**再起一个 `pwsh -File`：
#    很多 Windows 上只有 powershell.exe 而没有 pwsh（PATH 里找不到），
#    用外部进程会让这一步莫名失败。当前宿主能跑就直接跑。
& (Join-Path $PSScriptRoot 'sanitize-check.ps1') *>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "脱敏检查失败（C-008 要求提交前必过）" }
Ok "脱敏检查通过"

# ---------- 3) 版本一致性 ----------
Write-Host "[3/5] 版本一致性"
$pkgVersion = (Get-Content package.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($pkgVersion -ne $version) { Fail "package.json（$pkgVersion）与 VERSION（$version）不一致" }
$changelog = Get-Content CHANGELOG.md -Raw -Encoding UTF8
$m = [regex]::Match($changelog, '(?m)^##\s+\[(\d+\.\d+\.\d+)\]')
if (-not $m.Success) { Fail "CHANGELOG 里找不到 ## [x.y.z] 条目" }
if ($m.Groups[1].Value -ne $version) {
  Fail "CHANGELOG 首条是 $($m.Groups[1].Value)，VERSION 是 $version —— 发版时要一起改"
}
Ok "VERSION / package.json / CHANGELOG 三处一致"

# ---------- 4) 工作区干净 ----------
Write-Host "[4/5] 工作区状态"
$dirty = git status --porcelain
if ($dirty) {
  if ($DryRun) {
    Write-Host "  ! 工作区有未提交改动（DryRun 下不拦）" -ForegroundColor Yellow
  } else {
    Fail "工作区有未提交改动，先提交再打标签：`n$dirty"
  }
} else {
  Ok "工作区干净"
}

# ---------- 5) 打标签并推送 ----------
$tag = "v$version"
Write-Host "[5/5] 标签 $tag"
$exists = git tag -l $tag
if ($exists) {
  Write-Host "  ! 标签 $tag 已存在，跳过" -ForegroundColor Yellow
} elseif ($DryRun) {
  Write-Host "  (DryRun) 将执行：git push origin main && git tag $tag && git push origin $tag" -ForegroundColor Yellow
} else {
  # ⚠️ 先推**主分支**，再推标签。
  #    第一版只推标签 —— 标签指向的提交在远端 main 上还不存在，
  #    仓库首页的分支内容与标签不一致。本次真实发版时发现的。
  git push origin main
  if ($LASTEXITCODE -ne 0) { Fail "推送 main 失败" }
  Ok "已推送 main"

  git tag -a $tag -m "release $version"
  if ($LASTEXITCODE -ne 0) { Fail "打标签失败" }
  Ok "已创建标签 $tag"
  git push origin $tag
  if ($LASTEXITCODE -ne 0) { Fail "推送标签失败" }
  Ok "已推送标签 $tag"
}

Write-Host "`n接下来（需要你的账号，脚本不代替）：`n" -ForegroundColor Cyan
Write-Host "  1) GitHub Release（让版本在仓库首页可见）"
Write-Host "     https://github.com/962599627/agent-development-constraints/releases/new?tag=$tag"
Write-Host "     标题填 $version，正文从 CHANGELOG.md 对应段落复制`n"
Write-Host "  2) 发布到 npm（发布之后，README 里的短形式 npx 才成立）"
Write-Host "     npm login          # 只需一次"
Write-Host "     npm publish        # 本包未设 private，files 白名单已在 package.json 里`n"
Write-Host "  3) 发布 npm 之后，把 README / index.mjs 里的 github: 前缀换回短形式"
Write-Host "     （tests/plugin.spec.mjs 的【发布】用例会提醒你哪些地方要改）`n"
