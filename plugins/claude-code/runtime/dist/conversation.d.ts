import type { ToolName } from "./event-schema.js";
type CapturedMessage = {
    role: string;
    text_len: number;
    text_hash: string;
    text?: string;
    message_id?: string;
    occurred_at?: string;
    sequence?: number;
    turn_index?: number;
    request_id?: string;
    response_id?: string;
};
type CapturedProcessStep = {
    step_id?: string;
    kind: string;
    text_len: number;
    text_hash: string;
    text?: string;
    label?: string;
    tool_name?: string;
    status?: string;
    occurred_at?: string;
    sequence?: number;
    turn_index?: number;
    request_id?: string;
    response_id?: string;
};
type FileReadRecord = {
    path: string;
    line_start?: number;
    line_end?: number;
    occurred_at?: string;
    sequence?: number;
};
type HunkLine = {
    line_type: "added" | "removed";
    old_line?: number;
    new_line?: number;
    text: string;
    text_hash: string;
};
type CodeEditHunk = {
    old_start: number;
    old_lines: number;
    new_start: number;
    new_lines: number;
    lines: HunkLine[];
};
type CodeEditRecord = {
    file_path: string;
    lines_added: number;
    lines_deleted: number;
    hunks: CodeEditHunk[];
    occurred_at?: string;
    sequence?: number;
    turn_index?: number;
    request_id?: string;
    response_id?: string;
};
type CapturedTurnEvent = {
    kind: "task_started" | "task_complete" | "turn_aborted";
    occurred_at?: string;
    sequence: number;
    turn_id?: string;
    duration_ms?: number;
    time_to_first_token_ms?: number;
};
type CapturedRequestUsage = {
    request_id: string;
    response_id?: string;
    request_index: number;
    turn_index?: number;
    model?: string;
    prompt_tokens?: number;
    output_tokens?: number;
    completion_tokens?: number;
    elapsed_ms?: number;
    copilot_credits?: number;
    occurred_at?: string;
};
type CapturedUsageTotals = {
    prompt_tokens: number;
    output_tokens: number;
    completion_tokens: number;
    elapsed_ms: number;
    copilot_credits: number;
};
type CaptureCursorMetadata = {
    tool: "codex" | "claude";
    key: string;
    file_path: string;
    previous_offset: number;
    next_offset: number;
    file_size: number;
    line_count: number;
    initialized_at_eof?: boolean;
};
export interface ConversationSnapshot {
    session_id?: string;
    session_file: string;
    cwd?: string;
    source?: string;
    message_count: number;
    user_message_count: number;
    assistant_message_count: number;
    user_followup_count: number;
    turn_started_count: number;
    turn_completed_count: number;
    turn_aborted_count: number;
    task_repeat_attempts: number;
    tool_call_count: number;
    tool_result_count: number;
    patch_apply_count: number;
    patch_success_count: number;
    include_text: boolean;
    messages: CapturedMessage[];
    process_steps?: CapturedProcessStep[];
    file_reads?: FileReadRecord[];
    code_edits?: CodeEditRecord[];
    turn_events?: CapturedTurnEvent[];
    request_usage?: CapturedRequestUsage[];
    usage_totals?: CapturedUsageTotals;
    model?: string;
    resolved_model?: string;
    latest_turn_complete?: boolean;
    capture_cursor?: CaptureCursorMetadata;
}
export declare function commitConversationCursor(snapshot: ConversationSnapshot): Promise<boolean>;
export declare function latestCodexTurnSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot;
export declare function captureLatestCodexConversation(options?: {
    includeText?: boolean;
    sessionFile?: string;
    sessionId?: string;
    latestTurnOnly?: boolean;
}): Promise<ConversationSnapshot>;
export declare function captureLatestClaudeConversation(options?: {
    includeText?: boolean;
    sessionFile?: string;
    sessionId?: string;
}): Promise<ConversationSnapshot>;
export declare function captureLatestConversation(tool: ToolName, options?: {
    includeText?: boolean;
    sessionFile?: string;
    sessionId?: string;
    latestTurnOnly?: boolean;
}): Promise<ConversationSnapshot>;
export {};
