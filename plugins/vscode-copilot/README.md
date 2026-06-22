# TinyAI Observability

Private VS Code extension for collecting Copilot-era coding task telemetry.

## Usage

1. Install the private `.vsix`.
2. Reload VS Code.
3. Keep using Copilot Chat / Agent mode normally.
4. The extension automatically scans local VS Code Copilot transcript files and uploads full user/assistant messages when `tinyaiObservability.captureConversationText` is enabled.
5. In Agent mode, enable or allow the `tinyai_specs` tool. Copilot can then call the tool directly when the prompt needs personal specs.
6. For sticky TinyAI chat, start a Copilot Chat thread with `@tinyai`; the participant is sticky, so follow-up turns in that thread do not need `@tinyai` again.
7. Open the left-side `TinyAI` activity bar item for task controls: `Capture Copilot Local Transcripts`, `Start Task`, `Record AI Lines Snapshot`, `Record Commit Snapshot`, `Record Push/PR Snapshot`, `Install Git Hooks`, `Record Feedback`, `Record Adoption Snapshot`, `End Task`, and fallback transcript import.
8. Click `Install Git Hooks` once per repository when you want commit/push AI code attribution to run automatically.

The extension records task lifecycle events, spec/catalog file access, code
change summaries, full conversation text for TinyAI-owned chat surfaces,
local Copilot transcript JSONL files, clipboard/editor-imported Copilot
transcripts, feedback, adoption snapshots, and upload retries.
For AI code metrics, `git commit` records a `commit_snapshot` and `git push`
records a `push_snapshot` after hooks are installed and a recent TinyAI AI
activity marker exists. Normal human commits without that marker are skipped.
For same-commit AI-vs-human line attribution, run `Record AI Lines Snapshot`
after Copilot-generated edits and before committing. Lines without a prior AI
line snapshot are treated as human. Snapshot events use stable IDs based on the
commit SHA or push range, so repeated runs do not double count the same code.

Regular Copilot Chat is captured from local VS Code workspace transcript files:

```text
$HOME/Library/Application Support/Code/User/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/*.jsonl
$HOME/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/*.jsonl
```

Those records include user and assistant message text when VS Code persists
them. They are marked `derived` because the extension reads local persisted
files rather than receiving a first-party Copilot Chat event. Direct capture
still comes from the sticky `@tinyai` participant and the `tinyai_specs`
Agent-mode tool. Inline completions are not per-suggestion exact; code adoption
is estimated from task-window diffs and retention snapshots.
