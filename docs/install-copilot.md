# Install TinyAI Observability For VS Code/Copilot

Use this document when the user asks to install the TinyAI Observability VS
Code/Cursor/Copilot extension from:

```text
https://github.com/lyl170614239-dotcom/tinyai.git
```

The target branch is:

```text
codex/plugin-marketplace
```

Install only the VS Code/Copilot extension. Do not install the Claude Code or
Codex plugins unless the user explicitly asks for them too.

## Extension Identity

- Extension package path: `plugins/vscode-copilot`
- Extension package name: `tinyai-observability-copilot`
- Current version: `0.1.50`

## Install Flow

This extension is not installed through Claude Code or Codex plugin marketplaces.
Use VS Code/Cursor extension packaging or install from a packaged VSIX produced
from `plugins/vscode-copilot`.

From a checkout of this branch:

```bash
cd plugins/vscode-copilot
npm install
npm run package
```

Then install the generated `.vsix` in VS Code or Cursor.

## Identity Config

Prefer VS Code/Cursor settings for user identity:

```json
{
  "tinyaiObservability.userName": "<name>",
  "tinyaiObservability.userId": "<name>"
}
```

The extension can also read generic TinyAI env keys from:

```text
~/.tinyai-observability/tinyai-observability.env
```

Use:

```env
TINYAI_OBS_USER_NAME=<name>
TINYAI_OBS_USER_DISPLAY_NAME=<name>
TINYAI_OBS_USERNAME=<name>
TINYAI_OBS_USER_ID=<name>
```

Do not collect or write email fields. If old VS Code/Cursor settings or TinyAI
env files contain email identity keys, remove those keys during setup.

## Clean Legacy Local State

Before verification, uninstall or replace older TinyAI Observability VSIX
versions and remove stale email identity settings. Keep local queue files; they
may contain retryable data and the current extension dead-letters permanent
schema failures.

## Verify

Before claiming success:

1. VS Code/Cursor shows TinyAI Observability version `0.1.50`.
2. TinyAI collector health is reachable.
3. A `plugin_heartbeat` or captured Copilot turn with `tool=copilot` is accepted.
4. The extension is configured to auto-capture Copilot local transcripts if the
   user expects Copilot chat telemetry.

After verification, tell the user to reload the VS Code/Cursor window.
