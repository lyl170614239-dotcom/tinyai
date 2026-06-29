# TinyAI Observability

Native plugin-first observability for AI coding tools.

This directory is intentionally independent from the main TinyAI backend and
frontend. It contains a small collector service, a shared plugin runtime, and
native plugin packages for Claude Code, Codex, and VS Code Copilot users.

## Layout

```text
collector-server/     FastAPI collector backed by MySQL
plugin-runtime/       Shared TypeScript runtime, uploader, MCP server, redactor
plugins/claude-code/  Claude Code plugin package
plugins/codex/        Codex plugin package
plugins/vscode-copilot/ VS Code extension package
dashboard-minimal/    Minimal event verification UI
```

## First Run

```bash
cp .env.example .env
docker compose up -d --build
```

Collector endpoints:

```text
POST http://localhost:18080/api/v1/events/batch
POST http://localhost:18080/api/v1/github/webhook
GET  http://localhost:18080/api/v1/plugins
GET  http://localhost:18080/api/v1/users
GET  http://localhost:18080/api/v1/sessions/recent
GET  http://localhost:18080/api/v1/sessions/{session_id}/detail
GET  http://localhost:18080/api/v1/sessions/{session_id}/raw-events
GET  http://localhost:18080/api/v1/sessions/{session_id}/normalized-events
GET  http://localhost:18080/api/v1/metrics/knowledge
GET  http://localhost:18080/api/v1/github/pr-attributions/recent
```

## Plugin Development

Build the shared runtime first:

```bash
cd plugin-runtime
npm install
npm run build
```

The Claude and Codex plugin manifests call the shared runtime MCP server:

```text
plugin-runtime/dist/mcp-server.js
```

Bundled MCP tools:

```text
tinyai_specs.search
tinyai_specs.read
tinyai_conversation.capture_latest
tinyai_git.install_hooks
tinyai_code.record_ai_lines
tinyai_git.commit_snapshot
tinyai_git.push_snapshot
tinyai_task.record_feedback
tinyai_task.adoption_snapshot
tinyai_task.mark_result
```

Tool-specific conversation capture:

```text
Codex       ~/.codex/sessions/**/*.jsonl
Claude Code ~/.claude/transcripts/*.jsonl and ~/.claude/projects/**/*.jsonl
Copilot     VS Code workspaceStorage Copilot transcript JSONL plus @tinyai/tool memory
```

The VS Code package can be built into a private `.vsix`:

```bash
cd plugins/vscode-copilot
npm install
npm run package
```

## VS Code/Copilot Teammate Configuration

After a teammate installs the VS Code extension, they only need a configured
display name. This VSIX build defaults to the shared LAN collector
`http://10.161.248.133:18080`.
`userName` is the primary
dashboard grouping key; without it, sessions may collapse into generic OS
names like `user` or `unknown`.

Recommended command from the repository root:

```bash
npm run configure:vscode -- \
  --user-name "张三"
```

Equivalent command from the VS Code plugin folder:

```bash
cd plugins/vscode-copilot
npm run configure -- \
  --user-name "张三"
```

The script writes these VS Code settings:

```json
{
  "tinyaiObservability.collectorUrl": "http://10.161.248.133:18080",
  "tinyaiObservability.token": "",
  "tinyaiObservability.userName": "张三",
  "tinyaiObservability.userId": "zhangsan",
  "tinyaiObservability.userEmail": "zhangsan@example.com",
  "tinyaiObservability.team": "hotel",
  "tinyaiObservability.captureConversationText": true,
  "tinyaiObservability.captureVisibleReasoningText": false,
  "tinyaiObservability.autoCaptureCopilotLocalTranscripts": true,
  "tinyaiObservability.autoCaptureClaudeLocalTranscripts": true,
  "tinyaiObservability.autoCaptureRecentMinutes": 30
}
```

Configuration skill:

```text
plugins/vscode-copilot/skills/configure/SKILL.md
```

If the user has an AI agent available, ask it to use
`tinyai-vscode-copilot-configure`. The skill will first inspect environment
variables and existing settings, then run the helper script. It asks for the
user name if it cannot be determined safely.

Useful variants:

```bash
# Preview without writing settings.
npm run configure:vscode -- --dry-run

# Write workspace-local settings instead of user-level settings.
npm run configure:vscode -- --scope workspace --workspace "$PWD"

# Configure VS Code Insiders.
npm run configure:vscode -- --flavor insiders --user-name "张三"

# Optional stable identity fields for larger teams.
npm run configure:vscode -- \
  --user-name "张三" \
  --user-email "zhangsan@example.com" \
  --team "hotel"
```

After configuration, reload VS Code once:

```text
Command Palette -> Developer: Reload Window
```

## Claude Code Teammate Installation

### 最简单的同事安装方式

如果同事只需要使用 Claude Code / Codex 采集，不需要 clone 项目，也不需要手动复制插件目录。直接把这个 Git 仓库作为插件 marketplace 添加即可。

Claude Code：

```bash
claude plugin marketplace add git@github.com:lyl170614239-dotcom/tinyai.git --scope user --sparse .claude-plugin plugins/claude-code
claude plugin install observability@tinyai --scope user
```

