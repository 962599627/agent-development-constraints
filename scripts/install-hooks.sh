#!/usr/bin/env bash
#
# 安装 git hooks —— 让脱敏检查在每次提交时自动运行。
#
# git 的 .git/hooks/ 目录**不会随仓库分发**，所以团队成员的仓库里默认没有 hook。
# 本脚本把 core.hooksPath 指向仓库里的 .githooks/，hook 就跟着代码走了。
#
# 用法：./scripts/install-hooks.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 包可能被安装在目标项目的子目录（agent-constraints/scripts/），
# 也可能本仓库就是包本身（scripts/）—— 两种都试
ROOT=""
for candidate in "$HERE/../.." "$HERE/.."; do
    candidate="$(cd "$candidate" 2>/dev/null && pwd || true)"
    if [ -n "$candidate" ] && [ -d "$candidate/.git" ] && [ -f "$candidate/.githooks/pre-commit" ]; then
        ROOT="$candidate"
        break
    fi
done

if [ -z "$ROOT" ]; then
    echo "错误：找不到同时含 .git 与 .githooks/pre-commit 的仓库根" >&2
    exit 1
fi

cd "$ROOT"
git config core.hooksPath .githooks

echo ""
echo "✓ git hooks 已启用（core.hooksPath = .githooks）"
echo ""
echo "  现在每次 git commit 都会先跑脱敏检查："
echo "    scripts/sanitize-check.ps1 -Path <本次暂存的文件>"
echo ""
echo "  检查不通过会**拒绝提交**，并告诉你哪一行、命中哪条规则。"
echo "  确有需要绕过时：git commit --no-verify（请说明理由）"
echo ""
