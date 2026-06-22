export interface GitDiffSummary {
    files_changed: number;
    lines_added: number;
    lines_deleted: number;
    file_paths: string[];
}
export interface DiffAddedLine {
    file_path: string;
    new_line: number;
    content: string;
    line_hash: string;
}
export interface LineAttribution {
    total_added_lines: number;
    ai_added_lines: number;
    human_added_lines: number;
    files: Array<{
        file_path: string;
        ai_lines: Array<{
            new_line: number;
            line_hash: string;
            evidence_source?: string;
        }>;
        human_lines: Array<{
            new_line: number;
            line_hash: string;
        }>;
    }>;
}
export interface AiLineEvidence {
    tool: string;
    task_id?: string;
    source?: string;
    file_path: string;
    new_line: number;
    line_hash: string;
    recorded_at: string;
    expires_at: string;
}
export interface GitCommitSnapshot extends GitDiffSummary {
    commit_sha?: string;
    branch?: string;
    snapshot_kind: "commit";
    ai_assisted: boolean;
    ai_lines_added: number;
    ai_lines_deleted: number;
    ai_attribution_method: string;
    ai_attribution_evidence: string;
    ai_marker_task_id?: string;
    ai_marker_age_seconds?: number;
    human_lines_added: number;
    line_attribution: LineAttribution;
}
export interface GitPushSnapshot extends GitDiffSummary {
    branch?: string;
    upstream_ref?: string;
    base_sha?: string;
    head_sha?: string;
    commit_count: number;
    snapshot_kind: "push";
    ai_assisted: boolean;
    ai_lines_added: number;
    ai_lines_deleted: number;
    ai_attribution_method: string;
    ai_attribution_evidence: string;
    ai_marker_task_id?: string;
    ai_marker_age_seconds?: number;
}
export interface AiActivityMarker {
    tool: string;
    task_id?: string;
    source?: string;
    marked_at: string;
    expires_at: string;
}
export interface AttributionOptions {
    requireAiMarker?: boolean;
    aiAssisted?: boolean;
    attributionEvidence?: string;
}
export declare function markAiActivity(workspacePath: string, options: {
    tool: string;
    taskId?: string;
    source?: string;
    ttlSeconds?: number;
}): Promise<AiActivityMarker | undefined>;
export declare function recordAiLineSnapshot(workspacePath: string, options: {
    tool: string;
    taskId?: string;
    source?: string;
    stagedOnly?: boolean;
    requireAiMarker?: boolean;
    ttlSeconds?: number;
}): Promise<{
    recorded_lines: number;
    files_changed: number;
    skipped: boolean;
    reason?: string;
}>;
export declare function diffSummary(workspacePath: string): Promise<GitDiffSummary>;
export declare function currentBranch(workspacePath: string): Promise<string | undefined>;
export declare function currentHead(workspacePath: string): Promise<string | undefined>;
export declare function commitSnapshot(workspacePath: string, ref?: string, options?: AttributionOptions): Promise<GitCommitSnapshot>;
export declare function pushSnapshot(workspacePath: string, options?: AttributionOptions): Promise<GitPushSnapshot>;
export declare function installGitHooks(workspacePath: string, options: {
    tool: string;
    collectorUrl?: string;
    token?: string;
    pluginVersion?: string;
}): Promise<{
    installed: string[];
    git_dir?: string;
}>;
