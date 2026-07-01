# Install TinyAI Observability For Claude Code

Use this document when the user asks to install the TinyAI observability Claude
Code plugin from:

```text
https://github.com/lyl170614239-dotcom/tinyai.git
```

The target branch is:

```text
codex/plugin-marketplace
```

Install only the Claude Code plugin. Do not install the Codex plugin or the VS
Code/Copilot extension unless the user explicitly asks for them too.

## Plugin Identity

- Marketplace name: `tinyai`
- Plugin name: `observability`
- Install name: `observability@tinyai`
- Current version: `0.1.12`
- Plugin path in this branch: `plugins/claude-code`
- Root marketplace manifest: `.claude-plugin/marketplace.json`

## Preferred Install Flow

Claude Code marketplace Git support may not expose a branch option in all
versions. If the user asks for this branch, use a temporary shallow clone of the
branch, then add that local checkout as the marketplace.

```bash
rm -rf /tmp/tinyai-observability-plugins
git clone --depth 1 --branch codex/plugin-marketplace \
  https://github.com/lyl170614239-dotcom/tinyai.git \
  /tmp/tinyai-observability-plugins

claude plugin validate /tmp/tinyai-observability-plugins/.claude-plugin/marketplace.json
claude plugin validate /tmp/tinyai-observability-plugins/plugins/claude-code/.claude-plugin/plugin.json
claude plugin marketplace add /tmp/tinyai-observability-plugins
claude plugin marketplace update tinyai
claude plugin install observability@tinyai
claude plugin list
```

If `tinyai` already exists and points to an old source, refresh it:

```bash
claude plugin marketplace remove tinyai
claude plugin marketplace add /tmp/tinyai-observability-plugins
claude plugin marketplace update tinyai
claude plugin install observability@tinyai
claude plugin list
```

## Identity Config

After installation, write the user's confirmed identity to:

```text
~/.tinyai-observability/tinyai-observability.env
```

Preserve unrelated values. Replace generic user keys and Claude-specific keys:

```env
TINYAI_OBS_USER_NAME=<name>
TINYAI_OBS_USER_DISPLAY_NAME=<name>
TINYAI_OBS_USERNAME=<name>
TINYAI_OBS_USER_EMAIL=<email-if-known>
TINYAI_OBS_USER_ID=<email-or-name>
TINYAI_OBS_CLAUDE_USER_NAME=<name>
TINYAI_OBS_CLAUDE_USER_DISPLAY_NAME=<name>
TINYAI_OBS_CLAUDE_USERNAME=<name>
TINYAI_OBS_CLAUDE_USER_EMAIL=<email-if-known>
TINYAI_OBS_CLAUDE_USER_ID=<email-or-name>
```

If the user only provides a name, omit the email keys and use the name as
`TINYAI_OBS_USER_ID` and `TINYAI_OBS_CLAUDE_USER_ID`.

## Verify

Before claiming success:

1. `claude plugin validate` passes for the marketplace and plugin manifest.
2. `claude plugin list` shows `observability@tinyai` installed and enabled.
3. The installed version is `0.1.12`.
4. The TinyAI collector health endpoint is reachable.
5. A `plugin_heartbeat` smoke event with `tool=claude` is accepted.

After verification, tell the user to restart Claude Code or reload the VS Code
Claude Code window.

## Installed Cache Path

After install, Claude Code should run the plugin from a cache path like:

```text
~/.claude/plugins/cache/tinyai/observability/0.1.12/runtime/dist/mcp-server.js
```

If old development processes are running from a repository path such as
`plugins/claude-code/runtime/dist/mcp-server.js`, ask the user to restart Claude
Code so only the installed plugin cache is used.
