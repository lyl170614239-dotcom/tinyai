type ClaudeMessage = {
    role: "user" | "assistant";
    text: string;
    text_hash: string;
    source: "claude_project_jsonl";
    source_key: string;
    occurred_at?: string;
};
type ClaudeProcessStep = {
    step_id: string;
    step_type: "assistant_progress" | "visible_reasoning" | "tool_call" | "tool_result" | "context" | "error";
    text?: string;
    text_hash?: string;
    source: "claude_project_jsonl";
    source_event_type?: string;
    tool_call_id?: string;
    tool_name?: string;
    status?: string;
    occurred_at?: string;
    actor_path: "top";
    actor_type: "assistant" | "system";
};
type ClaudeToolCall = {
    step_id: string;
    tool_call_id: string;
    tool_name: string;
    arguments_raw?: unknown;
    result_raw?: unknown;
    status: "requested" | "complete" | "failed";
    started_at?: string;
    completed_at?: string;
    actor_path: "top";
    actor_type: "assistant";
    source: "claude_project_jsonl";
};
type ClaudeCodeChange = {
    snapshot_kind: "claude_turn_tool_patch";
    file_path: string;
    lines_added: number;
    lines_deleted: number;
    line_number_basis?: "absolute" | "relative";
    line_numbers_are_absolute?: boolean;
    hunks: Array<{
        old_start: number;
        old_lines: number;
        new_start: number;
        new_lines: number;
        lines: Array<{
            line_type: "added" | "removed";
            old_line?: number;
            new_line?: number;
            text: string;
            text_hash: string;
        }>;
    }>;
    request_id?: string;
    response_id?: string;
    turn_index?: number;
    tool_call_id?: string;
    tool_name?: string;
    status?: string;
    source: "claude_tool_arguments";
    raw_json?: unknown;
};
export type ClaudeTurnSnapshot = {
    schema_version: "claude.turn_snapshot.v1";
    session_id: string;
    request_id: string;
    response_id: string;
    turn_index: number;
    attempt: number;
    source: "claude_project_jsonl";
    cwd?: string;
    git_branch?: string;
    claude_entrypoint?: string;
    claude_version?: string;
    title?: string;
    model?: string;
    resolved_model?: string;
    user_message: {
        role: "user";
        text: string;
        text_hash: string;
        source: "claude_project_jsonl";
        occurred_at?: string;
    };
    assistant_message?: {
        role: "assistant";
        text: string;
        text_hash: string;
        source: "claude_project_jsonl";
        occurred_at?: string;
    };
    messages: ClaudeMessage[];
    assistant_progress: ClaudeProcessStep[];
    visible_reasoning: ClaudeProcessStep[];
    process_steps: ClaudeProcessStep[];
    tool_calls: ClaudeToolCall[];
    code_changes: ClaudeCodeChange[];
    request_usage: Array<{
        request_id: string;
        response_id?: string;
        request_index: number;
        turn_index: number;
        model?: string;
        prompt_tokens?: number;
        output_tokens?: number;
        completion_tokens?: number;
        elapsed_ms?: number;
        credits_source?: "claude";
        occurred_at?: string;
    }>;
    usage_totals: {
        prompt_tokens?: number;
        output_tokens?: number;
        completion_tokens?: number;
        elapsed_ms?: number;
    };
    turn: {
        turn_index: number;
        request_id: string;
        response_id: string;
        attempt: number;
        status: "completed" | "failed" | "incomplete";
        interrupted?: boolean;
        interrupt_reason?: string;
        abandoned?: boolean;
        finish_reason?: string;
        started_at?: string;
        completed_at?: string;
    };
    source_files: {
        claude_project_jsonl: {
            path: string;
            sha256?: string;
            mtime_ms?: number;
            size_bytes?: number;
            read_offset?: number;
            next_offset?: number;
            hash_scope?: "full_file" | "read_segment";
        };
        parser_version: string;
        capture_limitations: string;
    };
};
export declare const CLAUDE_TURN_PARSER_VERSION = "claude-turn-v1.0.3";
export declare function captureLatestClaudeTurnSnapshots(options?: {
    includeText?: boolean;
    sessionFile?: string;
    sessionId?: string;
    workspacePath?: string;
    latestOnly?: boolean;
    startOffset?: number;
}): Promise<ClaudeTurnSnapshot[]>;
export {};