可以直接给 Claude Code 的话：

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

Codex：

```bash
codex plugin marketplace add git@github.com:lyl170614239-dotcom/tinyai.git --ref main --sparse .agents/plugins
codex plugin add observability@tinyai
```

可以直接给 Codex 的话：

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

默认会安装：

```text
Claude Code plugin -> tool=claude
Codex plugin       -> tool=codex
```

注意：首次安装前，Claude/Codex 还不能读取这个仓库里的 skill；安装完成后，插件内的
`install-tinyai-observability` skill 才会生效。之后同事说“更新 TinyAI 插件”或“检查
TinyAI 插件”，AI 就可以按 skill 自动执行更新和验证。

安装完成后，同事只需要重启 Claude Code / Codex，然后正常提问即可。dashboard 的“采集状态”里会按 `Copilot / Claude / Codex` 分别展示版本、心跳、会话、工具、代码和知识库链路。

升级：

```bash
claude plugin marketplace update tinyai
claude plugin update observability@tinyai

codex plugin marketplace upgrade tinyai
codex plugin add observability@tinyai
```

默认 collector 使用 `config/tinyai-observability.env` 里的局域网地址：

```text
http://10.161.248.133:18080
```

如果仓库是私有仓库，同事需要先有 GitHub SSH 权限。详细说明见 `docs/ai-plugin-marketplace-install.md`。

Claude has two different surfaces, and they are collected differently:

```text
GitHub Copilot Chat 中选择 Claude 模型
  -> 仍属于 GitHub Copilot Chat，会作为 tool=copilot 采集。

Claude Code 面板 / Claude Code CLI / 独立 Claude Code 终端
  -> 属于 Claude Code，会作为 tool=claude 采集。
```

To collect native Claude Code activity, install the TinyAI Claude plugin once
per developer machine:

```bash
npm run build:plugins
npm run install:claude-plugin
```

The installer copies the packaged plugin to:

```text
~/.claude/plugins/cache/tinyai/observability/<version>
```

and enables:

```text
observability@tinyai
```

in `~/.claude/settings.json`. It does not print the settings file contents, so
Claude API tokens or other secrets are not written to terminal logs. After
installation, restart Claude Code or reload VS Code so Claude loads the updated
plugin.

Useful variants:

```bash
# Preview without changing ~/.claude.
npm run install:claude-plugin -- --dry-run

# Disable the plugin entry without uninstalling files.
npm run install:claude-plugin -- --disable
```

## Conversation Capture

Codex conversation capture reads local session JSONL files under:

```text
~/.codex/sessions/YYYY/MM/DD/*.jsonl
```

Claude Code conversation capture reads local transcript JSONL files under:

```text
~/.claude/transcripts/*.jsonl
~/.claude/projects/**/*.jsonl
```

Claude is collected through two complementary paths:

- The VS Code TinyAI extension scans local Claude JSONL files globally every 15
  seconds, so Claude panels, Claude Code, and Claude CLI sessions can be
  captured even when they were opened from another project.
- The native Claude Code plugin installs `SessionStart`, `Stop`, and
  `StopFailure` hooks. These hooks upload the latest Claude `turn_snapshot` and
  add a scoped workspace-diff fallback when Claude used Bash/terminal commands
  to write files.

The intended Claude parity with Copilot is:

```text
对话与最终回答       turn_snapshot / ai_messages
可见推理与过程       ai_process_steps
工具调用             ai_process_steps + turn_snapshot.tool_calls
读取的文件           read_file / grep / list / terminal 命令解析为 process/spec access
修改的文件           Claude 工具 patch + editor delta + scoped workspace diff fallback
AI 修改代码证据      ai_code_changes，snapshot_kind=claude_turn_*
commit 后归因        commit_snapshot 与已入库 Claude/Copilot AI code evidence 匹配
```

There are two limits by design:

```text
隐藏思维链不会采集，只采本地日志中实际持久化的 visible reasoning / progress。
Bash/terminal 兜底只采本轮日志中能定位到的文件路径，避免把 unrelated git diff 误算成 AI 代码。
```

The shared LAN collector is `http://10.161.248.133:18080`. The dashboard is
`http://10.161.248.133:18081`.
Teammates should send telemetry to the collector port, not the dashboard port.
The Claude hook package defaults to this LAN collector but still honors
`TINYAI_OBS_COLLECTOR_URL` when explicitly set.

This workspace requires complete conversation records. The Codex plugin sets
`TINYAI_OBS_CAPTURE_CONVERSATION_TEXT=true`, and the skill calls
`tinyai_conversation.capture_latest` with `include_text: true`.
The Codex MCP process also checks the latest changed local session every 15
seconds, so normal collection does not depend on the model remembering to call
the skill. Claude hooks use the current hook-provided session and transcript
path in the same full-text mode on task stop.

The VS Code Copilot extension captures full text for regular Copilot Chat by
scanning local VS Code transcript files under:

```text
$HOME/Library/Application Support/Code/User/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/*.jsonl
$HOME/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/*.jsonl
```

