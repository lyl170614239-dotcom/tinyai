# TinyAI AI 插件 Git 安装方式

这份文档给同事用。目标是：同事只拿到 Git 地址，然后把安装要求发给 Claude Code 或 Codex，让它们自己安装对应插件。

Git 地址：

```text
https://github.com/lyl170614239-dotcom/tinyai.git
```

## 推荐给同事的话术

### 安装 Claude Code 插件

把下面这句话发给 Claude Code：

```text
请从这个 Git 仓库安装 TinyAI observability 插件：
https://github.com/lyl170614239-dotcom/tinyai.git

我的姓名是张三，邮箱是 zhangsan@example.com。

这是 Claude Code 插件，插件名是 observability@tinyai。
安装完成后请自动验证：
1. observability@tinyai 已启用
2. collector 可以连通
3. 成功上报一条 tool=claude 的测试心跳

如果验证失败，请直接告诉我失败原因。
验证成功后，提醒我重启 Claude Code 或重新打开 VS Code Claude Code 面板。
```

Claude Code 应该执行的实际命令是：

```bash
claude plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git --scope user --sparse .claude-plugin plugins/claude-code
claude plugin install observability@tinyai --scope user
claude plugin list
```

如果当前 Claude Code 版本不支持 `--sparse`，去掉 `--sparse .claude-plugin plugins/claude-code` 再执行。

### 安装 Codex 插件

把下面这句话发给 Codex：

```text
请从这个 Git 仓库安装 TinyAI observability 插件：
https://github.com/lyl170614239-dotcom/tinyai.git

我的姓名是张三，邮箱是 zhangsan@example.com。

这是 Codex 插件，插件名是 observability@tinyai。
安装完成后请自动验证：
1. observability@tinyai 已启用
2. collector 可以连通
3. 成功上报一条 tool=codex 的安装烟测心跳，payload 里应是 install_smoke=true、mcp=false
4. 提醒我重启 Codex 或打开新会话；重启后才可能出现真实 MCP 心跳
5. 新会话完成一轮对话后，应出现 tool=codex 的真实 MCP 心跳 payload.mcp=true 和 turn_snapshot/session 数据

如果验证失败，请直接告诉我失败原因。
验证成功后，提醒我重启 Codex 或打开新会话。
```

Codex 应该执行的实际命令是：

```bash
codex plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git --ref main --sparse .agents/plugins --sparse plugins/codex/plugins/observability
codex plugin add observability@tinyai
codex plugin list
```

仓库里的 Codex 插件按官方 marketplace 结构组织：

```text
.agents/plugins/marketplace.json          对外安装入口
plugins/codex/.agents/plugins/marketplace.json  本地 Codex marketplace 入口
plugins/codex/plugins/observability/      Codex 插件包
```

如果当前 Codex 版本不支持 `--sparse`，去掉 sparse 参数再执行，但这会临时拉取更多
monorepo 内容；能支持 sparse 时必须保留上面的两个 sparse 路径。

也就是说，同事不需要 clone 项目，不需要手动复制插件目录。Claude/Codex 会把这个 Git
仓库当成 plugin marketplace，并通过 sparse checkout 只获取插件相关路径，然后安装里面
的 `observability@tinyai`。

## Claude Code

```bash
claude plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git --scope user
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
codex plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git --ref main --sparse .agents/plugins --sparse plugins/codex/plugins/observability
codex plugin add observability@tinyai
```

安装烟测心跳只代表 collector 可连通，不代表 Codex 已经加载 MCP。安装后重启 Codex，
或开启一个新的 Codex 会话。真实采集开始的判断标准是：出现 `tool=codex` 且 payload
里 `mcp=true` 的真实 MCP 心跳，并在完成一轮对话后出现 `turn_snapshot`。

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
- 插件安装后，Claude/Codex 会加载插件内的 `install-tinyai-observability` skill；之后用户说“更新 TinyAI 插件 / 检查 TinyAI 插件”时，AI 可以按 skill 自动执行更新和验证。
- 首次安装前，AI 还不能读取插件里的 skill，所以首次安装必须靠上面的 Git 地址话术或命令引导。
- 插件采集地址仍由 `~/.tinyai-observability/tinyai-observability.env` 和插件默认配置控制。
- 如果仓库是私有仓库，同事需要先有 GitHub SSH 权限。
