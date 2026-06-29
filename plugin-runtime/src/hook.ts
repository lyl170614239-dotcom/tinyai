#!/usr/bin/env node
import { cwd } from "node:process";
import { captureLatestClaudeTurnSnapshots } from "./claude-turn.js";
import { CollectorClient } from "./client.js";
import { loadTinyAiEnvFile } from "./config.js";
import { captureLatestConversation } from "./conversation.js";
import { makeEvent, stableEventId, type EventType, type ToolName } from "./event-schema.js";
import { commitSnapshot, currentDiffDetails, diffSummary, pushSnapshot, recordAiLineSnapshot } from "./git.js";

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => resolve(raw));
  });
}

const workspacePath = process.env.TINYAI_OBS_WORKSPACE || cwd();
loadTinyAiEnvFile(workspacePath);
const tool = (process.env.TINYAI_OBS_TOOL || "claude") as ToolName;
const eventType = (process.env.TINYAI_OBS_EVENT_TYPE || process.argv[2] || "plugin_heartbeat") as EventType;
const requireAiMarker = ["1", "true", "yes", "on"].includes(String(process.env.TINYAI_OBS_REQUIRE_AI_MARKER || "").toLowerCase());
const skipUnmarkedCommits = ["1", "true", "yes", "on"].includes(String(process.env.TINYAI_OBS_SKIP_UNMARKED_COMMITS || "").toLowerCase());
const outputTokens = process.env.TINYAI_OBS_OUTPUT_TOKENS
  ? parseInt(process.env.TINYAI_OBS_OUTPUT_TOKENS, 10) || undefined
  : undefined;
const raw = await readStdin();
let hookPayload: Record<string, unknown> = {};
if (raw.trim()) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") hookPayload = parsed as Record<string, unknown>;
  } catch {
    // Hooks differ across versions; malformed stdin is still recorded by size.
  }
}
const hookSessionIdValue = hookPayload.session_id || hookPayload.sessionId || hookPayload.conversation_id;
const hookSessionId = typeof hookSessionIdValue === "string" ? hookSessionIdValue : undefined;
const hookTaskId = process.env.TINYAI_OBS_TASK_ID || hookSessionId;
const payload = raw ? { hook_payload_present: true, hook_payload_bytes: Buffer.byteLength(raw) } : {};
const events =
  eventType === "commit_snapshot" || eventType === "push_snapshot"
    ? []
    : [makeEvent({ tool, eventType, taskId: hookTaskId, sessionId: hookSessionId, workspacePath, payload, sourceConfidence: "derived" })];

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(textFromUnknown).filter(Boolean).join("\n");
  }
  return "";
}

