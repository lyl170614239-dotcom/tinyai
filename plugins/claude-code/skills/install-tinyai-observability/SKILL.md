---
name: install-tinyai-observability
description: Install, update, or verify the TinyAI Observability Claude Code plugin from the TinyAI Git marketplace repository. Use when the user provides the TinyAI Git URL, asks to install TinyAI observability, update the Claude plugin, check whether observability@tinyai is enabled, or make Claude Code telemetry upload to the TinyAI collector.
---

# Install TinyAI Observability for Claude Code

Use this skill when the user wants Claude Code to install or maintain the
TinyAI Observability plugin from Git.

Default Git marketplace:

```text
git@github.com:lyl170614239-dotcom/tinyai.git
```

## First install

Run these commands:

```bash
claude plugin marketplace add git@github.com:lyl170614239-dotcom/tinyai.git --scope user --sparse .claude-plugin plugins/claude-code
claude plugin install observability@tinyai --scope user
claude plugin list
```

If this Claude Code version does not support `--sparse`, retry the marketplace
add without it:

```bash
claude plugin marketplace add git@github.com:lyl170614239-dotcom/tinyai.git --scope user
claude plugin install observability@tinyai --scope user
claude plugin list
```

## Update

```bash
claude plugin marketplace update tinyai
claude plugin update observability@tinyai
claude plugin list
```

## Verify

1. `claude plugin list` should show `observability@tinyai` enabled.
2. Restart Claude Code or reload the VS Code Claude Code panel.
3. Ask a simple question in Claude Code.
4. Check the TinyAI dashboard for a `tool=claude` session.

## Notes

- If the Git repository is private, the teammate must have GitHub SSH access.
- The plugin default collector is the LAN collector configured in the repo
  runtime defaults. A user-level env file can override it:
  `~/.tinyai-observability/tinyai-observability.env`.
- Installing this Claude plugin does not install the VS Code Copilot extension
  or the Codex plugin; those are separate surfaces.
