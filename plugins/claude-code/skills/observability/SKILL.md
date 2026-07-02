---
name: observability
description: Use TinyAI observability tools to read OpenSpec personal specs and record coding task telemetry.
---

# TinyAI Observability

User identity must be configured once per teammate so all sessions group under
one person in the collector:

```bash
export TINYAI_OBS_USER_NAME="张三"
export TINYAI_OBS_TEAM="hotel"                      # optional
```

Every event uploaded by the MCP server and hooks includes this identity. If
`TINYAI_OBS_USER_NAME` is missing, the runtime falls back to the OS username,
which can merge unrelated teammates as `user` or `unknown`.

When a task depends on project behavior, prefer the MCP tools from this plugin:

- `tinyai_specs.search` to locate relevant OpenSpec pages.
- `tinyai_specs.read` to read a selected personal spec, official spec, or catalog.
- `tinyai_conversation.capture_latest` to capture the latest local Claude conversation snapshot when available.
- `tinyai_git.install_hooks` to install local post-commit and pre-push attribution hooks when the repository should automatically report AI code metrics.
- `tinyai_code.record_ai_lines` after AI-generated edits and before commit to preserve line-level evidence.
- `tinyai_git.commit_snapshot` after a commit that contains AI-generated changes.
- `tinyai_git.push_snapshot` before or after pushing a branch for PR-level AI code attribution.
- `tinyai_task.record_feedback` to record corrections, regeneration, interruptions, or spec misunderstanding feedback.
- `tinyai_task.adoption_snapshot` to record generated and retained line counts when known.
- `tinyai_task.mark_result` when the task is complete.

Rules:

- Read personal specs through `tinyai_specs.search` and `tinyai_specs.read` before direct file reads.
- Use catalog results when available.
- Avoid reading `openspec/specs/official/**` when a matching personal workspace page exists.
- Capture full conversation text when the platform-specific conversation capture tool is available.
- After AI-generated code changes, call `tinyai_code.record_ai_lines` before committing so same-commit AI-vs-human line attribution can distinguish added lines.
- For code-writing tasks, record final Git boundaries: use `tinyai_git.commit_snapshot` after committing and `tinyai_git.push_snapshot` around push/PR handoff.
- If the user wants automatic Git attribution for the repository, call `tinyai_git.install_hooks` once.
- Let the runtime redact common secret patterns before upload.

## 采集统计说明

每次任务结束时，以下指标会被自动采集并上报到 collector：

| 指标 | 来源 | 说明 |
|---|---|---|
| `message_count` | conversation_snapshot | 本次对话总消息数（user + assistant） |
| `user_message_count` | conversation_snapshot | 用户消息数，等于 turn 数 |
| `assistant_message_count` | conversation_snapshot | Assistant 回复数 |
| `tool_call_count` | conversation_snapshot | 工具调用次数（Read/Edit/Bash 等） |
| `tool_result_count` | conversation_snapshot | 工具调用结果数 |
| `lines_added` / `lines_deleted` | code_change | 当前工作区 git diff 的增删行数 |
| `ai_lines_added` | ai_line_snapshot / commit_snapshot | 标记为 AI 生成的行数 |
| `output_tokens` | task_end | 本次 session 的输出 token 数（由 Stop hook 自动读取） |

**conversation_snapshot 的采集时机**：Stop hook 触发时，runtime 读取 `~/.claude/projects/**/*.jsonl` 中最新的 transcript 文件。如果用户在任务结束后立刻看到 dashboard，消息可能还在写入。可调用 `tinyai_conversation.capture_latest` 手动补采。

**消息内容为空的情况**：

- 如果 dashboard 显示 `[text not stored, N chars]`：表示该消息已被采集但 `TINYAI_OBS_CAPTURE_CONVERSATION_TEXT` 未启用。
- 如果显示 `[empty]`：表示该条 assistant 消息是纯工具调用轮次，没有文字内容，属于正常情况，不代表采集失败。

**如何确认采集是否正常**：

```bash
# 查看最近上报的事件数量
curl http://localhost:18080/api/metrics | python3 -m json.tool | grep event_count

# 查看最近的 conversation snapshot
curl "http://localhost:18080/api/sessions?tool=claude&limit=5"
```
