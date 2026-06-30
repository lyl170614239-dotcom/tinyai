export type ToolName = "codex" | "claude" | "copilot";
export type SourceConfidence = "direct" | "derived" | "inferred";
export type EventType = "task_start" | "task_end" | "spec_read" | "catalog_hit" | "fallback_search" | "official_misread" | "code_change" | "ai_line_snapshot" | "commit_snapshot" | "push_snapshot" | "user_correction" | "regenerate" | "interruption" | "adoption_snapshot" | "turn_snapshot" | "conversation_snapshot" | "agent_process_snapshot" | "agent_activity" | "file_read" | "plugin_heartbeat";
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
    user_email?: string;
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
    user_email?: string;
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
    user_email?: string;
    user_display_name?: string;
    team?: string;
    machine_id?: string;
    host_hash?: string;
}
export declare function hashWorkspace(workspacePath?: string): string;
export declare function stableEventId(seed: string): string;
export declare function taskIdFromEnv(): string;
export declare function clientId(tool: ToolName, overrides?: Partial<UserIdentity>): string;
export declare function resolveUsername(): string;
export declare function resolveUserIdentity(overrides?: Partial<UserIdentity>): UserIdentity;
export declare function resolveModel(): string | undefined;
export declare function makeEvent(input: {
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
}): ObservabilityEvent;
