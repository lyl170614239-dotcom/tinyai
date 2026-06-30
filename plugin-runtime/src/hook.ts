#!/usr/bin/env node
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cwd } from "node:process";
import {
  buildClaudeBashDeltaPayload,
  captureClaudeBashSnapshot,
  readClaudeBashSnapshot,
  writeClaudeBashSnapshot
} from "./claude-bash-delta.js";
import { captureLatestClaudeTurnSnapshots } from "./claude-turn.js";
import { claudeWorkspaceDiffPathCandidates, hasClaudeExternalWriteSignal } from "./claude-workspace-fallback.js";
import { CollectorClient } from "./client.js";
import { loadTinyAiEnvFile } from "./config.js";
import { buildCodexTurnSnapshotEvent, codexSnapshotSignature } from "./codex-turn.js";
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
const rawEventType = process.env.TINYAI_OBS_EVENT_TYPE || process.argv[2] || "plugin_heartbeat";
const eventType = rawEventType as EventType;
const requireAiMarker = ["1", "true", "yes", "on"].includes(String(process.env.TINYAI_OBS_REQUIRE_AI_MARKER || "").toLowerCase());
const skipUnmarkedCommits = ["1", "true", "yes", "on"].includes(String(process.env.TINYAI_OBS_SKIP_UNMARKED_COMMITS || "").toLowerCase());
const enableClaudeWorkspaceDiffFallback = ["1", "true", "yes", "on"].includes(String(process.env.TINYAI_OBS_ENABLE_CLAUDE_WORKSPACE_DIFF_FALLBACK || "").toLowerCase());
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
const hookSessionFile =
  hookPayload.transcript_path ||
  hookPayload.transcriptPath ||
  hookPayload.session_file ||
  hookPayload.sessionFile;
const payload = raw ? { hook_payload_present: true, hook_payload_bytes: Buffer.byteLength(raw) } : {};
const events =
  eventType === "commit_snapshot" || eventType === "push_snapshot" || rawEventType === "bash_pre_tool_use" || rawEventType === "bash_post_tool_use"
    ? []
    : [makeEvent({ tool, eventType, taskId: hookTaskId, sessionId: hookSessionId, workspacePath, payload, sourceConfidence: "derived" })];
const afterSuccessfulUpload: Array<() => Promise<void>> = [];

type ClaudeTurnCursorRecord = {
  file_path: string;
  read_offset: number;
  file_size: number;
  session_id?: string;
  updated_at: string;
};

function claudeTurnCursorStorePath(): string {
  return join(process.env.TINYAI_OBS_CURSOR_DIR || join(homedir(), ".tinyai-observability", "cursors"), "claude-turn-cursors.json");
}

