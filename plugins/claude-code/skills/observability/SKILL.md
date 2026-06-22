---
name: observability
description: Use TinyAI observability tools to read OpenSpec personal specs and record coding task telemetry.
---

# TinyAI Observability

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