function collectPotentialFilePaths(value: unknown): string[] {
  const text = textFromUnknown(value);
  const output = new Set<string>();
  const patterns = [
    /(?:^|[\s"'`=:(])((?:\.{1,2}\/|\/|~\/)?[\w.@%+=:,~/-]+\.[A-Za-z0-9_+-]{1,16})(?=$|[\s"'`),;])/g,
    /(?:^|[\s"'`=:(])((?:\.{1,2}\/|\/|~\/)?[\w.@%+=:,~/-]+\/[\w.@%+=:,~/-]+)(?=$|[\s"'`),;])/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (!candidate) continue;
      if (candidate.length > 500) continue;
      if (/^(https?:|mailto:|data:)/i.test(candidate)) continue;
      if (candidate.includes("node_modules/") || candidate.includes(".git/")) continue;
      output.add(candidate.replace(/^file:\/\//, ""));
    }
  }
  return [...output].slice(0, 50);
}

function claudeSnapshotPathCandidates(snapshot: Awaited<ReturnType<typeof captureLatestClaudeTurnSnapshots>>[number]): string[] {
  const paths = new Set<string>();
  for (const change of snapshot.code_changes || []) {
    if (change.file_path) paths.add(change.file_path);
  }
  for (const toolCall of snapshot.tool_calls || []) {
    for (const path of collectPotentialFilePaths(toolCall)) paths.add(path);
  }
  for (const step of snapshot.process_steps || []) {
    for (const path of collectPotentialFilePaths(step)) paths.add(path);
  }
  return [...paths].slice(0, 50);
}

function hasClaudeExternalWriteSignal(snapshot: Awaited<ReturnType<typeof captureLatestClaudeTurnSnapshots>>[number]): boolean {
  for (const toolCall of snapshot.tool_calls || []) {
    const name = String(toolCall.tool_name || "").toLowerCase();
    const raw = textFromUnknown([toolCall.arguments_raw, toolCall.result_raw]).toLowerCase();
    if (/(bash|shell|terminal|run_command|run_in_terminal)/.test(name)) return true;
    if (/(^|\s)(python|python3|node|perl|ruby|sh|bash)\s/.test(raw) && /(write|append|open\(|>>|>\s*[^&])/.test(raw)) return true;
  }
  for (const step of snapshot.process_steps || []) {
    const text = `${step.step_type || ""}\n${step.text || ""}`.toLowerCase();
    if (/(bash|terminal|shell|ran command|executed command)/.test(text) && /(write|append|created|edited|modified|>>|>\s*[^&])/.test(text)) {
      return true;
    }
  }
  return false;
}

async function appendClaudeWorkspaceDiffFallbackEvents(
  snapshot: Awaited<ReturnType<typeof captureLatestClaudeTurnSnapshots>>[number],
  options: { eventId: string; taskId?: string; sessionId?: string; workspacePath: string; captureText: boolean }
) {
  if (!hasClaudeExternalWriteSignal(snapshot)) return;
  const paths = claudeSnapshotPathCandidates(snapshot);
  if (paths.length === 0) return;
  const diffRoot = snapshot.cwd || options.workspacePath;
  const diff = await currentDiffDetails(diffRoot, { includeText: true, includeUntracked: true, paths });
  if (!diff.files_changed || diff.files.length === 0) return;
  events.push(
    makeEvent({
      tool: "claude",
      eventType: "code_change",
      taskId: options.taskId || snapshot.request_id,
      sessionId: options.sessionId || snapshot.session_id,
      workspacePath: diffRoot,
      payload: {
        ...diff,
        snapshot_kind: "claude_turn_workspace_diff",
        trigger: "claude_code_hook_turn_snapshot",
        session_id: snapshot.session_id,
        request_id: snapshot.request_id,
        response_id: snapshot.response_id,
        turn_index: snapshot.turn_index,
        attribution_evidence: "claude_turn_external_file_write_fallback",
        capture_strategy: "workspace_diff_fallback_for_terminal_or_external_file_write",
        path_candidates: paths,
        capture_note:
          "Fallback code evidence captured by the Claude Code hook after a Claude turn with terminal/script/external-write signals. It is limited to paths mentioned by this turn and uses the Claude JSONL cwd as the git diff root."
      },
      sourceConfidence: "derived",
      eventId: stableEventId(`claude:turn_workspace_diff:${options.eventId}:${diff.diff_hash}`)
    })
  );
}

if (eventType === "task_end" || eventType === "code_change") {
  events.push(
    makeEvent({
      tool,
      eventType: "code_change",
      taskId: hookTaskId,
      sessionId: hookSessionId,
      workspacePath,
      payload: { ...(await diffSummary(workspacePath)) },
      sourceConfidence: "derived"
    })
  );
}

if (eventType === "task_end") {
  // Stamp output_tokens onto the task_end event if available
  const taskEndEvent = events.find((e) => e.event_type === "task_end");
  if (taskEndEvent && outputTokens !== undefined) {
    taskEndEvent.payload = { ...taskEndEvent.payload, output_tokens: outputTokens };
  }
}

if (eventType === "ai_line_snapshot") {
  events.length = 0;
  const snapshot = await recordAiLineSnapshot(workspacePath, {
    tool,
    taskId: process.env.TINYAI_OBS_TASK_ID,
    source: "git_pre_commit_hook",
    stagedOnly: ["1", "true", "yes", "on"].includes(String(process.env.TINYAI_OBS_STAGED_ONLY || "").toLowerCase()),
    requireAiMarker
  });
  if (!snapshot.skipped && snapshot.recorded_lines > 0) {
    events.push(
      makeEvent({
        tool,
        eventType: "ai_line_snapshot",
        workspacePath,
        payload: { ...snapshot, snapshot_kind: "git_pre_commit_hook" },
        sourceConfidence: "derived"
      })
    );
  }
}

if (eventType === "commit_snapshot") {
  const snapshot = await commitSnapshot(workspacePath, "HEAD", { requireAiMarker });
  if (snapshot.ai_assisted || !skipUnmarkedCommits) {
    events.push(
      makeEvent({
        tool,
        eventType: "commit_snapshot",
        taskId: process.env.TINYAI_OBS_TASK_ID || (snapshot.commit_sha ? `commit-${snapshot.commit_sha.slice(0, 16)}` : undefined),
        workspacePath,
        payload: { ...snapshot },
        sourceConfidence: "derived",
        eventId: snapshot.commit_sha ? stableEventId(`${tool}:commit_snapshot:${workspacePath}:${snapshot.commit_sha}`) : undefined
      })
    );
  }
}

if (eventType === "push_snapshot") {
  const snapshot = await pushSnapshot(workspacePath, { requireAiMarker });
  const rangeKey = snapshot.head_sha ? `${snapshot.upstream_ref || ""}:${snapshot.base_sha || ""}:${snapshot.head_sha}` : "";
  if (snapshot.ai_assisted || !skipUnmarkedCommits) {
    events.push(
      makeEvent({
        tool,
        eventType: "push_snapshot",
        taskId: process.env.TINYAI_OBS_TASK_ID || (snapshot.head_sha ? `push-${snapshot.head_sha.slice(0, 16)}` : undefined),
        workspacePath,
        payload: { ...snapshot },
        sourceConfidence: "derived",
        eventId: rangeKey ? stableEventId(`${tool}:push_snapshot:${workspacePath}:${rangeKey}`) : undefined
      })
    );
  }
}

if (eventType === "turn_snapshot" && tool === "claude") {
  events.length = 0;
  const captureText = ["1", "true", "yes", "on"].includes(String(process.env.TINYAI_OBS_CAPTURE_CONVERSATION_TEXT || "").toLowerCase());
  const hookSessionFile =
    hookPayload.transcript_path ||
    hookPayload.transcriptPath ||
    hookPayload.session_file ||
    hookPayload.sessionFile;
  try {
    const snapshots = await captureLatestClaudeTurnSnapshots({
      includeText: captureText,
      sessionId: hookSessionId,
      workspacePath,
      sessionFile: typeof hookSessionFile === "string" ? hookSessionFile : undefined,
      latestOnly: true
    });
    for (const snapshot of snapshots) {
      const eventId = stableEventId(`claude:turn:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}`);
      events.push(
        makeEvent({
          tool,
          eventType: "turn_snapshot",
          taskId: hookTaskId || snapshot.request_id,
          sessionId: snapshot.session_id,
          workspacePath: snapshot.cwd || workspacePath,
          payload: { ...snapshot },
          sourceConfidence: "derived",
          eventId,
          model: snapshot.resolved_model || snapshot.model
        })
      );
      await appendClaudeWorkspaceDiffFallbackEvents(snapshot, {
        eventId,
        taskId: hookTaskId || snapshot.request_id,
        sessionId: snapshot.session_id,
        workspacePath: snapshot.cwd || workspacePath,
        captureText
      });
    }
  } catch (error) {
    events.push(
      makeEvent({
        tool,
        eventType: "turn_snapshot",
        taskId: hookTaskId,
        sessionId: hookSessionId,
        workspacePath,
        payload: {
          schema_version: "claude.turn_snapshot.v1",
          capture_error: String(error),
          source: "claude_project_jsonl"
        },
        sourceConfidence: "inferred"
      })
    );
  }
}

if (eventType === "task_end") {
  const captureText = ["1", "true", "yes", "on"].includes(String(process.env.TINYAI_OBS_CAPTURE_CONVERSATION_TEXT || "").toLowerCase());
  try {
    const hookSessionFile =
      hookPayload.transcript_path ||
      hookPayload.transcriptPath ||
      hookPayload.session_file ||
      hookPayload.sessionFile;
    const snapshot = await captureLatestConversation(tool, {
      includeText: captureText,
      sessionId: hookSessionId,
      sessionFile: typeof hookSessionFile === "string" ? hookSessionFile : undefined
    });
    const conversationSignature = stableEventId(
      JSON.stringify(snapshot.messages.map((message) => [message.role, message.message_id || "", message.text_hash]))
    );
    events.push(
      makeEvent({
        tool,
        eventType: "conversation_snapshot",
        taskId: hookTaskId,
        sessionId: snapshot.session_id,
        workspacePath,
        payload: { ...snapshot },
        sourceConfidence: "derived",
        eventId: stableEventId(`${tool}:conversation:${snapshot.session_id || hookTaskId}:${conversationSignature}`),
        model: snapshot.resolved_model || snapshot.model
      })
    );

    // Generate agent_process_snapshot when process_steps exist
    const processSteps = snapshot.process_steps || [];
    if (processSteps.length > 0) {
      const visibleReasoning = processSteps.filter((s) => s.kind === "thinking");
      events.push(
        makeEvent({
          tool,
          eventType: "agent_process_snapshot",
          taskId: hookTaskId,
          sessionId: snapshot.session_id,
          workspacePath,
          payload: {
            snapshot_kind: "hook_task_end_process",
            session_id: snapshot.session_id,
            session_file: snapshot.session_file,
            include_text: captureText,
            process_step_count: processSteps.length,
            visible_reasoning_count: visibleReasoning.length,
            file_read_count: snapshot.file_reads?.length || 0,
            read_files: snapshot.file_reads || [],
            tool_call_count: snapshot.tool_call_count,
            tool_result_count: snapshot.tool_result_count,
            turn_started_count: snapshot.turn_started_count,
            turn_completed_count: snapshot.turn_completed_count,
            capture_limitations:
              "Captured from local tool transcript JSONL at task end. Thinking blocks and tool calls are extracted when available in the transcript. This is not guaranteed internal model chain-of-thought.",
            visible_reasoning: visibleReasoning,
            process_steps: processSteps
          },
          sourceConfidence: "derived",
          eventId: stableEventId(`${tool}:process:${snapshot.session_id || hookTaskId}:${conversationSignature}`)
        })
      );

    }

    // Generate code_change events for code edits extracted from tool args
    const codeEdits = snapshot.code_edits || [];
    if (codeEdits.length > 0) {
      const linesAdded = codeEdits.reduce((sum, e) => sum + e.lines_added, 0);
      const linesDeleted = codeEdits.reduce((sum, e) => sum + e.lines_deleted, 0);
      events.push(
        makeEvent({
          tool,
          eventType: "code_change",
          taskId: hookTaskId,
          sessionId: snapshot.session_id,
          workspacePath,
          payload: {
            snapshot_kind: "tool_edit",
            session_id: snapshot.session_id,
            trigger: "hook_task_end_tool_arguments",
            files_changed: new Set(codeEdits.map((e) => e.file_path)).size,
            lines_added: linesAdded,
            lines_deleted: linesDeleted,
            file_paths: [...new Set(codeEdits.map((e) => e.file_path))],
            include_text: true,
            capture_note: "Derived from tool arguments (oldStr/newStr) extracted from local transcript.",
            files: codeEdits
          },
          sourceConfidence: "derived",
          eventId: stableEventId(
            `${tool}:tool-edit:${snapshot.session_id || hookTaskId}:${stableEventId(JSON.stringify(codeEdits))}`
          )
        })
      );
    }
  } catch (error) {
    events.push(
      makeEvent({
        tool,
        eventType: "conversation_snapshot",
        workspacePath,
        payload: { include_text: captureText, capture_error: String(error) },
        sourceConfidence: "inferred"
      })
    );
  }
}

if (events.length > 0) {
  await new CollectorClient({ tool, workspacePath }).upload(tool, events);
}
