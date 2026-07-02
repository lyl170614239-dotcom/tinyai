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
export function clientId(tool, overrides = {}) {
    const identity = resolveUserIdentity(overrides);
    const seed = `${tool}:${identity.user_id || identity.user_display_name || identity.username}:${identity.machine_id || identity.host_hash || "local"}`;
    return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}
export function resolveUsername() {
    return process.env.USER || process.env.USERNAME || "unknown";
}
function clean(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
function usableUserId(value) {
    const cleaned = clean(value);
    if (!cleaned)
        return undefined;
    const lowered = cleaned.toLowerCase();
    if (lowered === "unknown" || lowered === "user" || lowered === "null" || lowered === "none")
        return undefined;
    if (cleaned.includes("@"))
        return undefined;
    return cleaned;
}
function normalizeToolEnvName(tool) {
    const normalized = tool?.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return normalized || undefined;
}
function toolEnvValue(suffix) {
    return toolEnvValueForTool(process.env.TINYAI_OBS_TOOL, suffix);
}
function toolEnvValueForTool(toolName, suffix) {
    const tool = normalizeToolEnvName(toolName);
    if (tool) {
        const value = clean(process.env[`TINYAI_OBS_${tool}_${suffix}`]);
        if (value)
            return value;
    }
    return clean(process.env[`TINYAI_OBS_${suffix}`]);
}
export function resolveUserIdentity(overrides = {}) {
    return resolveUserIdentityForTool(process.env.TINYAI_OBS_TOOL, overrides);
}
export function resolveUserIdentityForTool(toolName, overrides = {}) {
    const userDisplayName = clean(overrides.user_display_name) ||
        toolEnvValueForTool(toolName, "USER_DISPLAY_NAME") ||
        toolEnvValueForTool(toolName, "USER_NAME");
    const username = clean(overrides.username) || toolEnvValueForTool(toolName, "USERNAME") || userDisplayName || resolveUsername();
    const explicitUserId = clean(overrides.user_id) || toolEnvValueForTool(toolName, "USER_ID");
    const userId = usableUserId(explicitUserId) ||
        usableUserId(username) ||
        usableUserId(userDisplayName) ||
        username;
    const hostname = clean(process.env.HOSTNAME) || "local";
    return {
        username,
        user_id: userId,
        user_display_name: userDisplayName,
        team: clean(overrides.team) || clean(process.env.TINYAI_OBS_TEAM),
        machine_id: clean(overrides.machine_id) || clean(process.env.TINYAI_OBS_MACHINE_ID),
        host_hash: clean(overrides.host_hash) || createHash("sha256").update(hostname).digest("hex").slice(0, 32)
    };
}
export function resolveModel() {
    return (process.env.TINYAI_OBS_MODEL ||
        process.env.CLAUDE_CODE_MODEL ||
        process.env.OPENAI_MODEL ||
        undefined);
}
export function makeEvent(input) {
    const identity = resolveUserIdentity(input.userIdentity);
    return {
        event_id: input.eventId || randomUUID(),
        task_id: input.taskId || taskIdFromEnv(),
        session_id: input.sessionId || process.env.TINYAI_OBS_SESSION_ID,
        tool: input.tool,
        event_type: input.eventType,
        occurred_at: new Date().toISOString(),
        workspace_path_hash: hashWorkspace(input.workspacePath),
        payload: input.payload || {},
        source_confidence: input.sourceConfidence || "direct",
        ...identity,
        model: input.model ?? resolveModel()
    };
}
