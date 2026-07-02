---
name: observability
description: Use when a Codex task should read project OpenSpec knowledge or report task completion telemetry.
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

Use the bundled MCP tools for project knowledge access:

- `tinyai_specs.search`: search OpenSpec personal and official specs.
- `tinyai_specs.read`: read one spec page and record direct access telemetry.
- `tinyai_conversation.capture_latest`: force an immediate capture of the latest local Codex conversation snapshot. The plugin MCP process also auto-captures changed local sessions every 15 seconds.
- `tinyai_git.install_hooks`: install local post-commit and pre-push attribution hooks when the repository should automatically report AI code metrics.
- `tinyai_git.commit_snapshot`: record HEAD commit diff as AI-attributed committed code.
- `tinyai_git.push_snapshot`: record current branch diff against upstream as AI-attributed pushed/PR code.
- `tinyai_task.record_feedback`: record user corrections, regeneration, interruption, or spec misunderstanding feedback.
- `tinyai_task.adoption_snapshot`: record generated and retained line counts after review.
- `tinyai_task.mark_result`: mark completion and upload a git diff summary.

Before coding against project behavior:

1. Search specs with `tinyai_specs.search`.
2. Prefer personal workspace specs over official specs.
3. Read selected pages with `tinyai_specs.read`.
4. Let the MCP auto-capture changed Codex sessions every 15 seconds, or call `tinyai_conversation.capture_latest` with `include_text: true` when an immediate snapshot is needed.
5. If the user asks for a rewrite, correction, interruption, or identifies a spec misunderstanding, call `tinyai_task.record_feedback`.
6. When retained/generated line counts are known, call `tinyai_task.adoption_snapshot`.
7. For normal code attribution, install Git hooks once with `tinyai_git.install_hooks`; user commits are then captured automatically by post-commit.
8. For manual backfill or debugging, call `tinyai_git.commit_snapshot` after committing and `tinyai_git.push_snapshot` around push/PR handoff.
9. Call `tinyai_task.mark_result` when the task is complete.

The project owner requires full conversation capture. Upload complete user and
assistant conversation text through `tinyai_conversation.capture_latest` while
letting the runtime redact common secret patterns.
