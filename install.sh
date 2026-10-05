#!/usr/bin/env bash
#
# 把「智能体开发约束包」安装到目标项目。
#
# 设计原则：**幂等**。重复安装不会破坏你已经积累的规则。
#   - core/constraints.md（你的规则库） → 已存在则保留不覆盖
#   - core/DISTILL.md / PRUNE.md（流程） → 总是更新
#   - templates/                        → 总是更新
#   - AGENTS.md                         → 追加引用（带标记，重复安装不重复追加）
#
# 用法：
#   ./install.sh                     # 装到当前目录
#   ./install.sh /path/to/project    # 装到指定项目
#   ./install.sh --force             # 连 constraints.md 也覆盖（会丢规则，先备份）
#   ./install.sh --skip-agents       # 不往 AGENTS.md 注入引用

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="."
FORCE=0
SKIP_AGENTS=0

for arg in "$@"; do
  case "$arg" in
    --force)       FORCE=1 ;;
    --skip-agents) SKIP_AGENTS=1 ;;
    -h|--help)     sed -n '2,20p' "$0"; exit 0 ;;
    *)             TARGET="$arg" ;;
  esac
done

if [ ! -d "$TARGET" ]; then
  echo "错误：目标不存在：$TARGET" >&2
  exit 1
fi

TARGET_ROOT="$(cd "$TARGET" && pwd)"
if [ "$TARGET_ROOT" = "$SRC" ]; then
  echo "错误：目标就是包本身，请指定项目目录" >&2
  exit 1
fi

PKG="$TARGET_ROOT/agent-constraints"

echo ""
echo "智能体开发约束包 → $PKG"

mkdir -p "$PKG/core" "$PKG/core/stacks" "$PKG/templates"

# 1. 流程文档与模板：总是更新
cp -f "$SRC/core/DISTILL.md" "$PKG/core/"
cp -f "$SRC/core/PRUNE.md"   "$PKG/core/"
cp -f "$SRC/core/MERGE.md"   "$PKG/core/"
# 技术栈坑位库（按语言分组：python / javascript / shell / git / platform）
cp -f "$SRC/core/stacks/"*   "$PKG/core/stacks/"
cp -f "$SRC"/templates/*     "$PKG/templates/"
cp -f "$SRC/README.md"        "$PKG/"
cp -f "$SRC/README.zh-CN.md"  "$PKG/"
cp -f "$SRC/CONTRIBUTING.md" "$PKG/"
cp -f "$SRC/PRIVACY.md"      "$PKG/"
cp -f "$SRC/CHANGELOG.md"    "$PKG/"
cp -f "$SRC/VERSION"         "$PKG/"

# 脱敏检查（防止把自身安全信息推上去）
cp -f "$SRC/.sanitize-deny.txt" "$PKG/"
mkdir -p "$PKG/scripts"
cp -f "$SRC/scripts/"* "$PKG/scripts/"

# CLI 与包元数据 —— 让安装后的项目也能用 agent-constraints check/hooks/...
# （实测踩过：漏拷这两样，装完只剩 scripts/ 下的原始脚本）
if [ -d "$SRC/bin" ]; then
  mkdir -p "$PKG/bin"
  cp -f "$SRC/bin/"* "$PKG/bin/"
fi
[ -f "$SRC/package.json" ] && cp -f "$SRC/package.json" "$PKG/"

# ⚠️ git hooks 必须放在**目标项目根**（git 只认仓库根的 .githooks）
if [ -d "$SRC/.githooks" ]; then
  mkdir -p "$TARGET_ROOT/.githooks"
  cp -f "$SRC/.githooks/"* "$TARGET_ROOT/.githooks/"
fi
echo "  ✓ 流程文档与模板已更新"

# 2. 规则库：默认不覆盖
if [ -f "$PKG/core/constraints.md" ] && [ "$FORCE" -eq 0 ]; then
  echo "  ⚠ 已存在 core/constraints.md —— 保留你积累的规则不动"
  echo "    （如需覆盖加 --force，覆盖前请先备份）"
else
  cp -f "$SRC/core/constraints.md" "$PKG/core/"
  echo "  ✓ 规则库已安装"
fi

# 3. 注入 AGENTS.md 引用（幂等）
if [ "$SKIP_AGENTS" -eq 0 ]; then
  BEGIN="<!-- agent-constraints:begin -->"
  END="<!-- agent-constraints:end -->"

  AGENTS=""
  for name in AGENTS.md CLAUDE.md GEMINI.md .cursorrules; do
    if [ -f "$TARGET_ROOT/$name" ]; then AGENTS="$TARGET_ROOT/$name"; break; fi
  done
  [ -z "$AGENTS" ] && AGENTS="$TARGET_ROOT/AGENTS.md"

  BLOCK="$BEGIN
## 开发约束（必读）

本项目所有开发约束见 \`agent-constraints/core/constraints.md\`。
动手前先读它；每完成一个功能或修完一个 bug，按 \`agent-constraints/core/DISTILL.md\` 提炼新规则。
$END"

  if [ -f "$AGENTS" ] && grep -qF "$BEGIN" "$AGENTS"; then
    # 已注入：替换旧块，保证引用是最新的
    # 用 awk 做块替换，避免 sed 跨平台差异
    awk -v begin="$BEGIN" -v end="$END" -v block="$BLOCK" '
      index($0, begin) { print block; skip=1; next }
      index($0, end)   { skip=0; next }
      !skip            { print }
    ' "$AGENTS" > "$AGENTS.tmp" && mv "$AGENTS.tmp" "$AGENTS"
    echo "  ✓ $(basename "$AGENTS") 中的引用已刷新"
  else
    # 首次注入（文件不存在则创建）
    [ -f "$AGENTS" ] || : > "$AGENTS"
    printf '\n%s\n' "$BLOCK" >> "$AGENTS"
    echo "  ✓ 已向 $(basename "$AGENTS") 注入引用"
  fi
fi

echo ""
echo "完成。下一步："
echo "  1. 打开 core/constraints.md —— 删掉不适用的 L0 / L1 条目"
echo "     （重点看「快速定位 · 按症状查」表，那是出问题时的入口）"
echo "  2. 打开 core/stacks/ —— 技术栈坑位库，整组替换成你自己的栈"
echo "     （python / javascript / shell / git / platform）"
echo "  3. 每完成一个功能/修完一个 bug，跑一次 core/DISTILL.md 的流程"
echo "  4. L0 超过 15 条时，跑一次 core/PRUNE.md"
echo "  5. 想把你的规则贡献回主库：跑 contribute.sh，再按 CONTRIBUTING.md 提交"
echo "  6. 启用脱敏检查（每次提交自动拦截敏感信息）：scripts/install-hooks.sh"
echo ""
