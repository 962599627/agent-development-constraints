#!/usr/bin/env bash
#
# 从项目里提取你新增的开发约束，生成可提交的贡献包。
#
# 原理：安装时会把当时主库的规则 ID 列表存进 agent-constraints/.baseline。
# 本脚本对比「当前规则库」与「基线」，找出**你新增的规则**并导出。
#
# 用法：
#   ./contribute.sh                 # 扫描当前目录
#   ./contribute.sh /path/to/proj   # 扫描指定项目
#   ./contribute.sh --all           # 忽略基线，导出全部规则

set -euo pipefail

PROJECT="."
ALL=0
for arg in "$@"; do
  case "$arg" in
    --all)   ALL=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *)       PROJECT="$arg" ;;
  esac
done

[ -d "$PROJECT" ] || { echo "错误：项目不存在：$PROJECT" >&2; exit 1; }
PROJECT="$(cd "$PROJECT" && pwd)"

PKG="$PROJECT/agent-constraints"
CONSTRAINTS="$PKG/core/constraints.md"
[ -f "$CONSTRAINTS" ] || { echo "错误：没找到 $CONSTRAINTS —— 该规则库未安装到这个项目" >&2; exit 1; }

OUT="$PROJECT/contribution-$(date +%Y%m%d).md"

echo ""
echo "扫描规则库…"

# 1. 当前所有规则 ID（格式：### R-001 标题）
CURRENT_IDS="$(grep -oE '^### [A-Z]-[0-9]+' "$CONSTRAINTS" | awk '{print $2}' || true)"
COUNT_ALL="$(printf '%s\n' "$CURRENT_IDS" | grep -c . || true)"

if [ "$COUNT_ALL" -eq 0 ]; then
  echo "  规则库里没找到规则（格式应为 '### R-001 标题'）"
  exit 0
fi

# 2. 基线
BASELINE_FILE="$PKG/.baseline"
BASELINE_IDS=""
HAS_BASELINE=0

if [ -f "$BASELINE_FILE" ] && [ "$ALL" -eq 0 ]; then
  HAS_BASELINE=1
  BASELINE_IDS="$(grep -oE '^[A-Z]-[0-9]+' "$BASELINE_FILE" || true)"
fi

BASELINE_COUNT="$(printf '%s\n' "$BASELINE_IDS" | grep -c . || true)"

# 3. 找新增
if [ "$ALL" -eq 1 ] || [ "$HAS_BASELINE" -eq 0 ]; then
  NEW_IDS="$CURRENT_IDS"
  MODE="全部规则（无基线或指定了 --all）"
else
  NEW_IDS="$(comm -23 <(printf '%s\n' "$CURRENT_IDS" | sort -u) <(printf '%s\n' "$BASELINE_IDS" | sort -u) || true)"
  MODE="新增规则（对比安装时的基线）"
fi

NEW_COUNT="$(printf '%s\n' "$NEW_IDS" | grep -c . || true)"

echo "  规则总数：$COUNT_ALL，基线：$BASELINE_COUNT"
echo "  本次导出：$NEW_COUNT 条 —— $MODE"

if [ "$NEW_COUNT" -eq 0 ]; then
  echo ""
  echo "没有发现新增规则。"
  echo "  若你确实加了规则，请确认格式是 '### R-0XX 标题'；或用 --all 导出全部。"
  exit 0
fi

# 4. 生成贡献包（用 awk 抽出每条规则的完整正文）
VERSION="unknown"
[ -f "$PKG/VERSION" ] && VERSION="$(tr -d '[:space:]' < "$PKG/VERSION")"

{
  echo "# 开发约束贡献包"
  echo ""
  echo "- 生成时间：$(date '+%Y-%m-%d %H:%M')"
  echo "- 来源项目：$(basename "$PROJECT")"
  echo "- 基于约束包版本：$VERSION"
  echo "- 导出模式：$MODE"
  echo "- 规则数：$NEW_COUNT"
  echo ""
  echo "> 提交方式见仓库的 CONTRIBUTING.md。维护者合并时会把同一「违反场景」的规则合并，"
  echo "> 并让你的来源计入该规则的**独立发现次数**（≥3 次会升级为铁律）。"
  echo ""
  echo "---"
  echo ""

  # 把要导出的 ID 传给 awk，逐条抽取正文
  printf '%s\n' "$NEW_IDS" | grep . > /tmp/_contrib_ids.$$
  awk -v idfile="/tmp/_contrib_ids.$$" '
    BEGIN {
      while ((getline line < idfile) > 0) { if (line != "") want[line] = 1 }
      printing = 0
    }
    /^### [A-Z]-[0-9]+ / {
      match($0, /^### ([A-Z]-[0-9]+)/, m)
      printing = (m[1] in want) ? 1 : 0
    }
    printing { print }
    printing && /^---$/ { print ""; printing = 0 }
  ' "$CONSTRAINTS"
  rm -f /tmp/_contrib_ids.$$
} > "$OUT"

echo ""
echo "已生成：$OUT"
echo ""
echo "下一步："
echo "  1. 检查这份文件，删掉不想公开的项目细节（项目名可匿名成「某电商后台」）"
echo "  2. 确认每条规则四要素齐全（规则/触发/检查/证据）"
echo "  3. 提交到 https://github.com/962599627/agent-development-constraints"
echo ""
