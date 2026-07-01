import type { BatchUploadResult, EventBatch, ObservabilityEvent, ToolName } from "./event-schema.js";
export interface CollectorClientOptions {
    baseUrl?: string;
    fallbackUrls?: string[];
    token?: string;
    pluginName?: string;
    pluginVersion?: string;
    tool?: ToolName;
    workspacePath?: string;
    queuePath?: string;
}
export declare function isCollectorUploadAllowedForUrl(baseUrl: string, token: string): boolean;
export declare function uploadResultAllowsCursorCommit(result: BatchUploadResult): boolean;
export declare class CollectorClient {
    private readonly baseUrl;
    private readonly baseUrls;
    private readonly token;
    private readonly pluginName;
    private readonly pluginVersion;
    private readonly tool?;
    private readonly queuePath?;
    constructor(options?: CollectorClientOptions);
    makeBatch(tool: ToolName, events: ObservabilityEvent[]): EventBatch;
    upload(tool: ToolName, events: ObservabilityEvent[]): Promise<BatchUploadResult>;
    flushQueue(tool?: ToolName | undefined): Promise<{
        sent: number;
        remaining: number;
    }>;
    private queuePathFor;
    private postBatch;
    private postBatchToUrl;
}
