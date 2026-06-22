#!/usr/bin/env node
import { cwd } from "node:process";
import { CollectorClient } from "./client.js";
import { captureLatestConversation } from "./conversation.js";
import { makeEvent, stableEventId } from "./event-schema.js";
import { commitSnapshot, diffSummary, pushSnapshot, recordAiLineSnapshot } from "./git.js";
async function readStdin() {
    return new Promise((resolve) => {
        let raw = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => (raw += chunk));
        process.stdin.on("end", () => resolve(raw));
    });
}
const tool = (process.env.TINYAI_OBS_TOOL || "claude");
const workspacePath = process.env.TINYAI_OBS_WORKSPACE || cwd();
const eventType = (process.env.TINYAI_OBS_EVENT_TYPE || process.argv[2] || "plugin_heartbeat");
const requireAiMarker = ["1", "true", "yes", "on"].includes(String(process.env.TINYAI_OBS_REQUIRE_AI_MARKER || "").toLowerCase());
const skipUnmarkedCommits = ["1", "true", "yes", "on"].includes(String(process.env.TINYAI_OBS_SKIP_UNMARKED_COMMITS || "").toLowerCase());
const raw = await readStdin();
const payload = raw ? { hook_payload_present: true, hook_payload_bytes: Buffer.byteLength(raw) } : {};
const events = eventType === "commit_snapshot" || eventType === "push_snapshot"
    ? []
    : [makeEvent({ tool, eventType, workspacePath, payload, sourceConfidence: "derived" })];
if (eventType === "task_end" || eventType === "code_change") {
    events.push(makeEvent({ tool, eventType: "code_change", workspacePath, payload: { ...(await diffSummary(workspacePath)) }, sourceConfidence: "derived" }));
}
if (eventType === "ai_line_snapshot") {
    events.length = 0;
    const snapshot = await recordAiLineSnapshot(workspacePath, {
        tool,
        taskId: process.env.TINYAI_OBS_TASK_ID,
        source: "git_pre_commit_hook",
        stagedOnly: ["1", "true", "yes", "on"].includes(String(process.env.TINYAI_OBS_STAGED_ONLY || "").toLowerCase()),
        requireAiMarker
    });
    if (!snapshot.skipped && snapshot.recorded_lines > 0) {
        events.push(makeEvent({
            tool,
            eventType: "ai_line_snapshot",
            workspacePath,
            payload: { ...snapshot, snapshot_kind: "git_pre_commit_hook" },
            sourceConfidence: "derived"
        }));
    }
}
if (eventType === "commit_snapshot") {
    const snapshot = await commitSnapshot(workspacePath, "HEAD", { requireAiMarker });
    if (snapshot.ai_assisted || !skipUnmarkedCommits) {
        events.push(makeEvent({
            tool,
            eventType: "commit_snapshot",
            taskId: process.env.TINYAI_OBS_TASK_ID || (snapshot.commit_sha ? `commit-${snapshot.commit_sha.slice(0, 16)}` : undefined),
            workspacePath,
            payload: { ...snapshot },
            sourceConfidence: "derived",
            eventId: snapshot.commit_sha ? stableEventId(`${tool}:commit_snapshot:${workspacePath}:${snapshot.commit_sha}`) : undefined
        }));
    }
}
if (eventType === "push_snapshot") {
    const snapshot = await pushSnapshot(workspacePath, { requireAiMarker });
    const rangeKey = snapshot.head_sha ? `${snapshot.upstream_ref || ""}:${snapshot.base_sha || ""}:${snapshot.head_sha}` : "";
    if (snapshot.ai_assisted || !skipUnmarkedCommits) {
        events.push(makeEvent({
            tool,
            eventType: "push_snapshot",
            taskId: process.env.TINYAI_OBS_TASK_ID || (snapshot.head_sha ? `push-${snapshot.head_sha.slice(0, 16)}` : undefined),
            workspacePath,
            payload: { ...snapshot },
            sourceConfidence: "derived",
            eventId: rangeKey ? stableEventId(`${tool}:push_snapshot:${workspacePath}:${rangeKey}`) : undefined
        }));
    }
}
if (eventType === "task_end" && ["1", "true", "yes", "on"].includes(String(process.env.TINYAI_OBS_CAPTURE_CONVERSATION_TEXT || "").toLowerCase())) {
    try {
        const snapshot = await captureLatestConversation(tool, { includeText: true });
        events.push(makeEvent({
            tool,
            eventType: "conversation_snapshot",
            sessionId: snapshot.session_id,
            workspacePath,
            payload: { ...snapshot },
            sourceConfidence: "derived"
        }));
    }
    catch (error) {
        events.push(makeEvent({
            tool,
            eventType: "conversation_snapshot",
            workspacePath,
            payload: { include_text: true, capture_error: String(error) },
            sourceConfidence: "inferred"
        }));
    }
}
if (events.length > 0) {
    await new CollectorClient().upload(tool, events);
}
