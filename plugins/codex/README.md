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
the Git marketplace entry exposed at the repository root. A teammate can ask
Codex:

```text
请从 https://github.com/lyl170614239-dotcom/tinyai.git 的 codex/plugin-marketplace 分支安装 TinyAI observability Codex 插件，我的姓名是张三。安装时请清理本地旧版本 TinyAI 配置和插件缓存，不要写入邮箱。
```

Codex should run:

```bash
codex plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git --ref codex/plugin-marketplace --sparse .agents/plugins --sparse plugins/codex/plugins/observability
codex plugin add observability@tinyai
codex plugin list
```

After installation, restart Codex or open a new Codex thread so the MCP server
loads the installed plugin version. The install smoke heartbeat only proves
collector reachability. Real Codex capture starts after a fresh session uploads
a heartbeat with `payload.mcp=true`, followed by `turn_snapshot` data after a
completed turn.

## Local Development Install

The lightweight marketplace branch does not require a local development
installer. Use the Git marketplace install command above for teammate setup. In
the main development tree, the local installer copies
`plugins/codex/plugins/observability` into
`~/.codex/plugins/cache/tinyai/observability/<version>` and writes the explicit
TinyAI MCP server block in `~/.codex/config.toml`.
It also removes older `tinyai/observability` cache versions by default so Codex
cannot accidentally start a stale MCP server. Use `--keep-old-cache` only when
you explicitly need to inspect an older install.

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
