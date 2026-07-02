import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { tinyAiQueuePathForTool } from "./config.js";
const MAX_QUEUE_BYTES = Number(process.env.TINYAI_OBS_QUEUE_MAX_BYTES || 1024 * 1024 * 1024);
const MAX_QUEUE_BATCHES = Number(process.env.TINYAI_OBS_QUEUE_MAX_BATCHES || 2000);
function toolFromBatch(batch) {
    return batch?.events?.[0]?.tool;
}
export function defaultQueuePath(tool) {
    return tinyAiQueuePathForTool(tool || process.env.TINYAI_OBS_TOOL);
}
function queueIdFor(batch) {
    const eventIds = (batch.events || []).map((event) => event.event_id).join(":");
    return `${toolFromBatch(batch) || "unknown"}:${eventIds || Date.now()}`;
}
function queueEntryFromBatch(batch, options = {}) {
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
function entryFromQueueLine(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const record = value;
    if (record.schema_version === "tinyai.queue.v2") {
        const batch = record.batch;
        if (!batch || typeof batch !== "object")
            return undefined;
        return {
            schema_version: "tinyai.queue.v2",
            queue_id: typeof record.queue_id === "string" ? record.queue_id : queueIdFor(batch),
            tool: typeof record.tool === "string" ? record.tool : toolFromBatch(batch),
            status: record.status === "dead_letter" ? "dead_letter" : "queued",
            retry_count: typeof record.retry_count === "number" ? record.retry_count : 0,
            first_seen_at: typeof record.first_seen_at === "string" ? record.first_seen_at : new Date().toISOString(),
            last_attempt_at: typeof record.last_attempt_at === "string" ? record.last_attempt_at : new Date().toISOString(),
            next_retry_at: typeof record.next_retry_at === "string" ? record.next_retry_at : undefined,
            last_error: typeof record.last_error === "string" ? record.last_error : undefined,
            error_category: typeof record.error_category === "string" ? record.error_category : "retryable",
            batch: batch
        };
    }
    if (record.events && Array.isArray(record.events)) {
        return queueEntryFromBatch(record);
    }
    return undefined;
}
export async function enqueueBatch(batch, queuePath = defaultQueuePath(toolFromBatch(batch)), options = {}) {
    await mkdir(dirname(queuePath), { recursive: true });
    await writeFile(queuePath, `${JSON.stringify(queueEntryFromBatch(batch, options))}\n`, { flag: "a" });
    const info = await stat(queuePath).catch(() => undefined);
    if (info && info.size > MAX_QUEUE_BYTES) {
        const batches = await readQueuedBatches(queuePath);
        await replaceQueue(batches.slice(-Math.max(1, Math.floor(MAX_QUEUE_BATCHES / 2))), queuePath);
    }
}
export function deadLetterQueuePath(queuePath = defaultQueuePath()) {
    const ext = extname(queuePath);
    return ext ? `${queuePath.slice(0, -ext.length)}.dead-letter${ext}` : `${queuePath}.dead-letter`;
}
export async function deadLetterBatch(batch, queuePath = defaultQueuePath(toolFromBatch(batch)), options = {}) {
    await mkdir(dirname(queuePath), { recursive: true });
    await writeFile(deadLetterQueuePath(queuePath), `${JSON.stringify(queueEntryFromBatch(batch, { ...options, status: "dead_letter" }))}\n`, { flag: "a" });
}
export async function readQueuedEntries(queuePath = defaultQueuePath()) {
    try {
        const raw = await readFile(queuePath, "utf8");
        const entries = [];
        const corrupt = [];
        for (const line of raw.split("\n").filter(Boolean)) {
            try {
                const entry = entryFromQueueLine(JSON.parse(line));
                if (entry)
                    entries.push(entry);
            }
            catch {
                corrupt.push(line);
            }
        }
        if (corrupt.length > 0) {
            await writeFile(`${queuePath}.corrupt`, `${corrupt.join("\n")}\n`, { flag: "a" });
        }
        return entries.slice(-MAX_QUEUE_BATCHES);
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return [];
        throw error;
    }
}
export async function readQueuedBatches(queuePath = defaultQueuePath()) {
    return (await readQueuedEntries(queuePath)).map((entry) => entry.batch);
}
export async function replaceQueueEntries(entries, queuePath = defaultQueuePath()) {
    await mkdir(dirname(queuePath), { recursive: true });
    if (!entries.length) {
        await rm(queuePath, { force: true });
        return;
    }
    const temp = `${queuePath}.tmp`;
    await writeFile(temp, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await rename(temp, queuePath);
}
export async function replaceQueue(batches, queuePath = defaultQueuePath()) {
    await replaceQueueEntries(batches.map((batch) => queueEntryFromBatch(batch)), queuePath);
}
