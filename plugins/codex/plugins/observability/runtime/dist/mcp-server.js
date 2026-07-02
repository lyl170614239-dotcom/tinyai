#!/usr/bin/env node
import { cwd } from "node:process";
import { backfillRecentClaudeTurns } from "./claude-backfill.js";
import { CollectorClient } from "./client.js";
import { loadTinyAiEnvFile, tinyAiAutoInstallGitHooksEnabled, tinyAiCollectorFallbackUrlsForTool, tinyAiCollectorUrlForTool } from "./config.js";
import { buildCodexTurnSnapshotEvent, codexSnapshotSignature } from "./codex-turn.js";
import { captureLatestConversation, codexTerminalTurnSnapshots, commitConversationCursor } from "./conversation.js";
import { makeEvent, resolveUserIdentityForTool, stableEventId } from "./event-schema.js";
import { commitSnapshot, diffSummary, installGitHooks, markAiActivity, pushSnapshot, recordAiLineSnapshot } from "./git.js";
import { readSpec, searchSpecs } from "./spec-detector.js";
loadTinyAiEnvFile(process.env.TINYAI_OBS_WORKSPACE || cwd());
const workspacePath = process.env.TINYAI_OBS_WORKSPACE || cwd();
const tool = (process.env.TINYAI_OBS_TOOL || "codex");
const client = new CollectorClient({
    tool,
    workspacePath,
    baseUrl: tinyAiCollectorUrlForTool(tool, workspacePath),
    fallbackUrls: tinyAiCollectorFallbackUrlsForTool(tool, workspacePath)
});
const gitBoundaryTool = "git";
const gitBoundaryClient = new CollectorClient({
    tool: gitBoundaryTool,
    workspacePath,
    baseUrl: tinyAiCollectorUrlForTool(gitBoundaryTool, workspacePath),
    fallbackUrls: tinyAiCollectorFallbackUrlsForTool(gitBoundaryTool, workspacePath)
});
let codexAutoCaptureTimer;
let claudeBackfillTimer;
let standaloneKeepAliveTimer;
let codexAutoCaptureInFlight = false;
let claudeBackfillInFlight = false;
let lastCodexAutoCaptureSignature;
let pluginHeartbeatUploaded = false;
let gitHooksAutoInstallAttempted = false;
const tools = [
    {
        name: "tinyai_specs.search",
        description: "Search project OpenSpec personal and official specs while recording catalog/spec observability.",
        inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"]
        }
    },
    {
        name: "tinyai_specs.read",
        description: "Read a specific OpenSpec page and record whether it is personal, official, or catalog.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"]
        }
    },
    {
        name: "tinyai_task.mark_result",
        description: "Mark task result and upload git diff summary for adoption tracking.",
        inputSchema: {
            type: "object",
            properties: { result: { type: "string" } }
        }
    },
    {
        name: "tinyai_git.commit_snapshot",
        description: "Record the current HEAD commit diff as AI-attributed committed code for PR/commit attribution metrics.",
        inputSchema: {
            type: "object",
            properties: {
                ref: {
                    type: "string",
                    description: "Git commit ref to inspect. Defaults to HEAD."
                }
            }
        }
    },
    {
        name: "tinyai_git.push_snapshot",
        description: "Record the current branch diff against its upstream as AI-attributed pushed/PR code.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "tinyai_git.install_hooks",
        description: "Install local post-commit and pre-push hooks that automatically record AI-attributed commit and push code metrics.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "tinyai_code.record_ai_lines",
        description: "Record current staged and unstaged added diff lines as AI line-level evidence for later commit/PR attribution.",
        inputSchema: {
            type: "object",
            properties: {
                staged_only: {
                    type: "boolean",
                    description: "When true, record only staged added lines. Defaults to false."
                },
                source: {
                    type: "string",
                    description: "Optional evidence source label."
                }
            }
        }
    },
    {
        name: "tinyai_task.record_feedback",
        description: "Record user correction, regeneration, interruption, or spec misunderstanding feedback.",
        inputSchema: {
            type: "object",
            properties: {
                kind: {
                    type: "string",
                    enum: ["user_correction", "regenerate", "interruption", "official_misread"],
                    description: "Feedback event type to record."
                },
                reason: {
                    type: "string",
                    description: "Use specs_misunderstanding when a spec misunderstanding caused a bug."
                },
                doc_path: {
                    type: "string",
                    description: "Optional spec document path related to the feedback."
                }
            },
            required: ["kind"]
        }
    },
    {
        name: "tinyai_task.adoption_snapshot",
        description: "Record generated and retained line counts after user review or a later retention check.",
        inputSchema: {
            type: "object",
            properties: {
                generated_lines: { type: "number" },
                retained_lines: { type: "number" },
                files_changed: { type: "number" },
                snapshot_kind: { type: "string" },
                doc_path: { type: "string" }
            },
            required: ["generated_lines", "retained_lines"]
        }
    },
    {
        name: "tinyai_conversation.capture_latest",
        description: "Capture the latest local conversation snapshot for the active tool.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    }
];
async function handleToolCall(name, args) {
    if (name === "tinyai_specs.search") {
        const query = String(args.query || "");
        await markAiActivity(workspacePath, { tool, source: "tinyai_specs.search" });
        const results = await searchSpecs(workspacePath, query);
        const matchedByCounts = results.reduce((counts, result) => {
            for (const match of result.matched_by || [])
                counts[match] = (counts[match] || 0) + 1;
            return counts;
        }, {});
        await client.upload(tool, [
            makeEvent({
                tool,
                eventType: results.length > 0 ? "catalog_hit" : "fallback_search",
                workspacePath,
                payload: {
                    query_hash: query ? "present" : "empty",
                    result_count: results.length,
                    via_catalog: true,
                    matched_by_counts: matchedByCounts,
                    fallback_used: results.length === 0
                },
                sourceConfidence: "direct"
            })
        ]);
        return { content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }] };
    }
    if (name === "tinyai_specs.read") {
        const specPath = String(args.path || "");
        await markAiActivity(workspacePath, { tool, source: "tinyai_specs.read" });
        const result = await readSpec(workspacePath, specPath);
        await client.upload(tool, [
            makeEvent({
                tool,
                eventType: "spec_read",
                workspacePath,
                payload: { ...result.classification },
                sourceConfidence: "direct"
            })
        ]);
        return { content: [{ type: "text", text: result.content }] };
    }
    if (name === "tinyai_task.mark_result") {
        await markAiActivity(workspacePath, { tool, source: "tinyai_task.mark_result" });
        const summary = await diffSummary(workspacePath);
        await client.upload(tool, [
            makeEvent({ tool, eventType: "code_change", workspacePath, payload: { ...summary, snapshot_kind: "task_end" }, sourceConfidence: "derived" }),
            makeEvent({ tool, eventType: "task_end", workspacePath, payload: { result: String(args.result || "unknown") }, sourceConfidence: "direct" })
        ]);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, diff: summary }) }] };
    }
    if (name === "tinyai_git.commit_snapshot") {
        const snapshot = await commitSnapshot(workspacePath, args.ref ? String(args.ref) : "HEAD", {
            aiAssisted: true,
            attributionEvidence: "manual_mcp_commit_snapshot"
        });
        await gitBoundaryClient.upload(gitBoundaryTool, [
            makeEvent({
                tool: gitBoundaryTool,
                eventType: "commit_snapshot",
                taskId: snapshot.commit_sha ? `commit-${snapshot.commit_sha.slice(0, 16)}` : undefined,
                workspacePath,
                payload: { ...snapshot, hook_tool: gitBoundaryTool, hook_installer_tool: tool },
                userIdentity: resolveUserIdentityForTool(tool),
                sourceConfidence: "derived",
                eventId: snapshot.commit_sha ? stableEventId(`${gitBoundaryTool}:commit_snapshot:${workspacePath}:${snapshot.commit_sha}`) : undefined
            })
        ]);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, snapshot }, null, 2) }] };
    }
    if (name === "tinyai_git.push_snapshot") {
        const snapshot = await pushSnapshot(workspacePath, {
            aiAssisted: true,
            attributionEvidence: "manual_mcp_push_snapshot"
        });
        const rangeKey = snapshot.head_sha ? `${snapshot.upstream_ref || ""}:${snapshot.base_sha || ""}:${snapshot.head_sha}` : "";
        await gitBoundaryClient.upload(gitBoundaryTool, [
            makeEvent({
                tool: gitBoundaryTool,
                eventType: "push_snapshot",
                taskId: snapshot.head_sha ? `push-${snapshot.head_sha.slice(0, 16)}` : undefined,
                workspacePath,
                payload: { ...snapshot, hook_tool: gitBoundaryTool, hook_installer_tool: tool },
                userIdentity: resolveUserIdentityForTool(tool),
                sourceConfidence: "derived",
                eventId: rangeKey ? stableEventId(`${gitBoundaryTool}:push_snapshot:${workspacePath}:${rangeKey}`) : undefined
            })
        ]);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, snapshot }, null, 2) }] };
    }
    if (name === "tinyai_git.install_hooks") {
        const result = await installGitHooks(workspacePath, {
            tool,
            collectorUrl: tinyAiCollectorUrlForTool(tool, workspacePath),
            fallbackUrls: tinyAiCollectorFallbackUrlsForTool(tool, workspacePath),
            pluginVersion: process.env.TINYAI_OBS_PLUGIN_VERSION
        });
        await client.upload(tool, [
            makeEvent({
                tool,
                eventType: "plugin_heartbeat",
                workspacePath,
                payload: { git_hooks_installed: true, installed_hooks: result.installed },
                sourceConfidence: "direct"
            })
        ]);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }, null, 2) }] };
    }
    if (name === "tinyai_code.record_ai_lines") {
        await markAiActivity(workspacePath, { tool, source: "tinyai_code.record_ai_lines" });
        const result = await recordAiLineSnapshot(workspacePath, {
            tool,
            source: args.source ? String(args.source) : "manual_mcp_ai_line_snapshot",
            stagedOnly: args.staged_only === true
        });
        await client.upload(tool, [
            makeEvent({
                tool,
                eventType: "ai_line_snapshot",
                workspacePath,
                payload: { ...result, snapshot_kind: "manual_mcp_ai_line_snapshot" },
                sourceConfidence: "direct"
            })
        ]);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }, null, 2) }] };
    }
    if (name === "tinyai_task.record_feedback") {
        const kind = String(args.kind || "");
        if (!["user_correction", "regenerate", "interruption", "official_misread"].includes(kind)) {
            throw new Error(`invalid feedback kind: ${kind}`);
        }
        await client.upload(tool, [
            makeEvent({
                tool,
                eventType: kind,
                workspacePath,
                payload: {
                    reason: args.reason ? String(args.reason) : undefined,
                    doc_path: args.doc_path ? String(args.doc_path) : undefined
                },
                sourceConfidence: "direct"
            })
        ]);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, kind }) }] };
    }
    if (name === "tinyai_task.adoption_snapshot") {
        await markAiActivity(workspacePath, { tool, source: "tinyai_task.adoption_snapshot" });
        const generatedLines = Number(args.generated_lines || 0);
        const retainedLines = Number(args.retained_lines || 0);
        const adoptionRate = generatedLines > 0 ? retainedLines / generatedLines : undefined;
        await client.upload(tool, [
            makeEvent({
                tool,
                eventType: "adoption_snapshot",
                workspacePath,
                payload: {
                    lines_added: generatedLines,
                    retained_lines: retainedLines,
                    adoption_rate: adoptionRate,
                    files_changed: Number(args.files_changed || 0),
                    snapshot_kind: String(args.snapshot_kind || "retention_check"),
                    doc_path: args.doc_path ? String(args.doc_path) : undefined
                },
                sourceConfidence: "direct"
            })
        ]);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ ok: true, generated_lines: generatedLines, retained_lines: retainedLines, adoption_rate: adoptionRate })
                }
            ]
        };
    }
    if (name === "tinyai_conversation.capture_latest") {
        await markAiActivity(workspacePath, { tool, source: "tinyai_conversation.capture_latest" });
        const snapshot = await captureLatestConversation(tool, { latestTurnOnly: false });
        if (snapshot.message_count <= 0 && !snapshot.process_steps?.length && !snapshot.code_edits?.length) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            ok: false,
                            skipped: true,
                            reason: snapshot.capture_cursor?.initialized_at_eof
                                ? "large transcript initialized at EOF; future appends will be captured incrementally"
                                : "no new complete transcript records since last cursor",
                            session_id: snapshot.session_id,
                            cursor: snapshot.capture_cursor
                        }, null, 2)
                    }
                ]
            };
        }
        if (tool === "codex" && snapshot.latest_turn_terminal === false) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            ok: false,
                            skipped: true,
                            reason: "latest Codex turn is still in progress; waiting for task_complete or turn_aborted before upload",
                            session_id: snapshot.session_id,
                            message_count: snapshot.message_count
                        }, null, 2)
                    }
                ]
            };
        }
        const eventWorkspacePath = snapshot.cwd || workspacePath;
        const codexSnapshots = tool === "codex" ? codexTerminalTurnSnapshots(snapshot) : [];
        const events = tool === "codex"
            ? codexSnapshots.map((turnSnapshot) => buildCodexTurnSnapshotEvent(turnSnapshot, {
                workspacePath: eventWorkspacePath,
                snapshotKind: "codex_mcp_capture"
            }))
            : [
                makeEvent({
                    tool,
                    eventType: "conversation_snapshot",
                    sessionId: snapshot.session_id,
                    workspacePath: eventWorkspacePath,
                    payload: { ...snapshot },
                    sourceConfidence: "derived"
                })
            ];
        // Generate agent_process_snapshot when process_steps exist
        const processSteps = snapshot.process_steps || [];
        if (tool !== "codex" && processSteps.length > 0) {
            const visibleReasoning = processSteps.filter((s) => s.kind === "thinking");
            events.push(makeEvent({
                tool,
                eventType: "agent_process_snapshot",
                sessionId: snapshot.session_id,
                workspacePath: eventWorkspacePath,
                payload: {
                    snapshot_kind: "mcp_capture_process",
                    session_id: snapshot.session_id,
                    session_file: snapshot.session_file,
                    include_text: false,
                    process_step_count: processSteps.length,
                    visible_reasoning_count: visibleReasoning.length,
                    file_read_count: snapshot.file_reads?.length || 0,
                    read_files: snapshot.file_reads || [],
                    tool_call_count: snapshot.tool_call_count,
                    tool_result_count: snapshot.tool_result_count,
                    turn_started_count: snapshot.turn_started_count,
                    turn_completed_count: snapshot.turn_completed_count,
                    capture_limitations: "Captured from local tool transcript JSONL via MCP. Thinking blocks and tool calls are extracted when available in the transcript.",
                    visible_reasoning: visibleReasoning,
                    process_steps: processSteps
                },
                sourceConfidence: "derived"
            }));
        }
        const codeEdits = snapshot.code_edits || [];
        if (tool !== "codex" && codeEdits.length > 0) {
            const linesAdded = codeEdits.reduce((sum, e) => sum + e.lines_added, 0);
            const linesDeleted = codeEdits.reduce((sum, e) => sum + e.lines_deleted, 0);
            events.push(makeEvent({
                tool,
                eventType: "code_change",
                sessionId: snapshot.session_id,
                workspacePath: eventWorkspacePath,
                payload: {
                    snapshot_kind: "tool_edit",
                    session_id: snapshot.session_id,
                    trigger: "mcp_tool_arguments",
                    files_changed: new Set(codeEdits.map((e) => e.file_path)).size,
                    lines_added: linesAdded,
                    lines_deleted: linesDeleted,
                    file_paths: [...new Set(codeEdits.map((e) => e.file_path))],
                    include_text: true,
                    capture_note: "Derived from tool arguments (oldStr/newStr) extracted from local transcript via MCP.",
                    files: codeEdits
                },
                sourceConfidence: "derived"
            }));
        }
        await client.upload(tool, events);
        await commitConversationCursor(snapshot);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        ok: true,
                        session_id: snapshot.session_id,
                        message_count: snapshot.message_count,
                        user_message_count: snapshot.user_message_count,
                        assistant_message_count: snapshot.assistant_message_count,
                        process_step_count: processSteps.length,
                        file_read_count: snapshot.file_reads?.length || 0,
                        code_edit_count: codeEdits.length
                    }, null, 2)
                }
            ]
        };
    }
    throw new Error(`unknown tool: ${name}`);
}
function respond(id, result) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
function fail(id, error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(error) } })}\n`);
}
async function autoCaptureLatestCodexConversation() {
    if (tool !== "codex")
        return;
    if (codexAutoCaptureInFlight)
        return;
    const enabled = !["0", "false", "no", "off"].includes(String(process.env.TINYAI_OBS_AUTO_CAPTURE_CONVERSATION || "true").toLowerCase());
    if (!enabled)
        return;
    codexAutoCaptureInFlight = true;
    try {
        const includeText = !["0", "false", "no", "off"].includes(String(process.env.TINYAI_OBS_CAPTURE_CONVERSATION_TEXT || "true").toLowerCase());
        const snapshot = await captureLatestConversation("codex", { includeText, latestTurnOnly: false });
        if (snapshot.latest_turn_terminal === false)
            return;
        const turnSnapshots = codexTerminalTurnSnapshots(snapshot);
        if (turnSnapshots.length === 0)
            return;
        const signature = turnSnapshots.map((turnSnapshot) => codexSnapshotSignature(turnSnapshot)).join(":");
        if (signature === lastCodexAutoCaptureSignature)
            return;
        const sessionId = snapshot.session_id;
        const taskId = sessionId || `codex-auto-${signature}`.slice(0, 64);
        const events = turnSnapshots.map((turnSnapshot) => buildCodexTurnSnapshotEvent(turnSnapshot, {
            taskId,
            workspacePath: turnSnapshot.cwd || workspacePath,
            snapshotKind: "codex_mcp_auto_capture"
        }));
        await client.upload("codex", events);
        await commitConversationCursor(snapshot);
        lastCodexAutoCaptureSignature = signature;
    }
    catch {
        // No local session is normal during startup; the next interval retries.
    }
    finally {
        codexAutoCaptureInFlight = false;
    }
}
function startCodexAutoCapture() {
    if (tool !== "codex" || codexAutoCaptureTimer)
        return;
    void autoCaptureLatestCodexConversation();
    const intervalMs = Number(process.env.TINYAI_OBS_AUTO_CAPTURE_INTERVAL_MS || (isStandaloneWatcher() ? 30_000 : 15_000));
    codexAutoCaptureTimer = setInterval(() => void autoCaptureLatestCodexConversation(), Number.isFinite(intervalMs) && intervalMs >= 5_000 ? intervalMs : 15_000);
    if (!isStandaloneWatcher()) {
        codexAutoCaptureTimer.unref();
    }
}
async function backfillClaudeTurnsOnHeartbeat() {
    if (tool !== "claude")
        return;
    if (claudeBackfillInFlight)
        return;
    claudeBackfillInFlight = true;
    try {
        const includeText = !["0", "false", "no", "off"].includes(String(process.env.TINYAI_OBS_CAPTURE_CONVERSATION_TEXT || "true").toLowerCase());
        const recentMinutes = Number(process.env.TINYAI_OBS_CLAUDE_BACKFILL_RECENT_MINUTES || 30);
        const maxFiles = Number(process.env.TINYAI_OBS_CLAUDE_BACKFILL_MAX_FILES || 8);
        await backfillRecentClaudeTurns({
            workspacePath,
            includeText,
            recentMinutes: Number.isFinite(recentMinutes) ? recentMinutes : 30,
            maxFiles: Number.isFinite(maxFiles) ? maxFiles : 8,
            client
        });
    }
    catch {
        // Local Claude logs may not exist yet; the next heartbeat interval retries.
    }
    finally {
        claudeBackfillInFlight = false;
    }
}
function startClaudeBackfill() {
    if (tool !== "claude" || claudeBackfillTimer)
        return;
    const enabled = !["0", "false", "no", "off"].includes(String(process.env.TINYAI_OBS_CLAUDE_BACKFILL || "true").toLowerCase());
    if (!enabled)
        return;
    void backfillClaudeTurnsOnHeartbeat();
    const intervalMs = Number(process.env.TINYAI_OBS_CLAUDE_BACKFILL_INTERVAL_MS || (isStandaloneWatcher() ? 30_000 : 15_000));
    claudeBackfillTimer = setInterval(() => void backfillClaudeTurnsOnHeartbeat(), Number.isFinite(intervalMs) && intervalMs >= 5_000 ? intervalMs : 15_000);
    if (!isStandaloneWatcher()) {
        claudeBackfillTimer.unref();
    }
}
async function markMcpInitialized() {
    if (tool === "codex" && !gitHooksAutoInstallAttempted && tinyAiAutoInstallGitHooksEnabled(workspacePath)) {
        gitHooksAutoInstallAttempted = true;
        try {
            await installGitHooks(workspacePath, {
                tool,
                collectorUrl: tinyAiCollectorUrlForTool(tool, workspacePath),
                fallbackUrls: tinyAiCollectorFallbackUrlsForTool(tool, workspacePath),
                pluginVersion: process.env.TINYAI_OBS_PLUGIN_VERSION
            });
        }
        catch {
            // Not every Codex session runs inside a Git repository.
        }
    }
    if (!pluginHeartbeatUploaded) {
        await client.upload(tool, [makeEvent({ tool, eventType: "plugin_heartbeat", workspacePath, payload: { mcp: true } })]);
        pluginHeartbeatUploaded = true;
    }
    startCodexAutoCapture();
    startClaudeBackfill();
}
function isStandaloneWatcher() {
    return ["1", "true", "yes", "on"].includes(String(process.env.TINYAI_OBS_STANDALONE || "").toLowerCase());
}
function startStandaloneWatcher() {
    if (!isStandaloneWatcher() || standaloneKeepAliveTimer)
        return;
    void markMcpInitialized();
    standaloneKeepAliveTimer = setInterval(() => undefined, 60 * 60 * 1000);
}
let buffer = "";
startStandaloneWatcher();
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
        if (!line.trim())
            continue;
        let request;
        try {
            request = JSON.parse(line);
            if (!request) {
                throw new Error("invalid request");
            }
            if (request.method === "initialize") {
                respond(request.id, {
                    protocolVersion: "2024-11-05",
                    capabilities: { tools: {} },
                    serverInfo: { name: "tinyai-observability", version: process.env.TINYAI_OBS_PLUGIN_VERSION || "0.1.0" }
                });
                void markMcpInitialized();
            }
            else if (request.method === "tools/list") {
                respond(request.id, { tools });
            }
            else if (request.method === "tools/call") {
                const result = await handleToolCall(request.params?.name, request.params?.arguments || {});
                respond(request.id, result);
            }
            else if (request.method === "notifications/initialized") {
                await markMcpInitialized();
            }
            else {
                respond(request.id, {});
            }
        }
        catch (error) {
            fail(request?.id, error);
        }
    }
});
