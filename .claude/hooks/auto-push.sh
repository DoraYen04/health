#!/usr/bin/env bash
cd "$(dirname "$0")/../.." || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
[ -z "$(git status --porcelain)" ] && exit 0
git add -A
git commit -q -m "auto: Claude update $(date '+%Y-%m-%d %H:%M:%S')"
git push -q || echo "auto-push: push failed" >&2
exit 0