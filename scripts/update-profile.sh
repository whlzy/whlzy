#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm run generate

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add README.md data/token-usage.json assets/token-usage.svg
  if ! git diff --cached --quiet; then
    git commit -m "Update token usage panel"
    git push
  fi
fi
