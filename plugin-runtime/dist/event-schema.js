import { createHash, randomUUID } from "node:crypto";
import { cwd } from "node:process";
const processTaskId = process.env.TINYAI_OBS_TASK_ID || randomUUID();
export function hashWorkspace(workspacePath = cwd()) {
    return createHash("sha256").update(workspacePath).digest("hex").slice(0, 32);
}
export function stableEventId(seed) {
    return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}
export function taskIdFromEnv() {
    return processTaskId;
}
export function clientId(tool) {
    const seed = `${tool}:${process.env.USER || process.env.USERNAME || "unknown"}:${process.env.HOSTNAME || "local"}`;
    return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}
export function makeEvent(input) {
    return {
        event_id: input.eventId || randomUUID(),
        task_id: input.taskId || taskIdFromEnv(),
        session_id: input.sessionId || process.env.TINYAI_OBS_SESSION_ID,
        tool: input.tool,
        event_type: input.eventType,
        occurred_at: new Date().toISOString(),
        workspace_path_hash: hashWorkspace(input.workspacePath),
        payload: input.payload || {},
        source_confidence: input.sourceConfidence || "direct"
    };
}
