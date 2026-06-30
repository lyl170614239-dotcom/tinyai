export type CopilotCreditsSource = "direct" | "details";
export type RequestUsage = {
    request_id: string;
    request_index: number;
    model?: string;
    prompt_tokens?: number;
    output_tokens?: number;
    completion_tokens?: number;
    elapsed_ms?: number;
    copilot_credits?: number;
    credits_source?: CopilotCreditsSource;
    occurred_at?: string;
};
export type UsageTotals = {
    prompt_tokens: number;
    output_tokens: number;
    completion_tokens: number;
    elapsed_ms: number;
    copilot_credits: number;
};
export type ParsedCopilotUsage = {
    sessionId?: string;
    title?: string;
    startedAt?: string;
    resolvedModel?: string;
    requestUsage: RequestUsage[];
    usageTotals: UsageTotals;
    requestCount: number;
};
export type CopilotUsageReplayState = {
    sessionId?: string;
    title?: string;
    startedAt?: string;
    nextRequestIndex: number;
    requestUsage: RequestUsage[];
};
type JsonRecord = Record<string, unknown>;
export declare function replayCopilotRequestUsageState(entries: JsonRecord[], base?: CopilotUsageReplayState): CopilotUsageReplayState;
export declare function parsedCopilotUsageFromState(state: CopilotUsageReplayState): ParsedCopilotUsage;
export declare function parseCopilotRequestUsage(entries: JsonRecord[]): ParsedCopilotUsage;
export {};
