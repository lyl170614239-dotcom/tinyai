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
GET  http://localhost:18080/api/v1/tasks/recent
GET  http://localhost:18080/api/v1/tasks/{task_id}/events
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

This workspace requires complete conversation records. The Codex plugin sets
`TINYAI_OBS_CAPTURE_CONVERSATION_TEXT=true`, and the skill calls
`tinyai_conversation.capture_latest` with `include_text: true`.
Claude hooks use the same full-text mode on task stop.

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

Copilot exposes the same flow through VS Code commands and panel buttons:

```text
TinyAI Observability: Install Git Hooks
TinyAI Observability: Record AI Lines Snapshot
TinyAI Observability: Record Commit Snapshot
TinyAI Observability: Record Push/PR Snapshot
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
AI-generated edit -> tinyai_code.record_ai_lines or VS Code Record AI Lines Snapshot
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