async function loadClaudeTurnCursorStore(): Promise<Record<string, ClaudeTurnCursorRecord>> {
  try {
    const parsed = JSON.parse(await readFile(claudeTurnCursorStorePath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, ClaudeTurnCursorRecord> : {};
  } catch {
    return {};
  }
}

async function saveClaudeTurnCursorStore(store: Record<string, ClaudeTurnCursorRecord>): Promise<void> {
  const target = claudeTurnCursorStorePath();
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

function claudeTurnCursorKey(filePath: string): string {
  return stableEventId(`claude-turn-cursor:${filePath}`);
}

async function startOffsetForClaudeTurnFile(
  filePath: string,
  sessionId?: string,
  options: { initializeAtEof?: boolean } = {}
): Promise<{ startOffset: number; initializedAtEof: boolean }> {
  const st = await stat(filePath);
  const store = await loadClaudeTurnCursorStore();
  const key = claudeTurnCursorKey(filePath);
  const existing = store[key];
  if (!existing) {
    if (options.initializeAtEof === false) {
      return { startOffset: 0, initializedAtEof: false };
    }
    store[key] = {
      file_path: filePath,
      read_offset: st.size,
      file_size: st.size,
      session_id: sessionId,
      updated_at: new Date().toISOString()
    };
    await saveClaudeTurnCursorStore(store);
    return { startOffset: st.size, initializedAtEof: true };
  }
  return { startOffset: Math.max(0, Math.min(existing.read_offset, st.size)), initializedAtEof: false };
}

async function commitClaudeTurnCursor(filePath: string, nextOffset: number, sessionId?: string): Promise<void> {
  const st = await stat(filePath);
  const store = await loadClaudeTurnCursorStore();
  const key = claudeTurnCursorKey(filePath);
  const existing = store[key];
  if (existing && existing.read_offset > nextOffset) return;
  store[key] = {
    file_path: filePath,
    read_offset: Math.max(0, Math.min(nextOffset, st.size)),
    file_size: st.size,
    session_id: sessionId || existing?.session_id,
    updated_at: new Date().toISOString()
  };
  await saveClaudeTurnCursorStore(store);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hookToolName(): string {
  return String(hookPayload.tool_name || hookPayload.toolName || hookPayload.tool || hookPayload.name || "").toLowerCase();
}

function hookToolInput(): Record<string, unknown> {
  return objectRecord(hookPayload.tool_input) || objectRecord(hookPayload.toolInput) || objectRecord(hookPayload.input) || {};
}

function hookToolCallId(): string | undefined {
  const value = hookPayload.tool_use_id || hookPayload.toolUseID || hookPayload.tool_call_id || hookPayload.toolCallId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hookCommand(): string | undefined {
  const input = hookToolInput();
  const value = input.command || hookPayload.command;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function claudeBashSnapshotPath(toolCallId?: string, command?: string): string {
  const key = stableEventId(`${hookSessionId || "unknown"}:${toolCallId || ""}:${command || ""}`);
  return join(process.env.TINYAI_OBS_BASH_DELTA_DIR || join(homedir(), ".tinyai-observability", "bash-delta"), `${key}.json`);
}

async function claudeTurnContextForToolCall(toolCallId?: string): Promise<{ requestId?: string; responseId?: string; turnIndex?: number }> {
  if (!toolCallId || typeof hookSessionFile !== "string") return {};
  try {
    const snapshots = await captureLatestClaudeTurnSnapshots({
      includeText: false,
      sessionId: hookSessionId,
      workspacePath,
      sessionFile: hookSessionFile,
      latestOnly: false,
      startOffset: 0
    });
    const match = snapshots.find((snapshot) =>
      snapshot.tool_calls.some((call) => call.tool_call_id === toolCallId) ||
      snapshot.process_steps.some((step) => step.tool_call_id === toolCallId)
    );
    if (!match) return {};
    return {
      requestId: match.request_id,
      responseId: match.response_id,
      turnIndex: match.turn_index
    };
  } catch {
    return {};
  }
}

if (eventType === "task_start" && tool === "claude" && typeof hookSessionFile === "string") {
  await startOffsetForClaudeTurnFile(hookSessionFile, hookSessionId);
}

if (rawEventType === "bash_pre_tool_use" && tool === "claude" && /bash|shell|terminal/.test(hookToolName())) {
  const command = hookCommand();
  if (command) {
    const toolCallId = hookToolCallId();
    const snapshot = await captureClaudeBashSnapshot(workspacePath, { command, toolCallId });
    await writeClaudeBashSnapshot(claudeBashSnapshotPath(toolCallId, command), snapshot);
  }
}

if (rawEventType === "bash_post_tool_use" && tool === "claude" && /bash|shell|terminal/.test(hookToolName())) {
  const command = hookCommand();
  if (command) {
    const toolCallId = hookToolCallId();
    const snapshotPath = claudeBashSnapshotPath(toolCallId, command);
    const before = await readClaudeBashSnapshot(snapshotPath);
    if (before) {
      await rm(snapshotPath, { force: true });
      const turnContext = await claudeTurnContextForToolCall(toolCallId);
      const delta = await buildClaudeBashDeltaPayload(workspacePath, before, {
        command,
        sessionId: hookSessionId,
        requestId: turnContext.requestId,
        responseId: turnContext.responseId,
        turnIndex: turnContext.turnIndex,
        toolCallId,
        occurredAt: new Date().toISOString()
      });
      if (delta) {
        events.push(
          makeEvent({
            tool: "claude",
            eventType: "code_change",
            taskId: hookTaskId || hookSessionId || `claude-bash-${delta.command_hash || Date.now()}`,
            sessionId: hookSessionId,
            workspacePath,
            payload: delta,
            sourceConfidence: "derived",
            eventId: stableEventId(`claude:bash_delta:${workspacePath}:${hookSessionId || ""}:${toolCallId || ""}:${delta.command_hash}:${delta.after_captured_at}`)
          })
        );
      }
    }
  }
}

async function appendClaudeWorkspaceDiffFallbackEvents(
  snapshot: Awaited<ReturnType<typeof captureLatestClaudeTurnSnapshots>>[number],
  options: { eventId: string; taskId?: string; sessionId?: string; workspacePath: string; captureText: boolean }
) {
  if (!hasClaudeExternalWriteSignal(snapshot)) return;
  const paths = claudeWorkspaceDiffPathCandidates(snapshot);
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

if (eventType === "code_change" || (eventType === "task_end" && tool !== "codex")) {
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
  const sessionFile = typeof hookSessionFile === "string" ? hookSessionFile : undefined;
  const cursorStart = sessionFile
    ? await startOffsetForClaudeTurnFile(sessionFile, hookSessionId, { initializeAtEof: false })
    : undefined;
  try {
    const snapshots = await captureLatestClaudeTurnSnapshots({
      includeText: captureText,
      sessionId: hookSessionId,
      workspacePath,
      sessionFile,
      latestOnly: false,
      startOffset: cursorStart?.startOffset
    });
    for (const snapshot of snapshots) {
      if (snapshot.turn.status === "incomplete") {
        continue;
      }
      const eventId = stableEventId(`claude:turn:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}`);
      const sourceInfo = objectRecord((snapshot.source_files as Record<string, unknown> | undefined)?.claude_project_jsonl);
      const nextOffset = Number(sourceInfo?.next_offset);
      events.push(
        makeEvent({
          tool,
          eventType: "turn_snapshot",
          taskId: hookTaskId || snapshot.request_id,
          sessionId: snapshot.session_id,
          workspacePath: snapshot.cwd || workspacePath,
          payload: { ...snapshot, capture_cursor: cursorStart },
          sourceConfidence: "derived",
          eventId,
          model: snapshot.resolved_model || snapshot.model
        })
      );
      if (enableClaudeWorkspaceDiffFallback) {
        await appendClaudeWorkspaceDiffFallbackEvents(snapshot, {
          eventId,
          taskId: hookTaskId || snapshot.request_id,
          sessionId: snapshot.session_id,
          workspacePath: snapshot.cwd || workspacePath,
          captureText
        });
      }
      if (sessionFile && Number.isFinite(nextOffset) && nextOffset >= 0) {
        afterSuccessfulUpload.push(() => commitClaudeTurnCursor(sessionFile, nextOffset, snapshot.session_id));
      }
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
      sessionFile: typeof hookSessionFile === "string" ? hookSessionFile : undefined,
      latestTurnOnly: tool === "codex"
    });
    const conversationSignature = tool === "codex"
      ? codexSnapshotSignature(snapshot)
      : stableEventId(
          JSON.stringify(snapshot.messages.map((message) => [message.role, message.message_id || "", message.text_hash]))
        );
    if (tool === "codex") {
      events.length = 0;
      events.push(
        buildCodexTurnSnapshotEvent(snapshot, {
          taskId: hookTaskId,
          workspacePath: snapshot.cwd || workspacePath,
          snapshotKind: "codex_hook_task_end"
        })
      );
    } else {
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
    }

    // Generate agent_process_snapshot when process_steps exist
    const processSteps = snapshot.process_steps || [];
    if (tool !== "codex" && processSteps.length > 0) {
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
    if (tool !== "codex" && codeEdits.length > 0) {
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
  const result = await new CollectorClient({ tool, workspacePath }).upload(tool, events);
  if (!result.queued) {
    for (const commit of afterSuccessfulUpload) await commit();
  }
}
