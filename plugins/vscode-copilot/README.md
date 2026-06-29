# TinyAI Observability

Private VS Code extension for collecting Copilot and Claude coding task telemetry.

## Usage

1. Install the private `.vsix`.
2. Configure identity and collector settings once:

```bash
npm run configure -- \
  --user-name "张三"
```

3. Reload VS Code.
4. Keep using Copilot Chat / Agent mode, Claude Code panels, or Claude CLI normally.
5. The extension automatically scans local VS Code Copilot `chatSessions` and `GitHub.copilot-chat/transcripts` files, plus Claude `~/.claude/projects/**/*.jsonl` and `~/.claude/transcripts/*.jsonl`. Each completed user request uploads one logical `turn_snapshot`.
6. In Agent mode, enable or allow the `tinyai_specs` tool. Copilot can then call the tool directly when the prompt needs personal specs.
7. For sticky TinyAI chat, start a Copilot Chat thread with `@tinyai`; the participant is sticky, so follow-up turns in that thread do not need `@tinyai` again.
8. Open the left-side `TinyAI` activity bar item only when you need setup or verification: `Open Dashboard`, `Configure User & Collector`, `Install Git Hooks`, or manual capture/flush actions.
9. Click `Install Git Hooks` once per repository when you want commit/push AI code attribution to run automatically.

Automatic Copilot capture emits one `turn_snapshot` per completed request.
The user question and final assistant answer come from `chatSessions`; visible
reasoning, assistant progress, tool arguments/results, and sub-agent traces
come from `GitHub.copilot-chat/transcripts` when VS Code persists them. The
extension no longer uploads automatic Copilot `agent_activity`, standalone
`file_read`, or synthetic `task_start`/`task_end` events. Explicit TinyAI tasks
still keep their lifecycle events.

The extension also records spec/catalog access, code change summaries,
feedback, commit/push attribution snapshots, and upload retries.
Every event includes the configured `tinyaiObservability.userName` so all
sessions from the same teammate group under one user in the dashboard.
For AI code metrics, `git commit` records a `commit_snapshot` and `git push`
records a `push_snapshot` after hooks are installed. The collector compares the
commit diff against prior Copilot/Claude AI code evidence in the database to
classify AI-current, human-current, and AI-assisted human-edited lines. Users do
not need to click a manual "mark current diff" button. Snapshot events use
stable IDs based on the commit SHA or push range, so repeated runs do not double
count the same code.

Regular Copilot Chat is captured from local VS Code workspace transcript files:

```text
$HOME/Library/Application Support/Code/User/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/*.jsonl
$HOME/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/*.jsonl
```

Those records include only content VS Code/Copilot persisted locally. Hidden
model chain-of-thought is not available; `visible_reasoning` is limited to
reasoning text present in the files. Non-localhost collectors must use HTTPS
and a bearer token. Localhost may use HTTP. Direct capture still comes from the
sticky `@tinyai` participant and the `tinyai_specs` Agent-mode tool.

Claude capture is separate from Copilot model selection. If Claude is selected
inside GitHub Copilot Chat, the source is still Copilot and the event tool is
`copilot` with a Claude model name. Native Claude Code / Claude CLI / Claude
panel JSONL logs are uploaded as `tool=claude`.
