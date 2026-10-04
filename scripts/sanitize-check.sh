#!/usr/bin/env bash
#
# 脱敏检查（bash 版）—— 与 sanitize-check.ps1 功能对齐。
#
# 读 .sanitize-deny.txt 里的正则，扫描文件，命中即报错退出。
#
# 用法：
#   ./scripts/sanitize-check.sh                 # 全部已跟踪文件
#   ./scripts/sanitize-check.sh a.md b.py       # 只查指定文件（hook 用这个）
#   ALL=1 ./scripts/sanitize-check.sh           # 含未跟踪文件

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DENY="$ROOT/.sanitize-deny.txt"

[ -f "$DENY" ] || { echo "找不到 $DENY" >&2; exit 2; }

# ---------- 读黑名单 ----------
DENY_RULES=()
ALLOW_RULES=()
while IFS= read -r line || [ -n "$line" ]; do
  # 去首尾空白
  t="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -z "$t" ] && continue
  case "$t" in
    \#*) continue ;;
    !*)  ALLOW_RULES+=("${t#!}") ;;
    *)   DENY_RULES+=("$t") ;;
  esac
done < "$DENY"

[ "${#DENY_RULES[@]}" -eq 0 ] && { echo "黑名单里没有任何规则"; exit 0; }

# ---------- 收集文件 ----------
FILES=()
if [ "$#" -gt 0 ]; then
  for f in "$@"; do [ -f "$f" ] && FILES+=("$f"); done
elif [ "${ALL:-0}" = "1" ]; then
  while IFS= read -r f; do FILES+=("$f"); done < <(find "$ROOT" -type f -not -path '*/.git/*' 2>/dev/null)
else
  while IFS= read -r f; do FILES+=("$ROOT/$f"); done < <(cd "$ROOT" && git ls-files)
fi

[ "${#FILES[@]}" -eq 0 ] && { echo "没有需要检查的文件"; exit 0; }

# ---------- 扫描 ----------
FINDINGS=0
CHECKED=0
DENY_ABS="$(cd "$(dirname "$DENY")" && pwd)/$(basename "$DENY")"

for f in "${FILES[@]}"; do
  # 跳过黑名单自己；跳过二进制
  abs="$(cd "$(dirname "$f")" 2>/dev/null && pwd)/$(basename "$f")" || continue
  [ "$abs" = "$DENY_ABS" ] && continue
  case "${f,,}" in
    *.exe|*.dll|*.zip|*.gz|*.tar|*.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.pdf|*.woff|*.woff2|*.ttf|*.mp4|*.webm|*.pyc) continue ;;
  esac

  CHECKED=$((CHECKED + 1))
  rel="${f#"$ROOT"/}"

  lineno=0
  while IFS= read -r text || [ -n "$text" ]; do
    lineno=$((lineno + 1))
    for rule in "${DENY_RULES[@]}"; do
      printf '%s' "$text" | grep -qEi -- "$rule" 2>/dev/null || continue

      # 允许清单
      allowed=0
      for a in "${ALLOW_RULES[@]+"${ALLOW_RULES[@]}"}"; do
        if printf '%s' "$text" | grep -qEi -- "$a" 2>/dev/null; then allowed=1; break; fi
      done
      [ "$allowed" = "1" ] && continue

      FINDINGS=$((FINDINGS + 1))
      echo ""
      echo "  $rel"
      echo "    第 $lineno 行  ←  规则: $rule"
      echo "      $(printf '%s' "$text" | cut -c1-90)"
      break
    done
  done < "$f"
done

echo ""
if [ "$FINDINGS" -eq 0 ]; then
  echo "脱敏检查通过（$CHECKED 个文件，${#DENY_RULES[@]} 条规则）"
  exit 0
fi

echo "发现 $FINDINGS 处可能暴露自身安全的信息："
echo ""
echo "处理方式（三选一）："
echo "  1. 脱敏：把具体值改成通用描述（如 项目名 → 某项目）"
echo "  2. 若是无害示例：把它的特征加进 .sanitize-deny.txt 的允许清单（以 ! 开头）"
echo "  3. 若确实是误报：调整 .sanitize-deny.txt 里对应的正则"
echo ""
exit 1
