#!/bin/sh
#
# 从 git 历史生成分类发布说明。
#
# 按 Conventional Commit 的类型分组；不遵循约定的提交会落到「未分类」，
# 不会有任何提交被静默丢弃。类型前缀必须用英文（`feat` / `fix` / `chore` …），
# 描述用中文（见 AGENTS.md 的提交信息约定）。
#
# 用法：scripts/changelog.sh [--from <ref>] [--to <ref>]

set -eu

FROM=""
TO="HEAD"
SEP=$(printf '\037')

usage() {
  cat <<'EOF'
用法：scripts/changelog.sh [--from <ref>] [--to <ref>]

  --from <ref>  区间下界（不含）。默认：全部历史。
  --to <ref>    区间上界（含）。默认：HEAD。
  -h, --help    显示本帮助。

把分类好的 Markdown 发布说明输出到 stdout（`make changelog` 会把它们追加到 CHANGELOG.md）。
在仓库任意目录执行都可以。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --from)
      [ $# -ge 2 ] || { echo "错误：--from 需要一个值" >&2; exit 2; }
      FROM="$2"; shift 2 ;;
    --from=*)
      FROM="${1#--from=}"; shift ;;
    --to)
      [ $# -ge 2 ] || { echo "错误：--to 需要一个值" >&2; exit 2; }
      TO="$2"; shift 2 ;;
    --to=*)
      TO="${1#--to=}"; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "错误：未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! repo_root=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "错误：当前不在 git 仓库中" >&2
  exit 1
fi
cd "$repo_root"

if ! git rev-parse --verify --quiet "${TO}^{commit}" >/dev/null; then
  echo "错误：找不到 --to 指定的 ref：$TO" >&2
  exit 1
fi
if [ -n "$FROM" ] && ! git rev-parse --verify --quiet "${FROM}^{commit}" >/dev/null; then
  echo "错误：找不到 --from 指定的 ref：$FROM" >&2
  exit 1
fi

if [ -n "$FROM" ]; then
  range="$FROM..$TO"
else
  range="$TO"
fi

log=$(git log --pretty=format:"%h${SEP}%s" "$range")
breaking=$(git log --pretty=format:'%h' --grep='BREAKING CHANGE' --grep='BREAKING-CHANGE' "$range")

feat=""
fix=""
perf=""
refactor=""
docs=""
test=""
misc=""
breaking_notes=""
other=""

while IFS="$SEP" read -r sha subject; do
  [ -n "$sha" ] || continue

  is_breaking=0
  case "$subject" in
    "BREAKING CHANGE"*|"BREAKING-CHANGE"*) is_breaking=1 ;;
  esac
  for sha_breaking in $breaking; do
    if [ "$sha_breaking" = "$sha" ]; then
      is_breaking=1
    fi
  done

  type=""
  case "$subject" in
    *": "*)
      prefix="${subject%%: *}"
      case "$prefix" in
        *"!"*) is_breaking=1 ;;
      esac
      type="${prefix%%(*}"
      type="${type%!}"
      ;;
  esac

  line="- ${subject} (\`${sha}\`)
"

  if [ "$is_breaking" -eq 1 ]; then
    breaking_notes="${breaking_notes}${line}"
  else
    case "$type" in
      feat) feat="${feat}${line}" ;;
      fix) fix="${fix}${line}" ;;
      perf) perf="${perf}${line}" ;;
      refactor) refactor="${refactor}${line}" ;;
      docs) docs="${docs}${line}" ;;
      test) test="${test}${line}" ;;
      chore|build|ci|style) misc="${misc}${line}" ;;
      *) other="${other}${line}" ;;
    esac
  fi
done <<EOF
$log
EOF

emit() {
  [ -n "$2" ] || return 0
  printf '## %s\n\n%s\n' "$1" "$2"
}

emit "不兼容变更" "$breaking_notes"
emit "新功能" "$feat"
emit "修复" "$fix"
emit "性能" "$perf"
emit "重构" "$refactor"
emit "文档" "$docs"
emit "测试" "$test"
emit "杂项" "$misc"
emit "未分类" "$other"
