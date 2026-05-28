#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

timezone="${TOKEN_USAGE_TIMEZONE:-Asia/Shanghai}"
daily_time="${TOKEN_USAGE_DAILY_TIME:-09:10}"
state_dir="${TOKEN_USAGE_STATE_DIR:-${HOME}/.local/state/token-usage-profile}"
state_file="${state_dir}/last-success-date"
lock_dir="${state_dir}/daily.lock"

mkdir -p "${state_dir}"

if ! mkdir "${lock_dir}" 2>/dev/null; then
  echo "Another token usage update is already running."
  exit 0
fi
trap 'rmdir "${lock_dir}"' EXIT

today="$(TZ="${timezone}" date '+%Y-%m-%d')"
now_time="$(TZ="${timezone}" date '+%H:%M')"
last_success=""

if [[ -f "${state_file}" ]]; then
  last_success="$(tr -d '[:space:]' < "${state_file}")"
fi

if [[ "${now_time}" < "${daily_time}" ]]; then
  echo "Not due yet. Now ${now_time} ${timezone}; daily update time is ${daily_time}."
  exit 0
fi

if [[ "${last_success}" == "${today}" ]]; then
  echo "Already updated for ${today}."
  exit 0
fi

echo "Running token usage update for ${today}."
bash scripts/update-profile.sh
printf '%s\n' "${today}" > "${state_file}"
