import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { tinyAiQueuePathForTool } from "./config.js";
import type { EventBatch, ToolName } from "./event-schema.js";

const MAX_QUEUE_BYTES = Number(process.env.TINYAI_OBS_QUEUE_MAX_BYTES || 1024 * 1024 * 1024);
const MAX_QUEUE_BATCHES = Number(process.env.TINYAI_OBS_QUEUE_MAX_BATCHES || 2000);

export type QueueErrorCategory =
  | "retryable"
  | "payload_too_large"
  | "config_error"
  | "schema_error"
  | "rate_limited"
  | "unknown";

export type QueuedBatchEntry = {
  schema_version: "tinyai.queue.v2";
  queue_id: string;
  tool?: ToolName;
  status: "queued";
  retry_count: number;
  first_seen_at: string;
  last_attempt_at: string;
  next_retry_at?: string;
  last_error?: string;
  error_category: QueueErrorCategory;
  batch: EventBatch;
};

export type EnqueueBatchOptions = {
  errorCategory?: QueueErrorCategory;
  lastError?: string;
  retryCount?: number;
  nextRetryAt?: string;
};

function toolFromBatch(batch?: EventBatch): ToolName | undefined {
  return batch?.events?.[0]?.tool;
}

export function defaultQueuePath(tool?: ToolName | string): string {
  return tinyAiQueuePathForTool(tool || process.env.TINYAI_OBS_TOOL);
}

function queueIdFor(batch: EventBatch): string {
  const eventIds = (batch.events || []).map((event) => event.event_id).join(":");
  return `${toolFromBatch(batch) || "unknown"}:${eventIds || Date.now()}`;
}

function queueEntryFromBatch(batch: EventBatch, options: EnqueueBatchOptions = {}): QueuedBatchEntry {
  const now = new Date().toISOString();
  return {
    schema_version: "tinyai.queue.v2",
    queue_id: queueIdFor(batch),
    tool: toolFromBatch(batch),
    status: "queued",
    retry_count: options.retryCount || 0,
    first_seen_at: now,
    last_attempt_at: now,
    next_retry_at: options.nextRetryAt,
    last_error: options.lastError,
    error_category: options.errorCategory || "retryable",
    batch
  };
}

function batchFromQueueLine(value: unknown): EventBatch | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.schema_version === "tinyai.queue.v2") {
    const batch = record.batch;
    return batch && typeof batch === "object" ? batch as EventBatch : undefined;
  }
  return record.events && Array.isArray(record.events) ? record as unknown as EventBatch : undefined;
}

export async function enqueueBatch(
  batch: EventBatch,
  queuePath = defaultQueuePath(toolFromBatch(batch)),
  options: EnqueueBatchOptions = {}
): Promise<void> {
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(queuePath, `${JSON.stringify(queueEntryFromBatch(batch, options))}\n`, { flag: "a" });
  const info = await stat(queuePath).catch(() => undefined);
  if (info && info.size > MAX_QUEUE_BYTES) {
    const batches = await readQueuedBatches(queuePath);
    await replaceQueue(batches.slice(-Math.max(1, Math.floor(MAX_QUEUE_BATCHES / 2))), queuePath);
  }
}

export async function readQueuedBatches(queuePath = defaultQueuePath()): Promise<EventBatch[]> {
  try {
    const raw = await readFile(queuePath, "utf8");
    const batches: EventBatch[] = [];
    const corrupt: string[] = [];
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        const batch = batchFromQueueLine(JSON.parse(line));
        if (batch) batches.push(batch);
      } catch {
        corrupt.push(line);
      }
    }
    if (corrupt.length > 0) {
      await writeFile(`${queuePath}.corrupt`, `${corrupt.join("\n")}\n`, { flag: "a" });
    }
    return batches.slice(-MAX_QUEUE_BATCHES);
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function replaceQueue(batches: EventBatch[], queuePath = defaultQueuePath()): Promise<void> {
  await mkdir(dirname(queuePath), { recursive: true });
  if (!batches.length) {
    await rm(queuePath, { force: true });
    return;
  }
  const temp = `${queuePath}.tmp`;
  await writeFile(temp, batches.map((batch) => JSON.stringify(queueEntryFromBatch(batch))).join("\n") + "\n");
  await rename(temp, queuePath);
}
