import { type RequestUsage, type UsageTotals } from "./copilot-usage.js";
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
export declare const COPILOT_TURN_PARSER_VERSION = "copilot-turn-v1.0.1";
export declare function replayCopilotChatSession(entries: JsonRecord[]): {
    session_id?: string;
    title?: string;
    started_at?: string;
    turns: CopilotChatTurn[];
    usage_totals: UsageTotals;
    resolved_model?: string;
};
export declare function parseCopilotTranscriptEvents(entries: JsonRecord[]): CopilotTranscriptData;
export declare function buildCopilotTurnSnapshots(input: {
    chat_entries: JsonRecord[];
    transcript_entries?: JsonRecord[];
    chat_file?: SourceFileInfo;
    transcript_file?: SourceFileInfo;
}): CopilotTurnSnapshot[];
export declare function copilotTurnEventId(snapshot: Pick<CopilotTurnSnapshot, "session_id" | "request_id" | "response_id">, clientId?: string): string;
export declare function copilotTurnSignature(snapshot: CopilotTurnSnapshot): string;
