import type { EventBatch, ToolName } from "./event-schema.js";
export declare function defaultQueuePath(tool?: ToolName | string): string;
export declare function enqueueBatch(batch: EventBatch, queuePath?: string): Promise<void>;
export declare function readQueuedBatches(queuePath?: string): Promise<EventBatch[]>;
export declare function replaceQueue(batches: EventBatch[], queuePath?: string): Promise<void>;
