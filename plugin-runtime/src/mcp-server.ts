#!/usr/bin/env node
import { cwd } from "node:process";
import { CollectorClient } from "./client.js";
import { captureLatestConversation } from "./conversation.js";
import { makeEvent, stableEventId, type ToolName } from "./event-schema.js";
import { commitSnapshot, diffSummary, installGitHooks, markAiActivity, pushSnapshot, recordAiLineSnapshot } from "./git.js";
import { readSpec, searchSpecs } from "./spec-detector.js";

const workspacePath = process.env.TINYAI_OBS_WORKSPACE || cwd();
const tool = (process.env.TINYAI_OBS_TOOL || "codex") as ToolName;
const client = new CollectorClient();

type JsonRpcRequest = { jsonrpc?: string; id?: string | number; method: string; params?: any };

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
          enum: ["user_correction", "regenerate", "interruption"],
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
    description: "Capture the latest local conversation snapshot for the active tool. Text is omitted unless include_text is true.",
    inputSchema: {
      type: "object",
      properties: {
        include_text: {
          type: "boolean",
          description: "Upload redacted message text when true. Defaults to false and uploads only role, length, and hash."
        }
      }
    }
  }
];

async function handleToolCall(name: string, args: Record<string, unknown>) {
  if (name === "tinyai_specs.search") {
    const query = String(args.query || "");
    await markAiActivity(workspacePath, { tool, source: "tinyai_specs.search" });
    const results = await searchSpecs(workspacePath, query);
    const matchedByCounts = results.reduce<Record<string, number>>((counts, result) => {
      for (const match of result.matched_by || []) counts[match] = (counts[match] || 0) + 1;
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
        eventType: result.classification.spec_scope === "official" ? "official_misread" : "spec_read",
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
    await client.upload(tool, [
      makeEvent({
        tool,
        eventType: "commit_snapshot",
        taskId: snapshot.commit_sha ? `commit-${snapshot.commit_sha.slice(0, 16)}` : undefined,
        workspacePath,
        payload: { ...snapshot },
        sourceConfidence: "derived",
        eventId: snapshot.commit_sha ? stableEventId(`${tool}:commit_snapshot:${workspacePath}:${snapshot.commit_sha}`) : undefined
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
    await client.upload(tool, [
      makeEvent({
        tool,
        eventType: "push_snapshot",
        taskId: snapshot.head_sha ? `push-${snapshot.head_sha.slice(0, 16)}` : undefined,
        workspacePath,
        payload: { ...snapshot },
        sourceConfidence: "derived",
        eventId: rangeKey ? stableEventId(`${tool}:push_snapshot:${workspacePath}:${rangeKey}`) : undefined
      })
    ]);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, snapshot }, null, 2) }] };
  }
  if (name === "tinyai_git.install_hooks") {
    const result = await installGitHooks(workspacePath, { tool, pluginVersion: process.env.TINYAI_OBS_PLUGIN_VERSION });
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
    if (!["user_correction", "regenerate", "interruption"].includes(kind)) {
      throw new Error(`invalid feedback kind: ${kind}`);
    }
    await client.upload(tool, [
      makeEvent({
        tool,
        eventType: kind as "user_correction" | "regenerate" | "interruption",
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
    const includeText =
      typeof args.include_text === "boolean"
        ? args.include_text
        : ["1", "true", "yes", "on"].includes(String(process.env.TINYAI_OBS_CAPTURE_CONVERSATION_TEXT || "").toLowerCase());
    const snapshot = await captureLatestConversation(tool, { includeText });
    await client.upload(tool, [
      makeEvent({
        tool,
        eventType: "conversation_snapshot",
        sessionId: snapshot.session_id,
        workspacePath,
        payload: { ...snapshot },
        sourceConfidence: "derived"
      })
    ]);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              session_id: snapshot.session_id,
              message_count: snapshot.message_count,
              user_message_count: snapshot.user_message_count,
              assistant_message_count: snapshot.assistant_message_count,
              include_text: snapshot.include_text
            },
            null,
            2
          )
        }
      ]
    };
  }
  throw new Error(`unknown tool: ${name}`);
}

function respond(id: string | number | undefined, result: unknown) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id: string | number | undefined, error: unknown) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(error) } })}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let request: JsonRpcRequest | undefined;
    try {
      request = JSON.parse(line);
      if (!request) {
        throw new Error("invalid request");
      }
      if (request.method === "initialize") {
        respond(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "tinyai-observability", version: "0.1.0" } });
      } else if (request.method === "tools/list") {
        respond(request.id, { tools });
      } else if (request.method === "tools/call") {
        const result = await handleToolCall(request.params?.name, request.params?.arguments || {});
        respond(request.id, result);
      } else if (request.method === "notifications/initialized") {
        await client.upload(tool, [makeEvent({ tool, eventType: "plugin_heartbeat", workspacePath, payload: { mcp: true } })]);
      } else {
        respond(request.id, {});
      }
    } catch (error) {
      fail(request?.id, error);
    }
  }
});
