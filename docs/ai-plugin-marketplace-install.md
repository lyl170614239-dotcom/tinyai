# TinyAI AI 插件 Git 安装方式

这份文档给同事用。目标是：同事只拿到 Git 地址，不需要 clone 项目，也不需要手动复制插件目录。

## Claude Code

```bash
claude plugin marketplace add git@github.com:lyl170614239-dotcom/tinyai.git --scope user --sparse .claude-plugin plugins/claude-code
claude plugin install observability@tinyai --scope user
```

安装后重启 Claude Code / VS Code Claude 面板。

后续升级：

```bash
claude plugin marketplace update tinyai
claude plugin update observability@tinyai
```

## Codex

```bash
codex plugin marketplace add git@github.com:lyl170614239-dotcom/tinyai.git --ref main --sparse .agents/plugins
codex plugin add observability@tinyai
```

安装后重启 Codex，或开启一个新的 Codex 会话。

后续升级：

```bash
codex plugin marketplace upgrade tinyai
codex plugin add observability@tinyai
```

## VS Code Copilot

VS Code Copilot 仍然是 VS Code 扩展，不走 Claude/Codex 的 plugin marketplace。它需要通过 VSIX 或 VS Code 扩展分发方式安装。

## 说明

- Claude Code 读取的是仓库里的 `.claude-plugin/marketplace.json`。
- Codex 读取的是仓库里的 `.agents/plugins/marketplace.json`。
- 插件采集地址仍由 `~/.tinyai-observability/tinyai-observability.env` 和插件默认配置控制。
- 如果仓库是私有仓库，同事需要先有 GitHub SSH 权限。
