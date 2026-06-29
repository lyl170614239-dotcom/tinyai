import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { tinyAiQueuePathForTool } from "./config.js";
import type { EventBatch, ToolName } from "./event-schema.js";

const MAX_QUEUE_BYTES = Number(process.env.TINYAI_OBS_QUEUE_MAX_BYTES || 1024 * 1024 * 1024);
const MAX_QUEUE_BATCHES = Number(process.env.TINYAI_OBS_QUEUE_MAX_BATCHES || 2000);

function toolFromBatch(batch?: EventBatch): ToolName | undefined {
  return batch?.events?.[0]?.tool;
}

export function defaultQueuePath(tool?: ToolName | string): string {
  return tinyAiQueuePathForTool(tool || process.env.TINYAI_OBS_TOOL);
}

export async function enqueueBatch(batch: EventBatch, queuePath = defaultQueuePath(toolFromBatch(batch))): Promise<void> {
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(queuePath, `${JSON.stringify(batch)}\n`, { flag: "a" });
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
        batches.push(JSON.parse(line) as EventBatch);
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
  await writeFile(temp, batches.map((batch) => JSON.stringify(batch)).join("\n") + "\n");
  await rename(temp, queuePath);
}
