import { createHash } from "node:crypto";

import {
  parsedCopilotUsageFromState,
  replayCopilotRequestUsageState,
  type CopilotUsageReplayState,
  type RequestUsage,
  type UsageTotals
} from "./copilot-usage.js";

export type JsonRecord = Record<string, unknown>;

export type SourceFileInfo = {
  path?: string;
  sha256?: string;
  mtime_ms?: number;
  size_bytes?: number;
};

export type CopilotChatTurn = {
  session_id: string;
  title?: string;
  turn_index: number;
  request_id: string;
  response_id: string;
  attempt: number;
  user_text: string;
  final_answer: string;
  started_at?: string;
  completed_at: string;
  model?: string;
  usage?: RequestUsage;
};

export type CopilotProcessStep = {
  step_id: string;
  step_type: "assistant_progress" | "visible_reasoning" | "tool_call" | "sub_agent";
  text?: string;
  text_hash?: string;
  source: string;
  source_event_type?: string;
  tool_call_id?: string;
  tool_name?: string;
  status?: string;
  occurred_at?: string;
  started_at?: string;
  completed_at?: string;
  actor_path?: string;
  actor_type?: string;
  parent_tool_call_id?: string;
};

export type CopilotToolCall = {
  step_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments_raw?: unknown;
  result_raw?: unknown;
  status: string;
  started_at?: string;
  completed_at?: string;
  actor_path: string;
  actor_type: string;
  parent_tool_call_id?: string;
  source: string;
};

export type CopilotTranscriptData = {
  session_id?: string;
  started_at?: string;
  assistant_progress: CopilotProcessStep[];
  visible_reasoning: CopilotProcessStep[];
  process_steps: CopilotProcessStep[];
  tool_calls: CopilotToolCall[];
  sub_agents: JsonRecord[];
};

export type CopilotTurnSnapshot = {
  schema_version: "copilot.turn_snapshot.v1";
  session_id: string;
  title?: string;
  request_id: string;
  response_id: string;
  turn_index: number;
  attempt: number;
  source: "copilot_dual_source" | "copilot_chat_session_only";
  user_message: {
    role: "user";
    text: string;
    text_hash: string;
    source: "chatSessions";
    occurred_at?: string;
  };
  assistant_message: {
    role: "assistant";
    text: string;
    text_hash: string;
    source: "chatSessions";
    occurred_at?: string;
  };
  messages: Array<{
    role: "user" | "assistant";
    text: string;
    text_hash: string;
    source: "chatSessions";
    source_key: string;
    occurred_at?: string;
  }>;
  assistant_progress: CopilotProcessStep[];
  visible_reasoning: CopilotProcessStep[];
  process_steps: CopilotProcessStep[];
  tool_calls: CopilotToolCall[];
  sub_agents: JsonRecord[];
  request_usage: RequestUsage[];
  usage_totals: UsageTotals;
  resolved_model?: string;
  model?: string;
  turn: {
    turn_index: number;
    request_id: string;
    response_id: string;
    attempt: number;
    status: "completed";
    started_at?: string;
    completed_at: string;
  };
  source_files: {
    chat_session?: SourceFileInfo;
    transcript?: SourceFileInfo;
    parser_version: string;
    capture_limitations: string;
  };
};

export type CopilotChatReplayState = {
  chat_state?: JsonRecord;
  usage_state: CopilotUsageReplayState;
};

export const COPILOT_TURN_PARSER_VERSION = "copilot-turn-v1.0.2";

export function copilotReplayOffsets(options: {
  includeHistory?: boolean;
  replayInitializedAtEof?: boolean;
  chatReadOffset?: number;
  transcriptReadOffset?: number;
}): { chatReadOffset: number; transcriptReadOffset: number } {
  const replayAll = Boolean(options.includeHistory || options.replayInitializedAtEof);
  return {
    // VS Code chatSessions are journal/patch files. Later entries often depend
    // on the initial kind:0 state, so byte-offset replay can miss new turns.
    chatReadOffset: 0,
    // Keep transcript replay complete for tool/progress attribution. Transcript
    // entries can contribute process state to older turns while chatSessions
    // checkpoint replay rebuilds every turn snapshot.
    transcriptReadOffset: 0
  };
}

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  return undefined;
}

