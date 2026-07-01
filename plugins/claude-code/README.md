# TinyAI Observability for Claude Code

Native Claude Code plugin for TinyAI observability. This directory is self-contained and follows the Claude Code plugin layout:

```text
.claude-plugin/plugin.json        Claude plugin manifest
.claude-plugin/marketplace.json   Local marketplace manifest for this plugin
.mcp.json                         MCP server definition
hooks/hooks.json                  Claude hook definitions
runtime/dist/                     Bundled runtime used by hooks and MCP
runtime/package.json              Runtime module metadata
skills/                           Claude skills bundled with the plugin
scripts/install.mjs               One-command local installer
```

## What It Captures

- Claude Code turn snapshots from `~/.claude/projects/**/*.jsonl`
- Session start and Stop/StopFailure events
- Bash PreToolUse/PostToolUse deltas with turn attribution
- MCP tools for specs reads, task feedback, git snapshots, and adoption data

## Install

### From Claude Code With A Git URL

This repository exposes a Claude marketplace manifest at the repository root.
A teammate can ask Claude Code to install the plugin from the Git URL and the
plugin marketplace branch:

```text
请从 https://github.com/lyl170614239-dotcom/tinyai.git 的 codex/plugin-marketplace 分支安装 TinyAI observability Claude Code 插件，我的姓名是张三。
```

Claude Code should follow the root `README.md` and `docs/install-claude.md`.
For Claude Code versions that cannot add a Git marketplace branch directly,
clone the branch first and add that local checkout as the marketplace:

```bash
rm -rf /tmp/tinyai-observability-plugins
git clone --depth 1 --branch codex/plugin-marketplace \
  https://github.com/lyl170614239-dotcom/tinyai.git \
  /tmp/tinyai-observability-plugins

claude plugin marketplace add /tmp/tinyai-observability-plugins
claude plugin marketplace update tinyai
claude plugin install observability@tinyai
```

If the teammate already has an old `tinyai` marketplace source, remove and add
it again before installing:

```bash
claude plugin marketplace remove tinyai
claude plugin marketplace add /tmp/tinyai-observability-plugins
claude plugin marketplace update tinyai
claude plugin install observability@tinyai
```

This Git URL flow depends on the root `.claude-plugin/marketplace.json`, which
points `observability` to `./plugins/claude-code`.

### From A Local Checkout

From the repository root:

```bash
node plugins/claude-code/scripts/install.mjs
```

Or from this plugin directory:

```bash
node scripts/install.mjs
```

The installer validates the plugin, registers this directory as the `tinyai` marketplace, updates that marketplace, and installs `observability@tinyai`.

After installation, restart Claude Code or reload the VS Code window that hosts Claude Code.

## Required Runtime Config

The plugin reads TinyAI settings from environment variables or from:

```text
~/.tinyai-observability/tinyai-observability.env
```

Recommended local config:

```bash
mkdir -p ~/.tinyai-observability
cat > ~/.tinyai-observability/tinyai-observability.env <<'EOF'
TINYAI_OBS_COLLECTOR_URL=http://localhost:18080
TINYAI_OBS_COLLECTOR_URLS=http://localhost:18080
TINYAI_OBS_USER_NAME=your-name
TINYAI_OBS_USER_EMAIL=your-email@example.com
TINYAI_OBS_CAPTURE_CONVERSATION_TEXT=true
EOF
```

Do not put model provider API tokens in this plugin directory.

## Verify

```bash
claude plugin validate plugins/claude-code/.claude-plugin/plugin.json
claude plugin validate plugins/claude-code/.claude-plugin/marketplace.json
claude plugin marketplace list
```

When Claude Code starts the MCP server, it should use the installed cache path:

```text
~/.claude/plugins/cache/tinyai/observability/0.1.12/runtime/dist/mcp-server.js
```

Check for stale development processes:

```bash
ps aux | grep 'plugins/claude-code/runtime/dist/mcp-server.js' | grep -v grep
```

If that command prints old repo-path processes, quit Claude Code and restart it. For local development only, killing stale repo-path MCP processes is safe.

## Development

Build and sync runtime before packaging or installing:

```bash
npm run build:runtime
npm run sync:runtimes
```

Package this plugin:

```bash
cd plugins/claude-code
npm pack
```

## Files That Must Stay In This Directory

- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `.mcp.json`
- `hooks/hooks.json`
- `runtime/dist/hook.js`
- `runtime/dist/mcp-server.js`
- `skills/`
- `scripts/install.mjs`

The plugin should not require a hard-coded path under `/Users/.../code/...` after installation.