It also captures TinyAI-owned chat surfaces: the sticky `@tinyai` chat
participant and the `tinyai_specs` Agent-mode tool. Local transcript capture is
marked `derived`; `@tinyai` and the LM tool are marked `direct`. Inline
completion attribution remains estimated from workspace file changes and later
retention snapshots, not exact per-suggestion telemetry.

Reasoning records mean visible or locally persisted reasoning summaries only.
They are stored as `reasoning` process steps and must not be interpreted as the
model's hidden internal chain-of-thought.

Raw ingest JSON is retained for 30 days by default and normalized ingest JSON
for 90 days. Product tables (`ai_sessions`, turns, messages, process steps,
code changes, and spec accesses) remain available for long-term reporting.
Product tables do not duplicate raw event JSON; raw payloads stay in the ingest
layers. Message content uses MySQL `LONGTEXT` so large pasted logs and long AI
responses do not fail at the previous 64 KB `TEXT` limit.
Override the history windows with `OBS_RAW_RETENTION_DAYS` and
`OBS_NORMALIZED_RETENTION_DAYS`.

## AI Code Attribution

The plugin layer records AI-written code at Git boundaries:

```text
commit_snapshot  post-commit / manual HEAD commit diff
push_snapshot    pre-push / manual branch-vs-upstream diff
ai_line_snapshot pre-commit / manual diff line fingerprints
```

Claude and Codex expose these through MCP:

```text
tinyai_git.install_hooks
tinyai_code.record_ai_lines
tinyai_git.commit_snapshot
tinyai_git.push_snapshot
```

Copilot exposes the day-to-day flow through VS Code commands and panel buttons:

```text
TinyAI Observability: Install Git Hooks
TinyAI Observability: Mark Current Diff as AI Lines
TinyAI Observability: Capture Recent Copilot Sessions Now
TinyAI Observability: Record Feedback
```

For team-wide PR metrics, install hooks once per repository. After that,
`git commit` uploads `commit_snapshot` and `git push` uploads `push_snapshot`
only when the repository has a recent TinyAI AI-activity marker. The marker is
written by plugin MCP/spec/chat/task tools and expires after 6 hours by default
(`TINYAI_OBS_AI_MARKER_TTL_SECONDS`). Plain human commits without a marker are
not counted as AI. Events use stable IDs based on commit SHA or push range, so
repeated hook runs do not double count the same code.

For same-commit AI-vs-human line attribution, the plugins record line evidence
before commit:

```text
AI-generated edit -> tinyai_code.record_ai_lines or VS Code Mark Current Diff as AI Lines
post-commit hook  -> parses git show and classifies added lines as AI or human
```

The stored evidence is file path + line number + line hash, not full code text.
`commit_snapshot.payload.line_attribution` lists AI and human added line numbers
per file. If no line evidence exists, added lines are treated as human.

## GitHub PR Attribution Phase 1

Phase 1 adds commit-level PR attribution. GitHub sends a `pull_request`
webhook, the collector loads the PR commit SHAs, and then intersects those SHAs
with plugin `commit_snapshot` line attribution:

```text
PR commits ∩ TinyAI commit_snapshot line_attribution
```

Configure the collector with:

```bash
OBS_GITHUB_WEBHOOK_SECRET=replace-with-webhook-secret
OBS_GITHUB_TOKEN=github-app-or-fine-grained-token
OBS_GITHUB_API_URL=https://api.github.com
```

The GitHub App or fine-grained token needs read access to Pull requests. Install
the webhook on repositories that should be measured and point it at:

```text
https://<collector-host>/api/v1/github/webhook
```

Subscribe to `Pull request` events. The collector accepts `ping`, ignores other
event types, and stores one attribution row per GitHub delivery id so webhook
redelivery does not double count. PR attribution keeps matched commit line
details, so a single mixed commit can report which added line numbers matched AI
evidence and which added line numbers remained human.

For `conversation_snapshot` events with `include_text=true`, the runtime and
collector keep the full `messages[].text` content while still redacting common
secret patterns such as API keys, tokens, passwords, and GitHub tokens. Other
event types keep conservative truncation.

## Copilot Request Usage

The VS Code extension parses Copilot `objectMutationLog` JSONL as request-level
usage. Initial requests, appended requests, and delayed result patches are
merged by request id before upload. The collector stores them in
`ai_request_usage` with the unique key `(session_id, request_id)`, so a later
Token, timing, model, or credits patch updates the same row.

Session detail exposes aggregate `usage_totals`, `models_used`, and one
`request_usage` object per turn:

```bash
curl http://localhost:18080/api/v1/sessions/<session-id>/detail
```

Only the usage fields are uploaded. Copilot attachments, rendered global
context, `.env` contents, and complete tool result bodies are not copied into
the request usage payload.

## Knowledge Metrics

The collector computes the five metric groups from raw events:

```text
知识库使用覆盖
读取规则合规
定位与命中效率
知识库和代码采纳质量
AI 代码归因
任务结果与返工
```

Use:

```bash
curl http://localhost:18080/api/v1/metrics/knowledge
```
