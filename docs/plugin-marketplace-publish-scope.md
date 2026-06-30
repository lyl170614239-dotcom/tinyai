# TinyAI Plugin Marketplace Publish Scope

This repository is a development monorepo. The Claude Code and Codex plugin
install flows should not require teammates to clone or download the full
collector, dashboard, tests, or runtime source tree.

## Required Publish Paths

Only these paths are required for marketplace installation:

```text
.agents/plugins/marketplace.json
.claude-plugin/marketplace.json
plugins/codex/plugins/observability/
plugins/claude-code/
```

The plugin packages already include bundled `runtime/dist` files, so teammates
do not need `plugin-runtime/` source files to install or run the plugins.

## Sparse Install Commands

Claude Code:

```bash
claude plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git --scope user --sparse .claude-plugin plugins/claude-code
claude plugin install observability@tinyai --scope user
```

Codex:

```bash
codex plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git --ref main --sparse .agents/plugins --sparse plugins/codex/plugins/observability
codex plugin add observability@tinyai
```

## Repository Strategy

Do not delete collector, dashboard, tests, or source code from this monorepo
just to publish plugins. That would break development and observability service
maintenance.

If the Git repository itself must contain only plugin artifacts, create a
separate plugin marketplace repository with only the required publish paths
above and make it the URL used in teammate install prompts.
