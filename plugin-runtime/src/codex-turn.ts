import { makeEvent, stableEventId, type ObservabilityEvent, type SourceConfidence } from "./event-schema.js";
import type { ConversationSnapshot } from "./conversation.js";

type CodexTurnSnapshotOptions = {
  taskId?: string;
  workspacePath?: string;
  snapshotKind?: string;
  sourceConfidence?: SourceConfidence;
};

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

function latestTurnIndex(snapshot: ConversationSnapshot): number {
  const indexes = [
    ...(snapshot.messages || []).map((message) => positiveNumber(message.turn_index)),
    ...(snapshot.process_steps || []).map((step) => positiveNumber(step.turn_index)),
    ...(snapshot.code_edits || []).map((edit) => positiveNumber(edit.turn_index)),
    ...(snapshot.request_usage || []).map((usage) => positiveNumber(usage.turn_index)),
    positiveNumber(snapshot.turn_completed_count),
    positiveNumber(snapshot.turn_started_count)
  ].filter((value): value is number => typeof value === "number");
  return indexes.length > 0 ? Math.max(...indexes) : 1;
}

function lastValue<T>(items: T[] | undefined, predicate: (item: T) => boolean): T | undefined {
  return [...(items || [])].reverse().find(predicate);
}

function fallbackId(kind: "request" | "response", sessionId: string | undefined, signature: string): string {
  return `codex_${kind}_${stableEventId(`${kind}:${sessionId || "unknown"}:${signature}`).slice(0, 24)}`;
}

type CodexMessage = ConversationSnapshot["messages"][number];
type CodexProcessStep = NonNullable<ConversationSnapshot["process_steps"]>[number];

function codexLatestTurnBoundary(messages: CodexMessage[]): { index: number; sequence?: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return { index, sequence: message.sequence };
  }
  return undefined;
}

function isAfterBoundary(item: { sequence?: number }, boundarySequence?: number): boolean {
  if (boundarySequence === undefined) return true;
  return typeof item.sequence === "number" && item.sequence >= boundarySequence;
}

function scopedCodexTurn(
  snapshot: ConversationSnapshot,
  options: { turnIndex: number; requestId: string; responseId: string }
): { messages: CodexMessage[]; processSteps: CodexProcessStep[] } {
  const allMessages = snapshot.messages || [];
  const boundary = codexLatestTurnBoundary(allMessages);
  if (!boundary) {
    return {
      messages: allMessages,
      processSteps: snapshot.process_steps || []
    };
  }

  const latestMessages = allMessages.slice(boundary.index);
  let finalAssistantOffset = -1;
  for (let index = latestMessages.length - 1; index >= 0; index -= 1) {
    if (latestMessages[index]?.role === "assistant") {
      finalAssistantOffset = index;
      break;
    }
  }

  const topLevelMessages = latestMessages
    .filter((message, index) => message.role === "user" || index === finalAssistantOffset)
    .map((message) => ({
      ...message,
      turn_index: options.turnIndex,
      request_id: message.request_id || options.requestId,
      response_id: message.response_id || options.responseId
    }));

  const assistantProgress = latestMessages
    .filter((message, index) => message.role === "assistant" && index !== finalAssistantOffset)
    .map((message) => ({
      kind: "assistant_progress",
      text_len: message.text_len,
      text_hash: message.text_hash,
      text: message.text,
      label: "assistant_progress",
      status: "complete",
      occurred_at: message.occurred_at,
      sequence: message.sequence,
      turn_index: options.turnIndex,
      request_id: message.request_id || options.requestId,
      response_id: message.response_id || options.responseId,
      step_id: stableEventId(`codex:assistant_progress:${message.message_id || message.text_hash}`)
    }));

  const processSteps = (snapshot.process_steps || [])
    .filter((step) => isAfterBoundary(step, boundary.sequence))
    .map((step) => ({
      ...step,
      turn_index: options.turnIndex,
      request_id: step.request_id || options.requestId,
      response_id: step.response_id || options.responseId
    }));

  return {
    messages: topLevelMessages,
    processSteps: [...assistantProgress, ...processSteps]
  };
}

export function codexSnapshotSignature(snapshot: ConversationSnapshot): string {
  return stableEventId(
    JSON.stringify({
      session_id: snapshot.session_id || "",
      messages: (snapshot.messages || []).map((message) => [
        message.turn_index || 0,
        message.role,
        message.message_id || "",
        message.request_id || "",
        message.response_id || "",
        message.text_hash
      ]),
      process: (snapshot.process_steps || []).map((step) => [
        step.turn_index || 0,
        step.kind,
        step.tool_name || "",
        step.status || "",
        step.text_hash
      ]),
      code: snapshot.code_edits || [],
      usage: (snapshot.request_usage || []).map((usage) => [
        usage.turn_index || 0,
        usage.request_id,
        usage.response_id || "",
        usage.prompt_tokens || 0,
        usage.output_tokens || 0
      ])
    })
  );
}

