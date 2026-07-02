# Install TinyAI Observability For Codex

Use this document when the user asks to install the TinyAI observability Codex
plugin from:

```text
https://github.com/lyl170614239-dotcom/tinyai.git
```

The target branch is:

```text
codex/plugin-marketplace
```

Install only the Codex plugin. Do not install the Claude Code plugin or the VS
Code/Copilot extension unless the user explicitly asks for them too.

## Plugin Identity

- Marketplace name: `tinyai`
- Plugin name: `observability`
- Install name: `observability@tinyai`
- Current version: `0.1.9+codex.20260702115159`
- Plugin path in this branch: `plugins/codex/plugins/observability`
- Root marketplace manifest: `.agents/plugins/marketplace.json`

## Preferred Install Flow

Codex supports Git refs and sparse marketplace checkout. Use the marketplace
manifest and the Codex plugin path only:

```bash
codex plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git \
  --ref codex/plugin-marketplace \
  --sparse .agents/plugins \
  --sparse plugins/codex/plugins/observability

codex plugin add observability@tinyai
codex plugin list
```

If the installed Codex CLI does not support `--sparse`, retry without sparse:

```bash
codex plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git \
  --ref codex/plugin-marketplace

codex plugin add observability@tinyai
codex plugin list
```

## Identity Config

After installation, write the user's confirmed identity to:

```text
~/.tinyai-observability/tinyai-observability.env
```

Preserve unrelated values. Replace generic user keys and Codex-specific keys:

```env
TINYAI_OBS_USER_NAME=<name>
TINYAI_OBS_USER_DISPLAY_NAME=<name>
TINYAI_OBS_USERNAME=<name>
TINYAI_OBS_USER_EMAIL=<email-if-known>
TINYAI_OBS_USER_ID=<email-or-name>
TINYAI_OBS_CODEX_USER_NAME=<name>
TINYAI_OBS_CODEX_USER_DISPLAY_NAME=<name>
TINYAI_OBS_CODEX_USERNAME=<name>
TINYAI_OBS_CODEX_USER_EMAIL=<email-if-known>
TINYAI_OBS_CODEX_USER_ID=<email-or-name>
```

If the user only provides a name, omit the email keys and use the name as
`TINYAI_OBS_USER_ID` and `TINYAI_OBS_CODEX_USER_ID`.

## Verify

Before claiming success:

1. `codex plugin list` shows `observability@tinyai` installed and enabled.
2. The installed version is `0.1.9+codex.20260702115159`.
3. The TinyAI collector health endpoint is reachable.
4. A `plugin_heartbeat` smoke event with `tool=codex` is accepted.

The smoke event proves collector connectivity. Real Codex conversation capture
starts after a fresh Codex session loads the MCP server and uploads a heartbeat
whose payload contains `mcp=true`.

After verification, tell the user to restart Codex or open a new Codex session.

## Legacy MCP Repair

If `codex plugin list` says the plugin is enabled but no Codex data is uploaded,
check `~/.codex/config.toml` for an old hard-coded TinyAI MCP runtime path. It
must point to the latest installed cache under:

```text
~/.codex/plugins/cache/tinyai/observability/<version>/runtime/dist/mcp-server.js
```
