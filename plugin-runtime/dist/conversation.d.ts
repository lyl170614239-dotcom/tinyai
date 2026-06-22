import type { ToolName } from "./event-schema.js";
type CapturedMessage = {
    role: string;
    text_len: number;
    text_hash: string;
    text?: string;
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
}
export declare function captureLatestCodexConversation(options?: {
    includeText?: boolean;
}): Promise<ConversationSnapshot>;
export declare function captureLatestClaudeConversation(options?: {
    includeText?: boolean;
}): Promise<ConversationSnapshot>;
export declare function captureLatestConversation(tool: ToolName, options?: {
    includeText?: boolean;
}): Promise<ConversationSnapshot>;
export {};
