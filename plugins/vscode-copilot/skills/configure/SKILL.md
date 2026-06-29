---
name: tinyai-vscode-copilot-configure
description: Configure the TinyAI Observability VS Code/Copilot extension after installation. Use when a user asks how to set up the VS Code Copilot plugin, collector URL, full conversation capture, visible reasoning capture, or wants automatic configuration.
---

# TinyAI VS Code/Copilot Configure

This skill configures the native VS Code extension `tinyai.tinyai-observability-copilot`.

## Goal

After the user installs the VS Code extension, automatically write the required
VS Code settings and verify collector connectivity.

Required settings:

```json
{
  "tinyaiObservability.collectorUrl": "http://10.161.248.133:18080",
  "tinyaiObservability.token": "",
  "tinyaiObservability.userName": "张三",
  "tinyaiObservability.userId": "zhangsan",
  "tinyaiObservability.userEmail": "zhangsan@example.com",
  "tinyaiObservability.team": "hotel",
  "tinyaiObservability.captureConversationText": true,
  "tinyaiObservability.captureVisibleReasoningText": false,
  "tinyaiObservability.autoCaptureCopilotLocalTranscripts": true,
  "tinyaiObservability.autoCaptureRecentMinutes": 30
}
```

## Information To Collect

Resolve these in order:

1. `collectorUrl`
   - This build defaults to `http://10.161.248.133:18080`.
   - Private LAN collectors may use HTTP for team testing; public collectors must use HTTPS and a bearer token.
   - Prefer explicit user input only when the user says the collector address changed.
   - Then environment variables:
     - `TINYAI_OBS_COLLECTOR_URL`
     - `OBS_COLLECTOR_URL`
     - `TINYAI_COLLECTOR_URL`
   - Then repository `.env` values if the current repo is `ai-observability`.
2. Settings scope
   - Default to user scope.
   - Use workspace scope only if the user asks to keep config inside the current workspace.
3. VS Code flavor
   - Default to stable VS Code.
   - Use `--flavor insiders` only if the user says they use VS Code Insiders.
4. User identity
   - Prefer explicit user input for `userName`; this is the primary dashboard grouping key.
   - Then environment variables:
     - `TINYAI_OBS_USER_NAME`
     - `TINYAI_OBS_USER_DISPLAY_NAME`
     - `TINYAI_OBS_USER_EMAIL`
     - `TINYAI_OBS_USER_ID`
     - `TINYAI_OBS_TEAM`
   - Then `git config user.name` and `git config user.email`.
   - Do not leave teammate installs without `userName`; otherwise sessions may be grouped as `user` or `unknown`.

Normally do not ask teammates for collector URL; ask only for their display
name unless they need a remote HTTPS collector.

## Automatic Configuration

Run the helper script from this plugin directory:

```bash
node plugins/vscode-copilot/scripts/configure.mjs \
  --user-name "张三"
```

Common variants:

```bash
# Dry run: show what would be written and test collector connectivity.
node plugins/vscode-copilot/scripts/configure.mjs --dry-run

# Write workspace-local .vscode/settings.json instead of user settings.
node plugins/vscode-copilot/scripts/configure.mjs --scope workspace --workspace "$PWD"

# VS Code Insiders.
node plugins/vscode-copilot/scripts/configure.mjs --flavor insiders

# Explicit identity for team reporting.
node plugins/vscode-copilot/scripts/configure.mjs \
  --user-name "张三" \
  --user-email "zhangsan@example.com" \
  --team "hotel"

# Disable full visible reasoning text while keeping counts and hashes.
node plugins/vscode-copilot/scripts/configure.mjs --capture-visible-reasoning-text false
```

The script writes:

- macOS stable:
  `~/Library/Application Support/Code/User/settings.json`
- macOS Insiders:
  `~/Library/Application Support/Code - Insiders/User/settings.json`
- Windows stable:
  `%APPDATA%\Code\User\settings.json`
- Linux stable:
  `~/.config/Code/User/settings.json`
- Workspace scope:
  `<workspace>/.vscode/settings.json`

## Verification

The script verifies configuration by:

1. Reading or creating the VS Code settings JSON.
2. Writing the TinyAI extension settings.
3. Calling `GET /api/v1/plugins`.
4. Posting a `plugin_heartbeat` event to `POST /api/v1/events/batch`.
5. Checking that the heartbeat contains `user_display_name` / `user_id`.

Success means:

```json
{
  "wroteSettings": true,
  "collectorReachable": true,
  "heartbeatAccepted": true,
  "identity": {
    "userName": "张三",
    "userId": "zhangsan"
  }
}
```

If `collectorReachable` is false, the collector URL is wrong or unreachable.
If `heartbeatAccepted` is false, the collector URL is probably wrong or the
collector is not reachable from this machine.

## After Configuration

Ask the user to reload VS Code once:

```text
Command Palette -> Developer: Reload Window
```

Then verify the collector shows plugin version `tinyai-observability-vscode`.

## Important Notes

- Full conversation text is enabled by default because the project requires it.
- Visible reasoning capture records only reasoning/process text that VS Code
  persists locally or exposes in transcript files. It is not guaranteed internal
  model chain-of-thought.
- `autoCaptureRecentMinutes = 30` means the extension scans transcript files
  modified in the last 30 minutes to avoid backfilling old Copilot history.
- Do not ask users to manually edit JSON unless the script fails.
