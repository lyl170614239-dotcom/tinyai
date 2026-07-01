import { captureLatestClaudeTurnSnapshots, type ClaudeTurnSnapshot } from "./claude-turn.js";
import { CollectorClient, type CollectorClientOptions } from "./client.js";
import { type ObservabilityEvent } from "./event-schema.js";
export type ClaudeTurnCursorRecord = {
    file_path: string;
    read_offset: number;
    file_size: number;
    session_id?: string;
    updated_at: string;
};
export type ClaudeBackfillResult = {
    scanned_files: number;
    candidate_files: number;
    uploaded_events: number;
    committed_files: number;
    queued: boolean;
    skipped_incomplete: number;
    initialized_at_eof: number;
};
export type ClaudeBackfillOptions = {
    workspacePath: string;
    includeText?: boolean;
    recentMinutes?: number;
    maxFiles?: number;
    sessionFile?: string;
    sessionId?: string;
    cursorDir?: string;
    initializeUnseenFilesAtEof?: boolean;
    collectorOptions?: CollectorClientOptions;
    client?: Pick<CollectorClient, "upload">;
};
export declare function startOffsetForClaudeTurnFile(filePath: string, sessionId?: string, options?: {
    initializeAtEof?: boolean;
    cursorDir?: string;
}): Promise<{
    startOffset: number;
    initializedAtEof: boolean;
}>;
export declare function commitClaudeTurnCursor(filePath: string, nextOffset: number, sessionId?: string, cursorDir?: string): Promise<void>;
export declare function captureClaudeTurnSnapshotsWithRetry(options: Parameters<typeof captureLatestClaudeTurnSnapshots>[0]): Promise<ClaudeTurnSnapshot[]>;
export declare function recentClaudeJsonlFiles(options?: {
    sessionFile?: string;
    recentMinutes?: number;
    maxFiles?: number;
}): Promise<string[]>;
export declare function claudeTurnEventsFromSnapshots(input: {
    snapshots: ClaudeTurnSnapshot[];
    workspacePath: string;
    taskId?: string;
    cursorStart?: {
        startOffset: number;
        initializedAtEof: boolean;
    };
}): {
    events: ObservabilityEvent[];
    commitOffset?: number;
    commitSessionId?: string;
    skippedIncomplete: number;
};
export declare function backfillRecentClaudeTurns(options: ClaudeBackfillOptions): Promise<ClaudeBackfillResult>;