function millis(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value ?? null));
}

function stepId(seed: string): string {
  return hashText(seed).slice(0, 32);
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join("\n");
  const rec = record(value);
  if (!rec) return "";
  for (const key of ["text", "content", "value", "message"]) {
    const candidate = rec[key];
    if (typeof candidate === "string") return candidate;
  }
  if (Array.isArray(rec.parts)) return rec.parts.map(textFromUnknown).filter(Boolean).join("\n");
  return "";
}

function userTextFromRendered(value: unknown): string {
  const rendered = textFromUnknown(value);
  if (!rendered) return "";
  const match = /<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/i.exec(rendered);
  return (match?.[1] || "").trim();
}

function userTextFromRequest(request: JsonRecord): string {
  const messageText = textFromUnknown(request.message);
  if (messageText.trim()) return messageText.trim();
  const metadata = record(request.metadata) || {};
  return userTextFromRendered(request.renderedUserMessage) || userTextFromRendered(metadata.renderedUserMessage);
}

function assistantTextFromResponseParts(value: unknown): string {
  return array(value)
    .map((part) => {
      const rec = record(part);
      if (!rec) return "";
      const kind = String(rec.kind || "");
      if (kind === "thinking" || kind === "mcpServersStarting" || kind === "toolInvocationSerialized") return "";
      return textFromUnknown(rec.value || rec);
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function finalAnswerFromRequest(request: JsonRecord): string {
  if (Array.isArray(request.response)) return assistantTextFromResponseParts(request.response);
  const result = record(request.result);
  if (result && Array.isArray(result.response)) return assistantTextFromResponseParts(result.response);
  return textFromUnknown(request.responseText || result?.text || result?.content).trim();
}

function completedAtFromRequest(request: JsonRecord): string | undefined {
  const modelState = record(request.modelState);
  return isoTimestamp(modelState?.completedAt || request.completedAt || record(request.result)?.completedAt);
}

function responseIdFromRequest(request: JsonRecord, requestId: string, finalAnswer: string, completedAt: string): string {
  const modelState = record(request.modelState);
  const result = record(request.result);
  return (
    cleanString(request.responseId) ||
    cleanString(modelState?.responseId) ||
    cleanString(result?.responseId) ||
    `${requestId}:response:${hashText(`${finalAnswer}:${completedAt}`).slice(0, 16)}`
  );
}

function requestIdFromRequest(request: JsonRecord, index: number, sessionId: string): string {
  return cleanString(request.requestId) || cleanString(request.id) || cleanString(request.request_id) || `${sessionId}:request:${index}`;
}

function cloneJsonRecord(value: JsonRecord | undefined): JsonRecord | undefined {
  return value ? JSON.parse(JSON.stringify(value)) as JsonRecord : undefined;
}

function applyJournalEntry(root: JsonRecord | undefined, entry: JsonRecord): JsonRecord | undefined {
  if (entry.kind === 0) return cloneJsonRecord(record(entry.v)) || root;
  if (!root) return root;
  const path = Array.isArray(entry.k) ? entry.k : [];
  if (!path.length) return root;
  let cursor: any = root;
  for (const part of path.slice(0, -1)) {
    if (cursor == null) return root;
    cursor = cursor[part as any];
  }
  const last = path[path.length - 1] as any;
  if (entry.kind === 2) {
    const existing = Array.isArray(cursor[last]) ? cursor[last] : [];
    const values = (Array.isArray(entry.v) ? entry.v : [entry.v]).map((value) => {
      if (!value || typeof value !== "object") return value;
      return JSON.parse(JSON.stringify(value));
    });
    const replaceAt = typeof entry.i === "number" && Number.isInteger(entry.i) ? entry.i : undefined;
    if (replaceAt === undefined) {
      cursor[last] = existing.concat(values);
    } else {
      const next = existing.slice();
      next.splice(Math.max(0, replaceAt), values.length, ...values);
      cursor[last] = next;
    }
  } else {
    cursor[last] = entry.v;
  }
  return root;
}

export function replayCopilotChatSessionState(entries: JsonRecord[], base?: CopilotChatReplayState): CopilotChatReplayState {
  let snapshot = cloneJsonRecord(base?.chat_state);
  for (const entry of entries) snapshot = applyJournalEntry(snapshot, entry);
  return {
    chat_state: snapshot,
    usage_state: replayCopilotRequestUsageState(entries, base?.usage_state)
  };
}

export function replayCopilotChatSessionFromState(replayState: CopilotChatReplayState): {
  session_id?: string;
  title?: string;
  started_at?: string;
  turns: CopilotChatTurn[];
  usage_totals: UsageTotals;
  resolved_model?: string;
} {
  const snapshot = replayState.chat_state;
  const usage = parsedCopilotUsageFromState(replayState.usage_state);
  const sessionId = cleanString(snapshot?.sessionId) || usage.sessionId || "copilot-session";
  const title = cleanString(snapshot?.customTitle) || usage.title;
  const startedAt = isoTimestamp(snapshot?.creationDate) || usage.startedAt;
  const usageByIndex = new Map(usage.requestUsage.map((item) => [item.request_index, item]));
  const attempts = new Map<string, number>();
  const turns: CopilotChatTurn[] = [];

  array(snapshot?.requests).forEach((rawRequest, index) => {
    const request = record(rawRequest);
    if (!request) return;
    const userText = userTextFromRequest(request);
    const finalAnswer = finalAnswerFromRequest(request);
    const completedAt = completedAtFromRequest(request);
    if (!userText || !finalAnswer || !completedAt) return;
    const requestId = requestIdFromRequest(request, index, sessionId);
    const responseId = responseIdFromRequest(request, requestId, finalAnswer, completedAt);
    const attempt = (attempts.get(requestId) || 0) + 1;
    attempts.set(requestId, attempt);
    const usageForTurn = usageByIndex.get(index);
    turns.push({
      session_id: sessionId,
      title,
      turn_index: index + 1,
      request_id: requestId,
      response_id: responseId,
      attempt,
      user_text: userText,
      final_answer: finalAnswer,
      started_at: isoTimestamp(request.timestamp || request.createdAt) || usageForTurn?.occurred_at || startedAt,
      completed_at: completedAt,
      model: usageForTurn?.model || cleanString(request.modelId)?.replace(/^copilot\//, "") || usage.resolvedModel,
      usage: usageForTurn
    });
  });

  return {
    session_id: sessionId,
    title,
    started_at: startedAt,
    turns,
    usage_totals: usage.usageTotals,
    resolved_model: usage.resolvedModel
  };
}

export function replayCopilotChatSession(entries: JsonRecord[]): {
  session_id?: string;
  title?: string;
  started_at?: string;
  turns: CopilotChatTurn[];
  usage_totals: UsageTotals;
  resolved_model?: string;
} {
  return replayCopilotChatSessionFromState(replayCopilotChatSessionState(entries));
}

function eventTime(entry: JsonRecord, data: JsonRecord): string | undefined {
  return isoTimestamp(entry.timestamp || entry.time || data.timestamp || data.startTime || data.completedAt || data.createdAt);
}

function actorInfo(data: JsonRecord): { actor_path: string; actor_type: string; parent_tool_call_id?: string } {
  const parentToolCallId = cleanString(data.parentToolCallId) || cleanString(data.parent_tool_call_id) || cleanString(data.parentId);
  const actorType = cleanString(data.actorType) || cleanString(data.actor_type) || (parentToolCallId ? "sub_agent" : "top_level");
  const actorPath = cleanString(data.actorPath) || cleanString(data.actor_path) || (parentToolCallId ? `top/${parentToolCallId}` : "top");
  return { actor_path: actorPath, actor_type: actorType, parent_tool_call_id: parentToolCallId };
}

function rawArgumentsFromToolRequest(request: JsonRecord): unknown {
  const fn = record(request.function);
  return request.arguments ?? request.input ?? request.args ?? fn?.arguments;
}

function toolNameFromToolRequest(request: JsonRecord): string {
  const fn = record(request.function);
  return cleanString(request.name) || cleanString(request.toolName) || cleanString(fn?.name) || "tool";
}

function toolCallIdFrom(value: JsonRecord, fallback: string): string {
  return cleanString(value.toolCallId) || cleanString(value.tool_call_id) || cleanString(value.id) || fallback;
}

function textStep(
  stepType: CopilotProcessStep["step_type"],
  text: string,
  source: string,
  eventType: string,
  occurredAt: string | undefined,
  extra: Partial<CopilotProcessStep> = {}
): CopilotProcessStep | undefined {
  if (!text.trim()) return undefined;
  const hash = hashText(text);
  return {
    step_id: extra.step_id || stepId(`${stepType}:${hash}:${extra.tool_call_id || ""}:${occurredAt || ""}`),
    step_type: stepType,
    text,
    text_hash: hash,
    source,
    source_event_type: eventType,
    occurred_at: occurredAt,
    ...extra
  };
}

export function parseCopilotTranscriptEvents(entries: JsonRecord[]): CopilotTranscriptData {
  let sessionId: string | undefined;
  let startedAt: string | undefined;
  const toolCalls = new Map<string, CopilotToolCall>();
  const assistantProgress: CopilotProcessStep[] = [];
  const visibleReasoning: CopilotProcessStep[] = [];
  const processSteps: CopilotProcessStep[] = [];
  const subAgents: JsonRecord[] = [];

  entries.forEach((entry, index) => {
    const type = cleanString(entry.type) || "";
    const data = record(entry.data) || {};
    const occurredAt = eventTime(entry, data);
    if (type === "session.start") {
      sessionId = cleanString(data.sessionId) || sessionId;
      startedAt = isoTimestamp(data.startTime) || startedAt;
      return;
    }
    if (data.sessionId && !sessionId) sessionId = cleanString(data.sessionId);
    const actor = actorInfo(data);
    if (actor.actor_type === "sub_agent") {
      subAgents.push({ source_event_type: type, occurred_at: occurredAt, ...actor, data });
    }

    if (type === "assistant.message") {
      const content = textFromUnknown(data.content);
      const progress = textStep("assistant_progress", content, "transcript", type, occurredAt, actor);
      if (progress) {
        assistantProgress.push(progress);
        processSteps.push(progress);
      }
      const reasoning = textFromUnknown(data.reasoningText || data.thinking);
      const reasoningStep = textStep("visible_reasoning", reasoning, "transcript", type, occurredAt, {
        ...actor,
        status: "complete"
      });
      if (reasoningStep) {
        visibleReasoning.push(reasoningStep);
        processSteps.push(reasoningStep);
      }
      array(data.toolRequests || data.toolCalls).forEach((rawRequest, requestIndex) => {
        const request = record(rawRequest);
        if (!request) return;
        const toolCallId = toolCallIdFrom(request, `assistant:${index}:${requestIndex}`);
        const toolName = toolNameFromToolRequest(request);
        const existing = toolCalls.get(toolCallId);
        const step_id = existing?.step_id || stepId(`tool:${toolCallId}:${toolName}`);
        toolCalls.set(toolCallId, {
          ...(existing || {}),
          step_id,
          tool_call_id: toolCallId,
          tool_name: toolName,
          arguments_raw: existing?.arguments_raw ?? rawArgumentsFromToolRequest(request),
          result_raw: existing?.result_raw,
          status: existing?.status || "requested",
          started_at: existing?.started_at || occurredAt,
          actor_path: actor.actor_path,
          actor_type: actor.actor_type,
          parent_tool_call_id: actor.parent_tool_call_id,
          source: "transcript"
        });
      });
      return;
    }

    if (type === "tool.execution_start" || type === "tool.execution_complete") {
      const toolCallId = toolCallIdFrom(data, `tool:${index}`);
      const toolName = cleanString(data.toolName) || cleanString(data.name) || cleanString(data.invocationMessage) || "tool";
      const existing = toolCalls.get(toolCallId);
      const step_id = existing?.step_id || stepId(`tool:${toolCallId}:${toolName}`);
      const isComplete = type === "tool.execution_complete";
      const status = isComplete ? (data.success === false ? "failed" : "complete") : "running";
      toolCalls.set(toolCallId, {
        ...(existing || {}),
        step_id,
        tool_call_id: toolCallId,
        tool_name: existing?.tool_name || toolName,
        arguments_raw: existing?.arguments_raw ?? (data.input ?? data.arguments ?? data.args),
        result_raw: isComplete ? (data.output ?? data.result ?? data.error ?? data.message) : existing?.result_raw,
        status,
        started_at: existing?.started_at || occurredAt,
        completed_at: isComplete ? occurredAt : existing?.completed_at,
        actor_path: existing?.actor_path || actor.actor_path,
        actor_type: existing?.actor_type || actor.actor_type,
        parent_tool_call_id: existing?.parent_tool_call_id || actor.parent_tool_call_id,
        source: "transcript"
      });
    }
  });

  for (const tool of toolCalls.values()) {
    const text = `${tool.tool_name} ${tool.status}`;
    processSteps.push({
      step_id: tool.step_id,
      step_type: "tool_call",
      text,
      text_hash: hashText(text),
      source: tool.source,
      source_event_type: "tool",
      tool_call_id: tool.tool_call_id,
      tool_name: tool.tool_name,
      status: tool.status,
      occurred_at: tool.started_at,
      started_at: tool.started_at,
      completed_at: tool.completed_at,
      actor_path: tool.actor_path,
      actor_type: tool.actor_type,
      parent_tool_call_id: tool.parent_tool_call_id
    });
  }

  return {
    session_id: sessionId,
    started_at: startedAt,
    assistant_progress: assistantProgress,
    visible_reasoning: visibleReasoning,
    process_steps: processSteps,
    tool_calls: [...toolCalls.values()],
    sub_agents: subAgents
  };
}

function inTurnWindow(value: { occurred_at?: string; started_at?: string; completed_at?: string }, turn: CopilotChatTurn): boolean {
  const start = millis(turn.started_at);
  const end = millis(turn.completed_at);
  const candidate = millis(value.occurred_at || value.started_at || value.completed_at);
  if (candidate === undefined || start === undefined || end === undefined) return true;
  return candidate >= start - 2_000 && candidate <= end + 2_000;
}

export function buildCopilotTurnSnapshots(input: {
  chat_entries: JsonRecord[];
  transcript_entries?: JsonRecord[];
  chat_file?: SourceFileInfo;
  transcript_file?: SourceFileInfo;
}): CopilotTurnSnapshot[] {
  return buildCopilotTurnSnapshotsFromReplayState({
    replay_state: replayCopilotChatSessionState(input.chat_entries),
    transcript_entries: input.transcript_entries,
    chat_file: input.chat_file,
    transcript_file: input.transcript_file
  });
}

export function buildCopilotTurnSnapshotsFromReplayState(input: {
  replay_state: CopilotChatReplayState;
  transcript_entries?: JsonRecord[];
  chat_file?: SourceFileInfo;
  transcript_file?: SourceFileInfo;
}): CopilotTurnSnapshot[] {
  const chat = replayCopilotChatSessionFromState(input.replay_state);
  const transcript = input.transcript_entries ? parseCopilotTranscriptEvents(input.transcript_entries) : undefined;
  const usageByRequest = new Map((chat.turns || []).map((turn) => [turn.request_id, turn.usage]));

  return chat.turns.map((turn) => {
    const assistantProgress = (transcript?.assistant_progress || []).filter((step) => inTurnWindow(step, turn));
    const visibleReasoning = (transcript?.visible_reasoning || []).filter((step) => inTurnWindow(step, turn));
    const toolCalls = (transcript?.tool_calls || []).filter((tool) => inTurnWindow(tool, turn));
    const processSteps = (transcript?.process_steps || [])
      .filter((step) => inTurnWindow(step, turn))
      .map((step) => ({ ...step, request_id: turn.request_id, response_id: turn.response_id } as CopilotProcessStep));
    const subAgents = (transcript?.sub_agents || []).filter((agent) => inTurnWindow(agent as { occurred_at?: string }, turn));
    const usage = usageByRequest.get(turn.request_id) || turn.usage;
    const requestUsage = usage
      ? [{ ...usage, request_id: turn.request_id, response_id: turn.response_id } as RequestUsage & { response_id: string }]
      : [];
    const usageTotals = requestUsage.reduce<UsageTotals>(
      (totals, item) => ({
        prompt_tokens: totals.prompt_tokens + (item.prompt_tokens || 0),
        output_tokens: totals.output_tokens + (item.output_tokens || 0),
        completion_tokens: totals.completion_tokens + (item.completion_tokens || 0),
        elapsed_ms: totals.elapsed_ms + (item.elapsed_ms || 0),
        copilot_credits: Math.round((totals.copilot_credits + (item.copilot_credits || 0)) * 1000) / 1000
      }),
      { prompt_tokens: 0, output_tokens: 0, completion_tokens: 0, elapsed_ms: 0, copilot_credits: 0 }
    );
    const userHash = hashText(turn.user_text);
    const assistantHash = hashText(turn.final_answer);
    return {
      schema_version: "copilot.turn_snapshot.v1",
      session_id: turn.session_id,
      title: turn.title || chat.title,
      request_id: turn.request_id,
      response_id: turn.response_id,
      turn_index: turn.turn_index,
      attempt: turn.attempt,
      source: transcript ? "copilot_dual_source" : "copilot_chat_session_only",
      user_message: {
        role: "user",
        text: turn.user_text,
        text_hash: userHash,
        source: "chatSessions",
        occurred_at: turn.started_at
      },
      assistant_message: {
        role: "assistant",
        text: turn.final_answer,
        text_hash: assistantHash,
        source: "chatSessions",
        occurred_at: turn.completed_at
      },
      messages: [
        {
          role: "user",
          text: turn.user_text,
          text_hash: userHash,
          source: "chatSessions",
          source_key: `${turn.request_id}:user`,
          occurred_at: turn.started_at
        },
        {
          role: "assistant",
          text: turn.final_answer,
          text_hash: assistantHash,
          source: "chatSessions",
          source_key: `${turn.request_id}:${turn.response_id}:assistant`,
          occurred_at: turn.completed_at
        }
      ],
      assistant_progress: assistantProgress,
      visible_reasoning: visibleReasoning,
      process_steps: processSteps,
      tool_calls: toolCalls.map((tool) => ({ ...tool, request_id: turn.request_id, response_id: turn.response_id } as CopilotToolCall)),
      sub_agents: subAgents,
      request_usage: requestUsage,
      usage_totals: usageTotals,
      resolved_model: turn.model || chat.resolved_model,
      model: turn.model || chat.resolved_model,
      turn: {
        turn_index: turn.turn_index,
        request_id: turn.request_id,
        response_id: turn.response_id,
        attempt: turn.attempt,
        status: "completed",
        started_at: turn.started_at,
        completed_at: turn.completed_at
      },
      source_files: {
        chat_session: input.chat_file,
        transcript: input.transcript_file,
        parser_version: COPILOT_TURN_PARSER_VERSION,
        capture_limitations:
          "Captured from persisted VS Code Copilot chatSessions and GitHub.copilot-chat transcript files. visible_reasoning only contains reasoning text that those files actually persisted; hidden model chain-of-thought is not available."
      }
    };
  });
}

export function copilotTurnEventId(
  snapshot: Pick<CopilotTurnSnapshot, "session_id" | "request_id" | "response_id">,
  clientId?: string
): string {
  return hashText(`copilot:turn:${clientId || "unknown-client"}:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}`).slice(0, 32);
}

export function copilotTurnSignature(snapshot: CopilotTurnSnapshot): string {
  return hashJson({
    request_id: snapshot.request_id,
    response_id: snapshot.response_id,
    user: snapshot.user_message.text_hash,
    assistant: snapshot.assistant_message.text_hash,
    tools: snapshot.tool_calls.map((tool) => [tool.tool_call_id, tool.status, hashJson(tool.arguments_raw), hashJson(tool.result_raw)]),
    reasoning: snapshot.visible_reasoning.map((step) => step.text_hash),
    completed_at: snapshot.turn.completed_at
  });
}
