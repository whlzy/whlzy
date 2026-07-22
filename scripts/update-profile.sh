#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/nvm/versions/node/v23.9.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

cd "$(dirname "$0")/.."

retry_command() {
  local max_attempts="$1"
  shift

  local attempt=1
  local delay=10
  until "$@"; do
    if (( attempt >= max_attempts )); then
      echo "Command failed after ${attempt} attempts: $*" >&2
      return 1
    fi

    echo "Command failed (attempt ${attempt}/${max_attempts}); retrying in ${delay}s: $*" >&2
    sleep "${delay}"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
    if (( delay > 60 )); then
      delay=60
    fi
  done
}

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  retry_command 4 git pull --rebase --autostash
fi

npm run generate

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add README.md data/token-usage.json assets/token-usage.svg
  if ! git diff --cached --quiet; then
    git commit -m "Update token usage panel"
    if ! retry_command 4 git push; then
      echo "Push retries exhausted; refreshing the branch before one final push sequence." >&2
      retry_command 4 git pull --rebase --autostash
      retry_command 4 git push
    fi
  fi
fi
