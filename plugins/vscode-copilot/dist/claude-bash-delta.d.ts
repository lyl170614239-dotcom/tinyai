type SnapshotFile = {
    file_path: string;
    exists: boolean;
    size_bytes: number;
    sha256?: string;
    content_base64?: string;
    binary?: boolean;
};
export type ClaudeBashSnapshot = {
    schema_version: "claude.bash_snapshot.v1";
    workspace_path: string;
    command: string;
    command_hash: string;
    tool_call_id?: string;
    captured_at: string;
    file_paths: string[];
    files: SnapshotFile[];
};
type ClaudeBashDeltaOptions = {
    command: string;
    sessionId?: string;
    requestId?: string;
    responseId?: string;
    turnIndex?: number;
    toolCallId?: string;
    occurredAt?: string;
};
export declare function captureClaudeBashSnapshot(workspacePath: string, options: {
    command: string;
    toolCallId?: string;
    extraPaths?: string[];
}): Promise<ClaudeBashSnapshot>;
export declare function buildClaudeBashDeltaPayload(workspacePath: string, before: ClaudeBashSnapshot, options: ClaudeBashDeltaOptions): Promise<Record<string, any> | undefined>;
export declare function writeClaudeBashSnapshot(path: string, snapshot: ClaudeBashSnapshot): Promise<void>;
export declare function readClaudeBashSnapshot(path: string): Promise<ClaudeBashSnapshot | undefined>;
export {};
