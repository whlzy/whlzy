#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/nvm/versions/node/v23.9.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

cd "$(dirname "$0")/.."

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git pull --rebase --autostash
fi

npm run generate

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add README.md data/token-usage.json assets/token-usage.svg
  if ! git diff --cached --quiet; then
    git commit -m "Update token usage panel"
    git push || {
      git pull --rebase --autostash
      git push
    }
  fi
fi
