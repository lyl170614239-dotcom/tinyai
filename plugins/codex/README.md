# TinyAI Codex Marketplace

This directory is a Codex marketplace root. It follows the official Codex
plugin layout while keeping the TinyAI Observability plugin versioned inside
this repository.

```text
plugins/codex/
  .agents/plugins/marketplace.json
  plugins/observability/
    .codex-plugin/plugin.json
    .mcp.json
    runtime/
    skills/
    agents/
```

## Teammate Install

Teammates normally do not need to clone this repository. They can install from
the Git marketplace entry exposed at the repository root:

```bash
codex plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git --ref main --sparse .agents/plugins
codex plugin add observability@tinyai
codex plugin list
```

After installation, restart Codex or open a new Codex thread so the MCP server
loads the installed plugin version.

## Local Development Install

From the repository root:

```bash
node scripts/install_codex_observability_plugin.mjs
codex plugin list
```

The local installer copies `plugins/codex/plugins/observability` into
`~/.codex/plugins/cache/tinyai/observability/<version>` and writes the explicit
TinyAI MCP server block in `~/.codex/config.toml`.

You can also add this directory as a local marketplace while iterating:

```bash
codex plugin marketplace add /Users/user/code/ai-observability/plugins/codex
codex plugin add observability@tinyai
```

## Maintenance Notes

- Build shared runtime changes in `plugin-runtime`, then run
  `node scripts/sync-runtimes.mjs`.
- The Codex plugin package is `plugins/codex/plugins/observability`.
- The Git marketplace entry for teammates is `.agents/plugins/marketplace.json`.
- The local marketplace entry for this directory is
  `plugins/codex/.agents/plugins/marketplace.json`.
