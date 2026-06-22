import { createHash, randomUUID } from "node:crypto";
import { cwd } from "node:process";

export type ToolName = "codex" | "claude" | "copilot";
export type SourceConfidence = "direct" | "derived" | "inferred";
export type EventType =
  | "task_start"
  | "task_end"
  | "spec_read"
  | "catalog_hit"
  | "fallback_search"
  | "official_misread"
  | "code_change"
  | "ai_line_snapshot"
  | "commit_snapshot"
  | "push_snapshot"
  | "user_correction"
  | "regenerate"
  | "interruption"
  | "adoption_snapshot"
  | "conversation_snapshot"
  | "plugin_heartbeat";

export interface ObservabilityEvent {
  event_id: string;
  task_id: string;
  session_id?: string;
  tool: ToolName;
  event_type: EventType;
  occurred_at: string;
  workspace_path_hash?: string;
  payload: Record<string, unknown>;
  source_confidence: SourceConfidence;
}

export interface EventBatch {
  client_id: string;
  plugin_name: string;
  plugin_version: string;
  events: ObservabilityEvent[];
}

const processTaskId = process.env.TINYAI_OBS_TASK_ID || randomUUID();

export function hashWorkspace(workspacePath = cwd()): string {
  return createHash("sha256").update(workspacePath).digest("hex").slice(0, 32);
}

export function stableEventId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

export function taskIdFromEnv(): string {
  return processTaskId;
}

export function clientId(tool: ToolName): string {
  const seed = `${tool}:${process.env.USER || process.env.USERNAME || "unknown"}:${process.env.HOSTNAME || "local"}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

export function makeEvent(input: {
  tool: ToolName;
  eventType: EventType;
  taskId?: string;
  sessionId?: string;
  workspacePath?: string;
  payload?: Record<string, unknown>;
  sourceConfidence?: SourceConfidence;
  eventId?: string;
}): ObservabilityEvent {
  return {
    event_id: input.eventId || randomUUID(),
    task_id: input.taskId || taskIdFromEnv(),
    session_id: input.sessionId || process.env.TINYAI_OBS_SESSION_ID,
    tool: input.tool,
    event_type: input.eventType,
    occurred_at: new Date().toISOString(),
    workspace_path_hash: hashWorkspace(input.workspacePath),
    payload: input.payload || {},
    source_confidence: input.sourceConfidence || "direct"
  };
}
