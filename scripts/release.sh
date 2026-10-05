#!/usr/bin/env bash
# 发版一处搞定：校验 -> 打标签 -> 推送 -> 打印发布步骤
#
# 为什么要有这个脚本（用户发现的问题）：
#   用户："我看有老的版本 也没发布包"
#   实测：git 标签只有 v0.6.0 / v0.7.0；npm 上这个包根本不存在（404）——
#   而 README 一直教 `npx agent-development-constraints install`，
#   那是一条不可能成功的指令。根因是发版手工且没有清单。
#
# 用法：
#   bash scripts/release.sh            # 校验 + 打标签 + 推送
#   bash scripts/release.sh --dry-run  # 只校验，不动 git
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

fail() { echo "  ✗ $1" >&2; exit 1; }
ok()   { echo "  ✓ $1"; }

version="$(tr -d '[:space:]' < VERSION)"
echo
echo "发版校验（VERSION = $version）"
echo

echo "[1/5] 单元测试"
npm test >/dev/null 2>&1 || fail "npm test 失败"
ok "npm test 通过"

echo "[2/5] 脱敏检查"
bash scripts/sanitize-check.sh >/dev/null 2>&1 || fail "脱敏检查失败（C-008 要求提交前必过）"
ok "脱敏检查通过"

echo "[3/5] 版本一致性"
pkg_version="$(node -p "require('./package.json').version")"
[ "$pkg_version" = "$version" ] || fail "package.json（$pkg_version）与 VERSION（$version）不一致"
cl_first="$(grep -oE '^## \[[0-9]+\.[0-9]+\.[0-9]+\]' CHANGELOG.md | head -1 | tr -d '#[] ')"
[ -n "$cl_first" ] || fail "CHANGELOG 里找不到 ## [x.y.z] 条目"
[ "$cl_first" = "$version" ] || fail "CHANGELOG 首条是 $cl_first，VERSION 是 $version —— 发版时要一起改"
ok "VERSION / package.json / CHANGELOG 三处一致"

echo "[4/5] 工作区状态"
if [ -n "$(git status --porcelain)" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "  ! 工作区有未提交改动（dry-run 下不拦）"
  else
    fail "工作区有未提交改动，先提交再打标签"
  fi
else
  ok "工作区干净"
fi

tag="v$version"
echo "[5/5] 标签 $tag"
if git tag -l "$tag" | grep -q .; then
  echo "  ! 标签 $tag 已存在，跳过"
elif [ "$DRY_RUN" = "1" ]; then
  echo "  (dry-run) 将执行：git tag $tag && git push origin $tag"
else
  git tag -a "$tag" -m "release $version"
  ok "已创建标签 $tag"
  git push origin "$tag"
  ok "已推送标签 $tag"
fi

cat <<EOF

接下来（需要你的账号，脚本不代替）：

  1) GitHub Release（让版本在仓库首页可见）
     https://github.com/962599627/agent-development-constraints/releases/new?tag=$tag
     标题填 $version，正文从 CHANGELOG.md 对应段落复制

  2) 发布到 npm（发布之后，README 里的短形式 npx 才成立）
     npm login          # 只需一次
     npm publish        # 本包未设 private，files 白名单已在 package.json 里

  3) 发布 npm 之后，把 README / index.mjs 里的 github: 前缀换回短形式
     （tests/plugin.spec.mjs 的【发布】用例会提醒你哪些地方要改）

EOF
