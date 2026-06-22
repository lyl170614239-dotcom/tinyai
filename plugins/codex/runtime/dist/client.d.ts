import type { EventBatch, ObservabilityEvent, ToolName } from "./event-schema.js";
export interface CollectorClientOptions {
    baseUrl?: string;
    token?: string;
    pluginName?: string;
    pluginVersion?: string;
}
export declare class CollectorClient {
    private readonly baseUrl;
    private readonly token;
    private readonly pluginName;
    private readonly pluginVersion;
    constructor(options?: CollectorClientOptions);
    makeBatch(tool: ToolName, events: ObservabilityEvent[]): EventBatch;
    upload(tool: ToolName, events: ObservabilityEvent[]): Promise<void>;
    flushQueue(): Promise<{
        sent: number;
        remaining: number;
    }>;
    private postBatch;
}
