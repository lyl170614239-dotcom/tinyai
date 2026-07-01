import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
function batchFromQueueLine(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const record = value;
    if (record.schema_version === "tinyai.queue.v2") {
        const batch = record.batch;
        return batch && typeof batch === "object" ? batch : undefined;
    }
    return record.events && Array.isArray(record.events) ? record : undefined;
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
export async function readQueuedBatches(queuePath = defaultQueuePath()) {
    try {
        const raw = await readFile(queuePath, "utf8");
        const batches = [];
        const corrupt = [];
        for (const line of raw.split("\n").filter(Boolean)) {
            try {
                const batch = batchFromQueueLine(JSON.parse(line));
                if (batch)
                    batches.push(batch);
            }
            catch {
                corrupt.push(line);
            }
        }
        if (corrupt.length > 0) {
            await writeFile(`${queuePath}.corrupt`, `${corrupt.join("\n")}\n`, { flag: "a" });
        }
        return batches.slice(-MAX_QUEUE_BATCHES);
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return [];
        throw error;
    }
}
export async function replaceQueue(batches, queuePath = defaultQueuePath()) {
    await mkdir(dirname(queuePath), { recursive: true });
    if (!batches.length) {
        await rm(queuePath, { force: true });
        return;
    }
    const temp = `${queuePath}.tmp`;
    await writeFile(temp, batches.map((batch) => JSON.stringify(queueEntryFromBatch(batch))).join("\n") + "\n");
    await rename(temp, queuePath);
}