export function codexTurnSnapshotPayload(
  snapshot: ConversationSnapshot,
  options: Pick<CodexTurnSnapshotOptions, "snapshotKind"> = {}
): Record<string, unknown> {
  const signature = codexSnapshotSignature(snapshot);
  const turnIndex = latestTurnIndex(snapshot);
  const latestUsage = lastValue(snapshot.request_usage, (usage) => positiveNumber(usage.turn_index) === turnIndex)
    || lastValue(snapshot.request_usage, () => true);
  const rawLatestUserMessage = lastValue(snapshot.messages, (message) => message.role === "user");
  const rawLatestAssistantMessage = lastValue(snapshot.messages, (message) => message.role === "assistant");
  const requestId =
    latestUsage?.request_id ||
    rawLatestUserMessage?.request_id ||
    rawLatestAssistantMessage?.request_id ||
    fallbackId("request", snapshot.session_id, signature);
  const responseId =
    latestUsage?.response_id ||
    rawLatestAssistantMessage?.response_id ||
    rawLatestUserMessage?.response_id ||
    fallbackId("response", snapshot.session_id, signature);
  const scoped = scopedCodexTurn(snapshot, { turnIndex, requestId, responseId });
  const latestUserMessage = lastValue(scoped.messages, (message) => message.role === "user") || rawLatestUserMessage;
  const latestAssistantMessage = lastValue(scoped.messages, (message) => message.role === "assistant") || rawLatestAssistantMessage;
  const codeChanges = snapshot.code_edits || [];
  const processSteps = scoped.processSteps;
  const title = latestUserMessage?.text ? latestUserMessage.text.slice(0, 120) : "codex 会话";
  const status = snapshot.latest_turn_complete === false ? "incomplete" : "completed";

  return {
    schema_version: "codex.turn_snapshot.v1",
    snapshot_kind: options.snapshotKind || "codex_turn_snapshot",
    source: snapshot.source || "codex_session_jsonl",
    session_id: snapshot.session_id,
    session_file: snapshot.session_file,
    cwd: snapshot.cwd,
    title,
    request_id: requestId,
    response_id: responseId,
    turn_index: turnIndex,
    turn: {
      status,
      attempt: 1,
      turn_index: turnIndex,
      request_id: requestId,
      response_id: responseId,
      started_at: latestUsage?.occurred_at,
      completed_at: latestUsage?.occurred_at
    },
    model: snapshot.model,
    resolved_model: snapshot.resolved_model || snapshot.model,
    include_text: snapshot.include_text,
    messages: scoped.messages,
    user_message: latestUserMessage,
    assistant_message: latestAssistantMessage,
    process_steps: processSteps,
    assistant_progress: processSteps.filter((step) => step.kind === "assistant_progress"),
    visible_reasoning: processSteps.filter((step) => step.kind === "thinking" || step.kind === "visible_reasoning"),
    file_reads: snapshot.file_reads || [],
    code_changes: codeChanges,
    files_changed: new Set(codeChanges.map((change) => change.file_path)).size,
    lines_added: codeChanges.reduce((sum, change) => sum + change.lines_added, 0),
    lines_deleted: codeChanges.reduce((sum, change) => sum + change.lines_deleted, 0),
    file_paths: [...new Set(codeChanges.map((change) => change.file_path))],
    request_usage: snapshot.request_usage || [],
    usage_totals: snapshot.usage_totals,
    capture_cursor: snapshot.capture_cursor,
    counts: {
      message_count: snapshot.message_count,
      user_message_count: snapshot.user_message_count,
      assistant_message_count: snapshot.assistant_message_count,
      user_followup_count: snapshot.user_followup_count,
      turn_started_count: snapshot.turn_started_count,
      turn_completed_count: snapshot.turn_completed_count,
      turn_aborted_count: snapshot.turn_aborted_count,
      task_repeat_attempts: snapshot.task_repeat_attempts,
      tool_call_count: snapshot.tool_call_count,
      tool_result_count: snapshot.tool_result_count,
      patch_apply_count: snapshot.patch_apply_count,
      patch_success_count: snapshot.patch_success_count
    },
    capture_limitations:
      "Captured from locally persisted Codex session data. Visible reasoning and tool output are included only when present in the log; hidden model reasoning is not available."
  };
}

export function buildCodexTurnSnapshotEvent(
  snapshot: ConversationSnapshot,
  options: CodexTurnSnapshotOptions = {}
): ObservabilityEvent {
  const payload = codexTurnSnapshotPayload(snapshot, options);
  const signature = codexSnapshotSignature(snapshot);
  const sessionId = snapshot.session_id;
  return makeEvent({
    tool: "codex",
    eventType: "turn_snapshot",
    taskId: options.taskId || sessionId || String(payload.request_id),
    sessionId,
    workspacePath: options.workspacePath || snapshot.cwd,
    payload,
    sourceConfidence: options.sourceConfidence || "derived",
    eventId: stableEventId(`codex:turn:${sessionId || "unknown"}:${signature}`),
    model: snapshot.resolved_model || snapshot.model
  });
}
