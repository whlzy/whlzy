# Daily Profile Update

This project is designed to run on your Mac, because GitHub-hosted Actions cannot read local `~/.codex`, `~/.codex-api`, or Claude Code log files.

## 1. Generate once

```bash
npm run generate
```

Commit `README.md`, `data/token-usage.json`, `assets/token-usage.svg`, and the `scripts/` directory to your GitHub profile repository.

## 2. Schedule with launchd

Create `~/Library/LaunchAgents/com.example.token-usage-profile.plist` and replace `/path/to/profile-repo` with your GitHub profile repository path.

This setup checks every 15 minutes and also checks when the Mac starts. The script only performs the real update when it is after 09:10 Asia/Shanghai time and today's update has not succeeded yet, so a powered-off Mac can catch up after it starts.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.token-usage-profile</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/path/to/profile-repo/scripts/update-profile-if-due.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/profile-repo</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>StandardOutPath</key>
  <string>/tmp/token-usage-profile.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/token-usage-profile.err.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.example.token-usage-profile.plist
```

Run manually any time:

```bash
bash scripts/update-profile.sh
```

Check whether today's scheduled update is due:

```bash
bash scripts/update-profile-if-due.sh
```

The catch-up script records the last successful local date in `~/.local/state/token-usage-profile/last-success-date`.

## Notes

- `codex` is collected from local Codex JSONL logs for full history.
- Codex and Claude are collected directly from local JSONL logs. CodexBar is not required.
- The normalized data keeps both `provider` and `tool`, so the profile can distinguish services from collection sources.

## Alternative: GitHub Actions with a self-hosted Mac runner

The included `.github/workflows/update-token-usage.yml` runs daily at 09:10 Asia/Shanghai time and can also be started manually from the Actions tab.

Use a self-hosted macOS runner if you want GitHub Actions to update the panel, because the workflow must run as a local user that can read your AI tool logs:

- `~/.codex/sessions`
- `~/.codex/archived_sessions`
- `~/.codex-api/sessions`
- `~/.codex-api/archived_sessions`
- `~/.claude/projects`
- `~/.config/claude/projects`

The workflow has a preflight check for local `.jsonl` logs and exits before generating or committing if the runner cannot see them. Install and run the self-hosted runner as the same macOS user that uses Codex and Claude.

If your logs live somewhere else, set repository variables in GitHub:

- `CODEX_HOME`: custom Codex home directory.
- `CLAUDE_CONFIG_DIR`: custom Claude config directory, or a comma-separated list of directories.

GitHub-hosted runners start on fresh cloud machines and cannot read those local files, so they will not produce your real usage history.
