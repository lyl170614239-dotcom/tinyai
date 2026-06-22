export type ToolName = "codex" | "claude" | "copilot";
export type SourceConfidence = "direct" | "derived" | "inferred";
export type EventType = "task_start" | "task_end" | "spec_read" | "catalog_hit" | "fallback_search" | "official_misread" | "code_change" | "ai_line_snapshot" | "commit_snapshot" | "push_snapshot" | "user_correction" | "regenerate" | "interruption" | "adoption_snapshot" | "conversation_snapshot" | "plugin_heartbeat";
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
export declare function hashWorkspace(workspacePath?: string): string;
export declare function stableEventId(seed: string): string;
export declare function taskIdFromEnv(): string;
export declare function clientId(tool: ToolName): string;
export declare function makeEvent(input: {
    tool: ToolName;
    eventType: EventType;
    taskId?: string;
    sessionId?: string;
    workspacePath?: string;
    payload?: Record<string, unknown>;
    sourceConfidence?: SourceConfidence;
    eventId?: string;
}): ObservabilityEvent;
