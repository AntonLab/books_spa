#!/usr/bin/env bash
# One call per controller step of superpowers:subagent-driven-development, run
# from the task worktree. It wraps the plugin's scripts, so the controller's
# context never carries their cache path, and it adds the guards whose absence
# cost fix-up turns before: a package built on the wrong branch, and tasks run
# without server/.env.local, which silently skips every MySQL suite.
#
#   bash scripts/sdd-step.sh review PLAN BASE [HEAD]  review package for BASE..HEAD
#   bash scripts/sdd-step.sh next PLAN N [LEDGER_LINE]  append the ledger line, write task N's brief
#   bash scripts/sdd-step.sh mark FOLLOWUPS LINE SHA [NOTE]  append " [fixed: SHA, NOTE]" to line LINE
set -euo pipefail

usage() {
  echo "usage: sdd-step.sh review PLAN BASE [HEAD] | next PLAN N [LEDGER_LINE] | mark FOLLOWUPS LINE SHA [NOTE]" >&2
  exit 2
}
[ $# -ge 3 ] || usage

scripts=$(ls -d "$HOME"/.claude/plugins/cache/claude-plugins-official/superpowers/*/skills/subagent-driven-development/scripts 2>/dev/null | sort -V | tail -1)
[ -n "$scripts" ] || { echo "superpowers plugin scripts not found" >&2; exit 2; }

branch=$(git branch --show-current)
case "$branch" in
  dev | main | '') echo "on '${branch:-detached HEAD}': run from the task worktree" >&2; exit 3 ;;
esac
[ -f server/.env.local ] || echo "WARNING: server/.env.local missing; MySQL suites will not run (npm run worktree copies it)" >&2

step=$1
plan=$2
case "$step" in
  review)
    bash "$scripts/review-package" "$plan" "$3" "${4:-HEAD}"
    ;;
  next)
    dir=$(bash "$scripts/sdd-workspace" "$plan")
    if [ $# -ge 4 ]; then
      printf '%s\n' "$4" >> "$dir/progress.md"
    fi
    # task-brief exits 3 past the last task but leaves an empty brief behind.
    status=0
    bash "$scripts/task-brief" "$plan" "$3" || status=$?
    if [ "$status" -eq 3 ]; then
      rm -f "$dir/task-$3-brief.md"
      echo "no task $3 in $plan: plan complete" >&2
    fi
    exit "$status"
    ;;
  mark)
    [ $# -ge 4 ] || usage
    file=$2 line=$3 suffix=" [fixed: $4${5:+, $5}]"
    [ -f "$file" ] || { echo "no such file: $file" >&2; exit 2; }
    case "$line" in '' | *[!0-9]* | 0) echo "LINE must be a positive integer: $line" >&2; exit 2 ;; esac
    text=$(awk -v n="$line" 'NR == n { print "x" $0; exit }' "$file")
    [ -n "$text" ] || { echo "no line $line in $file" >&2; exit 2; }
    case "$text" in
      *'[fixed:'* | *'[dropped'*) echo "line $line is already marked" >&2; exit 2 ;;
    esac
    tmp=$(mktemp)
    awk -v n="$line" -v s="$suffix" 'NR == n { $0 = $0 s } { print }' "$file" > "$tmp"
    mv "$tmp" "$file"
    ;;
  *) usage ;;
esac
