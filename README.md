# TinyAI Observability Plugin Marketplace

This branch is the lightweight installation source for TinyAI observability
plugins. It intentionally contains only plugin marketplace manifests and plugin
runtime bundles, not the collector server, dashboard, or development source tree.

## Included Plugins

- Claude Code: `plugins/claude-code`
- Codex: `plugins/codex/plugins/observability`
- VS Code Copilot: `plugins/vscode-copilot`

## Claude Code Install

Claude Code does not expose a `--ref` option for `claude plugin marketplace add`
in current CLI help output. To install from this branch, clone the branch first
and add the local checkout as the marketplace source:

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
```

After installation, restart Claude Code or reload the VS Code Claude Code window.

## Codex Install

Codex supports Git refs and sparse checkout for marketplace sources:

```bash
codex plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git \
  --ref codex/plugin-marketplace \
  --sparse .agents/plugins \
  --sparse plugins/codex/plugins/observability

codex plugin install observability@tinyai
```

Restart Codex or open a new Codex session after installation.

## VS Code Copilot

The VS Code Copilot extension package lives in `plugins/vscode-copilot`.
Install or package it from that directory according to its README.
