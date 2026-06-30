type ClaudeLikeCodeChange = {
    file_path?: unknown;
};
type ClaudeLikeToolCall = {
    tool_name?: unknown;
    name?: unknown;
    arguments_raw?: unknown;
    result_raw?: unknown;
};
type ClaudeLikeSnapshot = {
    code_changes?: ClaudeLikeCodeChange[];
    tool_calls?: ClaudeLikeToolCall[];
};
export declare function collectClaudePotentialFilePaths(value: unknown): string[];
export declare function hasClaudeExternalWriteSignal(snapshot: ClaudeLikeSnapshot): boolean;
export declare function claudeWorkspaceDiffPathCandidates(snapshot: ClaudeLikeSnapshot): string[];
export {};
