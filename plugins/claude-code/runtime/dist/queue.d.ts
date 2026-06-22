import type { EventBatch } from "./event-schema.js";
export declare function defaultQueuePath(): string;
export declare function enqueueBatch(batch: EventBatch, queuePath?: string): Promise<void>;
export declare function readQueuedBatches(queuePath?: string): Promise<EventBatch[]>;
export declare function replaceQueue(batches: EventBatch[], queuePath?: string): Promise<void>;
