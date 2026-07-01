# TinyAI Observability Plugin Marketplace

This branch is the lightweight installation source for TinyAI observability
plugins. It intentionally contains only plugin marketplace manifests, plugin
packages, runtime bundles, and install docs. It does not contain the collector
server, dashboard, database, or development source tree.

## AI Installer Start Here

When a user asks an AI coding tool to install TinyAI observability from this Git
repository, first identify the target tool from the user's wording:

| User asks for | Install only this plugin | Read |
| --- | --- | --- |
| Claude Code, Claude plugin, Claude telemetry | `observability@tinyai` for Claude Code | `docs/install-claude.md` |
| Codex, Codex plugin, Codex telemetry | `observability@tinyai` for Codex | `docs/install-codex.md` |
| VS Code, Cursor, Copilot extension | TinyAI VS Code/Copilot extension | `docs/install-copilot.md` |

Do not install multiple plugins unless the user explicitly asks for multiple
tools. Claude and Codex both use the plugin name `observability@tinyai`, but
they are different packages and have different marketplace manifests.

If the user provides a name or email in the install request, write it into
`~/.tinyai-observability/tinyai-observability.env` using the tool-specific keys
described in the matching install doc. If the request does not include a clear
name, ask one short follow-up question before completing setup.

## One Sentence Prompts

These are the intended user-facing prompts:

```text
请从 https://github.com/lyl170614239-dotcom/tinyai.git 的 codex/plugin-marketplace 分支安装 TinyAI observability Claude Code 插件，我的姓名是张三。
```

```text
请从 https://github.com/lyl170614239-dotcom/tinyai.git 的 codex/plugin-marketplace 分支安装 TinyAI observability Codex 插件，我的姓名是张三。
```

```text
请从 https://github.com/lyl170614239-dotcom/tinyai.git 的 codex/plugin-marketplace 分支安装 TinyAI Observability VS Code/Copilot 插件，我的姓名是张三。
```

## Included Plugins

- Claude Code: `plugins/claude-code`
- Codex: `plugins/codex/plugins/observability`
- VS Code/Copilot: `plugins/vscode-copilot`

## Marketplace Manifests

- Claude Code root marketplace: `.claude-plugin/marketplace.json`
- Claude Code plugin manifest: `plugins/claude-code/.claude-plugin/plugin.json`
- Codex root marketplace: `.agents/plugins/marketplace.json`
- VS Code/Copilot extension manifest: `plugins/vscode-copilot/package.json`

## Install Docs

- Claude Code: `docs/install-claude.md`
- Codex: `docs/install-codex.md`
- VS Code/Copilot: `docs/install-copilot.md`

## Important Rules For AI Installers

- Prefer this branch: `codex/plugin-marketplace`.
- Use the manifest for the target tool only.
- Preserve unrelated values in `~/.tinyai-observability/tinyai-observability.env`.
- Configure identity before claiming install success.
- Run the matching collector smoke test before claiming collector connectivity.
- Tell the user to restart or reload the target tool after install.
- Do not edit files under this Git checkout during a teammate install.
