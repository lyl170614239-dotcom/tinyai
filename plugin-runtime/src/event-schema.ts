import { createHash, randomUUID } from "node:crypto";
import { cwd } from "node:process";

export type ToolName = "codex" | "claude" | "copilot" | "git";
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
  | "user_correction"
  | "regenerate"
  | "interruption"
  | "adoption_snapshot"
  | "turn_snapshot"
  | "conversation_snapshot"
  | "agent_process_snapshot"
  | "agent_activity"
  | "file_read"
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
  username: string;
  user_id?: string;
  user_display_name?: string;
  team?: string;
  machine_id?: string;
  host_hash?: string;
  model?: string;
}

export interface EventBatch {
  client_id: string;
  plugin_name: string;
  plugin_version: string;
  username: string;
  user_id?: string;
  user_display_name?: string;
  team?: string;
  machine_id?: string;
  host_hash?: string;
  model?: string;
  events: ObservabilityEvent[];
}

export interface BatchEventResult {
  event_id: string;
  event_type: EventType | string;
  status: "accepted" | "duplicate" | "failed";
  reason?: string | null;
}

export interface BatchUploadResult {
  accepted: number;
  duplicates: number;
  failed?: number;
  task_count?: number;
  events?: BatchEventResult[];
  queued?: boolean;
}

export interface UserIdentity {
  username: string;
  user_id?: string;
  user_display_name?: string;
  team?: string;
  machine_id?: string;
  host_hash?: string;
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

export function clientId(tool: ToolName, overrides: Partial<UserIdentity> = {}): string {
  const identity = resolveUserIdentity(overrides);
  const seed = `${tool}:${identity.user_id || identity.user_display_name || identity.username}:${identity.machine_id || identity.host_hash || "local"}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

export function resolveUsername(): string {
  return process.env.USER || process.env.USERNAME || "unknown";
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function usableUserId(value: string | undefined): string | undefined {
  const cleaned = clean(value);
  if (!cleaned) return undefined;
  const lowered = cleaned.toLowerCase();
  if (lowered === "unknown" || lowered === "user" || lowered === "null" || lowered === "none") return undefined;
  if (cleaned.includes("@")) return undefined;
  return cleaned;
}

function normalizeToolEnvName(tool: string | undefined): string | undefined {
  const normalized = tool?.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || undefined;
}

function toolEnvValue(suffix: string): string | undefined {
  return toolEnvValueForTool(process.env.TINYAI_OBS_TOOL, suffix);
}

function toolEnvValueForTool(toolName: string | undefined, suffix: string): string | undefined {
  const tool = normalizeToolEnvName(toolName);
  if (tool) {
    const value = clean(process.env[`TINYAI_OBS_${tool}_${suffix}`]);
    if (value) return value;
  }
  return clean(process.env[`TINYAI_OBS_${suffix}`]);
}

export function resolveUserIdentity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return resolveUserIdentityForTool(process.env.TINYAI_OBS_TOOL, overrides);
}

export function resolveUserIdentityForTool(toolName: string | undefined, overrides: Partial<UserIdentity> = {}): UserIdentity {
  const userDisplayName =
    clean(overrides.user_display_name) ||
    toolEnvValueForTool(toolName, "USER_DISPLAY_NAME") ||
    toolEnvValueForTool(toolName, "USER_NAME");
  const username = clean(overrides.username) || toolEnvValueForTool(toolName, "USERNAME") || userDisplayName || resolveUsername();
  const explicitUserId = clean(overrides.user_id) || toolEnvValueForTool(toolName, "USER_ID");
  const userId =
    usableUserId(explicitUserId) ||
    usableUserId(username) ||
    usableUserId(userDisplayName) ||
    username;
  const hostname = clean(process.env.HOSTNAME) || "local";
  return {
    username,
    user_id: userId,
    user_display_name: userDisplayName,
    team: clean(overrides.team) || clean(process.env.TINYAI_OBS_TEAM),
    machine_id: clean(overrides.machine_id) || clean(process.env.TINYAI_OBS_MACHINE_ID),
    host_hash: clean(overrides.host_hash) || createHash("sha256").update(hostname).digest("hex").slice(0, 32)
  };
}

export function resolveModel(): string | undefined {
  return (
    process.env.TINYAI_OBS_MODEL ||
    process.env.CLAUDE_CODE_MODEL ||
    process.env.OPENAI_MODEL ||
    undefined
  );
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
  model?: string;
  userIdentity?: Partial<UserIdentity>;
}): ObservabilityEvent {
  const identity = resolveUserIdentity(input.userIdentity);
  return {
    event_id: input.eventId || randomUUID(),
    task_id: input.taskId || taskIdFromEnv(),
    session_id: input.sessionId || process.env.TINYAI_OBS_SESSION_ID,
    tool: input.tool,
    event_type: input.eventType,
    occurred_at: new Date().toISOString(),
    workspace_path_hash: hashWorkspace(input.workspacePath),
    payload: input.payload || {},
    source_confidence: input.sourceConfidence || "direct",
    ...identity,
    model: input.model ?? resolveModel()
  };
}
