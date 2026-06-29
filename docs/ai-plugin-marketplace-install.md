# TinyAI AI 插件 Git 安装方式

这份文档给同事用。目标是：同事只拿到 Git 地址，然后把安装要求发给 Claude Code 或 Codex，让它们自己安装对应插件。

Git 地址：

```text
git@github.com:lyl170614239-dotcom/tinyai.git
```

## 推荐给同事的话术

### 安装 Claude Code 插件

把下面这句话发给 Claude Code：

```text
请从这个 Git 仓库安装 TinyAI observability 插件：git@github.com:lyl170614239-dotcom/tinyai.git。安装到 user scope，安装完成后检查插件状态是否 enabled。
```

更稳的完整话术：

```text
请从这个 Git 仓库安装 TinyAI observability 插件：
git@github.com:lyl170614239-dotcom/tinyai.git

我的姓名是张三，邮箱是 zhangsan@example.com。

这是 Claude Code 插件，插件名是 observability@tinyai，安装到 user scope。
请优先用 Claude plugin marketplace 安装；如果支持 sparse，就只拉 .claude-plugin 和 plugins/claude-code。
安装完成后运行 claude plugin list，确认 observability@tinyai enabled。

然后必须配置身份，不要直接结束：
1. 如果我在这条消息里已经写了姓名/邮箱，直接写入 ~/.tinyai-observability/tinyai-observability.env，不要再反复问。
2. 如果我没写姓名/邮箱，或者你无法判断，再询问我。
3. 字段必须使用 Claude 专属前缀：
   TINYAI_OBS_CLAUDE_USER_NAME
   TINYAI_OBS_CLAUDE_USER_DISPLAY_NAME
   TINYAI_OBS_CLAUDE_USERNAME
   TINYAI_OBS_CLAUDE_USER_EMAIL
   TINYAI_OBS_CLAUDE_USER_ID
4. 最后提示我重启 Claude Code 或重新打开 VS Code Claude Code 面板。
```

Claude Code 应该执行的实际命令是：

```bash
claude plugin marketplace add git@github.com:lyl170614239-dotcom/tinyai.git --scope user --sparse .claude-plugin plugins/claude-code
claude plugin install observability@tinyai --scope user
claude plugin list
```

如果当前 Claude Code 版本不支持 `--sparse`，去掉 `--sparse .claude-plugin plugins/claude-code` 再执行。

### 安装 Codex 插件

把下面这句话发给 Codex：

```text
请从这个 Git 仓库安装 TinyAI observability 插件：git@github.com:lyl170614239-dotcom/tinyai.git。安装完成后检查 observability@tinyai 是否 enabled。
```

更稳的完整话术：

```text
请从这个 Git 仓库安装 TinyAI observability 插件：
git@github.com:lyl170614239-dotcom/tinyai.git

我的姓名是张三，邮箱是 zhangsan@example.com。

这是 Codex 插件，插件名是 observability@tinyai。
请优先用 Codex plugin marketplace 安装；如果支持 sparse，就只拉 .agents/plugins。
安装完成后运行 codex plugin list，确认 observability@tinyai enabled。

然后必须配置身份，不要直接结束：
1. 如果我在这条消息里已经写了姓名/邮箱，直接写入 ~/.tinyai-observability/tinyai-observability.env，不要再反复问。
2. 如果我没写姓名/邮箱，或者你无法判断，再读取 git config --global user.name 和 git config --global user.email，并询问我是否使用检测到的姓名/邮箱。
3. 把确认后的身份写入 ~/.tinyai-observability/tinyai-observability.env，字段必须使用 Codex 专属前缀：
   TINYAI_OBS_CODEX_USER_NAME
   TINYAI_OBS_CODEX_USER_DISPLAY_NAME
   TINYAI_OBS_CODEX_USERNAME
   TINYAI_OBS_CODEX_USER_EMAIL
   TINYAI_OBS_CODEX_USER_ID
4. 最后提示我重启 Codex 或打开新会话。
```

Codex 应该执行的实际命令是：

```bash
codex plugin marketplace add git@github.com:lyl170614239-dotcom/tinyai.git --ref main --sparse .agents/plugins
codex plugin add observability@tinyai
codex plugin list
```

如果当前 Codex 版本不支持 `--sparse`，去掉 `--sparse .agents/plugins` 再执行。

也就是说，同事不需要 clone 项目，不需要手动复制插件目录。Claude/Codex 会把这个 Git 仓库当成 plugin marketplace，然后安装里面的 `observability@tinyai`。

## Claude Code

```bash
claude plugin marketplace add git@github.com:lyl170614239-dotcom/tinyai.git --scope user
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
codex plugin marketplace add git@github.com:lyl170614239-dotcom/tinyai.git --ref main
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
- 插件安装后，Claude/Codex 会加载插件内的 `install-tinyai-observability` skill；之后用户说“更新 TinyAI 插件 / 检查 TinyAI 插件”时，AI 可以按 skill 自动执行更新和验证。
- 首次安装前，AI 还不能读取插件里的 skill，所以首次安装必须靠上面的 Git 地址话术或命令引导。
- 插件采集地址仍由 `~/.tinyai-observability/tinyai-observability.env` 和插件默认配置控制。
- 如果仓库是私有仓库，同事需要先有 GitHub SSH 权限。
