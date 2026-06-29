---
name: install-tinyai-observability
description: Install, update, or verify the TinyAI Observability Codex plugin from the TinyAI Git marketplace repository. Use when the user provides the TinyAI Git URL, asks to install TinyAI observability in Codex, update the Codex plugin, check whether observability@tinyai is enabled, or make Codex telemetry upload to the TinyAI collector.
---

# Install TinyAI Observability for Codex

Use this skill when the user wants Codex to install or maintain the TinyAI
Observability plugin from Git.

Default Git marketplace:

```text
git@github.com:lyl170614239-dotcom/tinyai.git
```

## First install

Run these commands:

```bash
codex plugin marketplace add git@github.com:lyl170614239-dotcom/tinyai.git --ref main --sparse .agents/plugins
codex plugin add observability@tinyai
codex plugin list
```

If this Codex version does not support `--sparse`, retry the marketplace add
without it:

```bash
codex plugin marketplace add git@github.com:lyl170614239-dotcom/tinyai.git --ref main
codex plugin add observability@tinyai
codex plugin list
```

## Update

```bash
codex plugin marketplace upgrade tinyai
codex plugin add observability@tinyai
codex plugin list
```

## Verify

1. `codex plugin list` should show `observability@tinyai` enabled.
2. Restart Codex or open a new Codex session.
3. Ask a simple question in Codex.
4. Check the TinyAI dashboard for a `tool=codex` session.

## Notes

- If the Git repository is private, the teammate must have GitHub SSH access.
- The plugin default collector is the LAN collector configured in the repo
  runtime defaults. A user-level env file can override it:
  `~/.tinyai-observability/tinyai-observability.env`.
- Installing this Codex plugin does not install the VS Code Copilot extension
  or the Claude Code plugin; those are separate surfaces.
