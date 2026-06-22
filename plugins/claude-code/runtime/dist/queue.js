import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
export function defaultQueuePath() {
    return process.env.TINYAI_OBS_QUEUE || join(homedir(), ".tinyai-observability", "queue.jsonl");
}
export async function enqueueBatch(batch, queuePath = defaultQueuePath()) {
    await mkdir(dirname(queuePath), { recursive: true });
    await writeFile(queuePath, `${JSON.stringify(batch)}\n`, { flag: "a" });
}
export async function readQueuedBatches(queuePath = defaultQueuePath()) {
    try {
        const raw = await readFile(queuePath, "utf8");
        return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
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
    await writeFile(temp, batches.map((batch) => JSON.stringify(batch)).join("\n") + "\n");
    await rename(temp, queuePath);
}
