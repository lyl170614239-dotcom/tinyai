import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";

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
  status: "queued" | "dead_letter";
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
  status?: QueuedBatchEntry["status"];
  firstSeenAt?: string;
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
    status: options.status || "queued",
    retry_count: options.retryCount || 0,
    first_seen_at: options.firstSeenAt || now,
    last_attempt_at: now,
    next_retry_at: options.nextRetryAt,
    last_error: options.lastError,
    error_category: options.errorCategory || "retryable",
    batch
  };
}

function entryFromQueueLine(value: unknown): QueuedBatchEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.schema_version === "tinyai.queue.v2") {
    const batch = record.batch;
    if (!batch || typeof batch !== "object") return undefined;
    return {
      schema_version: "tinyai.queue.v2",
      queue_id: typeof record.queue_id === "string" ? record.queue_id : queueIdFor(batch as EventBatch),
      tool: typeof record.tool === "string" ? record.tool as ToolName : toolFromBatch(batch as EventBatch),
      status: record.status === "dead_letter" ? "dead_letter" : "queued",
      retry_count: typeof record.retry_count === "number" ? record.retry_count : 0,
      first_seen_at: typeof record.first_seen_at === "string" ? record.first_seen_at : new Date().toISOString(),
      last_attempt_at: typeof record.last_attempt_at === "string" ? record.last_attempt_at : new Date().toISOString(),
      next_retry_at: typeof record.next_retry_at === "string" ? record.next_retry_at : undefined,
      last_error: typeof record.last_error === "string" ? record.last_error : undefined,
      error_category: typeof record.error_category === "string" ? record.error_category as QueueErrorCategory : "retryable",
      batch: batch as EventBatch
    };
  }
  if (record.events && Array.isArray(record.events)) {
    return queueEntryFromBatch(record as unknown as EventBatch);
  }
  return undefined;
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

export function deadLetterQueuePath(queuePath = defaultQueuePath()): string {
  const ext = extname(queuePath);
  return ext ? `${queuePath.slice(0, -ext.length)}.dead-letter${ext}` : `${queuePath}.dead-letter`;
}

export async function deadLetterBatch(
  batch: EventBatch,
  queuePath = defaultQueuePath(toolFromBatch(batch)),
  options: EnqueueBatchOptions = {}
): Promise<void> {
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(
    deadLetterQueuePath(queuePath),
    `${JSON.stringify(queueEntryFromBatch(batch, { ...options, status: "dead_letter" }))}\n`,
    { flag: "a" }
  );
}

export async function readQueuedEntries(queuePath = defaultQueuePath()): Promise<QueuedBatchEntry[]> {
  try {
    const raw = await readFile(queuePath, "utf8");
    const entries: QueuedBatchEntry[] = [];
    const corrupt: string[] = [];
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        const entry = entryFromQueueLine(JSON.parse(line));
        if (entry) entries.push(entry);
      } catch {
        corrupt.push(line);
      }
    }
    if (corrupt.length > 0) {
      await writeFile(`${queuePath}.corrupt`, `${corrupt.join("\n")}\n`, { flag: "a" });
    }
    return entries.slice(-MAX_QUEUE_BATCHES);
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function readQueuedBatches(queuePath = defaultQueuePath()): Promise<EventBatch[]> {
  return (await readQueuedEntries(queuePath)).map((entry) => entry.batch);
}

export async function replaceQueueEntries(entries: QueuedBatchEntry[], queuePath = defaultQueuePath()): Promise<void> {
  await mkdir(dirname(queuePath), { recursive: true });
  if (!entries.length) {
    await rm(queuePath, { force: true });
    return;
  }
  const temp = `${queuePath}.tmp`;
  await writeFile(temp, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await rename(temp, queuePath);
}

export async function replaceQueue(batches: EventBatch[], queuePath = defaultQueuePath()): Promise<void> {
  await replaceQueueEntries(batches.map((batch) => queueEntryFromBatch(batch)), queuePath);
}
