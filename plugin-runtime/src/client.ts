import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import type { BatchUploadResult, EventBatch, ObservabilityEvent, ToolName } from "./event-schema.js";
import {
  DEFAULT_COLLECTOR_URL,
  loadTinyAiEnvFile,
  tinyAiCollectorFallbackUrlsForTool,
  tinyAiCollectorUrlForTool,
  tinyAiQueuePathForTool
} from "./config.js";
import { clientId, resolveModel, resolveUserIdentity } from "./event-schema.js";
import { redact } from "./redactor.js";
import { enqueueBatch, readQueuedBatches, replaceQueue, type QueueErrorCategory } from "./queue.js";

loadTinyAiEnvFile();

export interface CollectorClientOptions {
  baseUrl?: string;
  fallbackUrls?: string[];
  token?: string;
  pluginName?: string;
  pluginVersion?: string;
  tool?: ToolName;
  workspacePath?: string;
  queuePath?: string;
}

const TURN_BLOB_INLINE_LIMIT = Number(process.env.TINYAI_OBS_TURN_BLOB_INLINE_LIMIT || 64 * 1024);
const TURN_BLOB_CHUNK_BYTES = Number(process.env.TINYAI_OBS_TURN_BLOB_CHUNK_BYTES || 256 * 1024);
const TURN_TEXT_PREVIEW_CHARS = Number(process.env.TINYAI_OBS_TURN_TEXT_PREVIEW_CHARS || 2000);
const RAW_BLOB_KEYS = new Set([
  "arguments_raw",
  "result_raw",
  "raw_arguments",
  "raw_result",
  "tool_arguments",
  "tool_result",
  "prompt_raw",
  "reasoning_raw",
  "diff_raw",
  "files",
  "hunks",
  "changes",
  "line_attribution"
]);

function defaultPluginNameForTool(tool?: ToolName): string {
  if (tool === "claude") return "tinyai-observability-claude";
  if (tool === "codex") return "tinyai-observability-codex";
  if (tool === "copilot") return "tinyai-observability-vscode";
  return "tinyai-observability";
}

function isLocalCollectorUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31) || (first === 169 && second === 254);
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

function isPrivateNetworkCollectorUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return isLocalCollectorUrl(value) || isPrivateIpv4(hostname) || isPrivateIpv6(hostname);
  } catch {
    return false;
  }
}

export function isCollectorUploadAllowedForUrl(baseUrl: string, token: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (isPrivateNetworkCollectorUrl(baseUrl)) return true;
    return url.protocol === "https:" && Boolean(token.trim());
  } catch {
    return false;
  }
}

function assertCollectorSecurity(baseUrl: string, token: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("collector upload blocked: invalid collector URL");
  }
  if (isPrivateNetworkCollectorUrl(baseUrl)) return;
  if (url.protocol !== "https:") {
    throw new Error("collector upload blocked: public collector must use HTTPS");
  }
  if (!token.trim()) {
    throw new Error("collector upload blocked: public collector requires a bearer token");
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function chunksFor(base64: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < base64.length; index += TURN_BLOB_CHUNK_BYTES) {
    chunks.push(base64.slice(index, index + TURN_BLOB_CHUNK_BYTES));
  }
  return chunks;
}

function blobifyValue(value: unknown, blobKey: string): { ref: Record<string, unknown>; blob: Record<string, unknown> } | undefined {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized === undefined || byteLength(serialized) <= TURN_BLOB_INLINE_LIMIT) return undefined;
  const original = Buffer.from(serialized, "utf8");
  const compressed = gzipSync(original);
  const chunks = chunksFor(compressed.toString("base64"));
  const ref = {
    blob_ref: blobKey,
    encoding: "gzip+base64",
    value_type: typeof value === "string" ? "text" : "json",
    sha256: sha256(original),
    original_bytes: original.length,
    compressed_bytes: compressed.length,
    chunk_count: chunks.length
  };
  return {
    ref,
    blob: {
      blob_key: blobKey,
      ...ref,
      chunks
    }
  };
}

function blobifyTextValue(value: unknown, blobKey: string): { ref: Record<string, unknown>; blob: Record<string, unknown>; hash: string; preview: string; textLen: number } | undefined {
  if (typeof value !== "string" || byteLength(value) <= TURN_BLOB_INLINE_LIMIT) return undefined;
  const blobified = blobifyValue(value, blobKey);
  if (!blobified) return undefined;
  return {
    ...blobified,
    hash: sha256(value),
    preview: value.slice(0, TURN_TEXT_PREVIEW_CHARS),
    textLen: value.length
  };
}

function blobifyTurnPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const blobs: Record<string, unknown>[] = [];
  const visit = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${path}[${index}]`));
    if (!value || typeof value !== "object") return value;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (RAW_BLOB_KEYS.has(key)) {
        const blobified = blobifyValue(child, childPath);
        if (blobified) {
          blobs.push(blobified.blob);
          output[key] = blobified.ref;
          continue;
        }
      }
      if (key === "text") {
        const blobified = blobifyTextValue(child, childPath);
        if (blobified) {
          blobs.push(blobified.blob);
          output.text_preview = blobified.preview;
          output.text_hash = typeof output.text_hash === "string" ? output.text_hash : blobified.hash;
          output.text_len = typeof output.text_len === "number" ? output.text_len : blobified.textLen;
          output.text_blob_ref = blobified.ref;
          continue;
        }
      }
      output[key] = visit(child, childPath);
    }
    return output;
  };
  const rewritten = visit(payload, "") as Record<string, unknown>;
  if (blobs.length > 0) {
    rewritten.raw_event_blobs = blobs;
  }
  return rewritten;
}

function classifyUploadError(error: unknown): QueueErrorCategory {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase();
  if (/\b413\b|payload too large|request entity too large|content too large/.test(message)) return "payload_too_large";
  if (/\b401\b|\b403\b|invalid collector token|requires a bearer token|upload blocked/.test(message)) return "config_error";
  if (/\b400\b|schema|validation/.test(message)) return "schema_error";
  if (/\b429\b|rate limit|too many requests/.test(message)) return "rate_limited";
  if (/\b5\d\d\b|timeout|timed out|econn|enotfound|fetch failed|network/.test(message)) return "retryable";
  return "unknown";
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "collector upload failed");
  return message.slice(0, 500);
}

export class CollectorClient {
  private readonly baseUrl: string;
  private readonly baseUrls: string[];
  private readonly token: string;
  private readonly pluginName: string;
  private readonly pluginVersion: string;
  private readonly tool?: ToolName;
  private readonly queuePath?: string;

  constructor(options: CollectorClientOptions = {}) {
    loadTinyAiEnvFile(options.workspacePath);
    this.tool = options.tool;
    this.baseUrl = options.baseUrl || tinyAiCollectorUrlForTool(options.tool, options.workspacePath);
    this.baseUrls = uniqueCollectorUrls([
      this.baseUrl,
      ...((options.fallbackUrls && options.fallbackUrls.length > 0) ? options.fallbackUrls : tinyAiCollectorFallbackUrlsForTool(options.tool, options.workspacePath)),
      ...splitCollectorUrls(process.env.TINYAI_OBS_COLLECTOR_URLS || "")
    ]);
    this.token = options.token || process.env.TINYAI_OBS_TOKEN || "";
    this.pluginName = options.pluginName || defaultPluginNameForTool(options.tool);
    this.pluginVersion = options.pluginVersion || process.env.TINYAI_OBS_PLUGIN_VERSION || "0.1.0";
    this.queuePath = options.queuePath;
  }

  makeBatch(tool: ToolName, events: ObservabilityEvent[]): EventBatch {
    const identity = resolveUserIdentity(events[0]);
    return {
      client_id: clientId(tool, identity),
      plugin_name: this.pluginName,
      plugin_version: this.pluginVersion,
      ...identity,
      model: resolveModel(),
      events: events.map((event) => ({
        ...event,
        payload:
          event.event_type === "turn_snapshot" || event.event_type === "code_change" || event.event_type === "commit_snapshot" || event.event_type === "push_snapshot"
            ? blobifyTurnPayload(event.payload)
            : redact(event.payload, {
                allowFullConversationText:
                  (event.event_type === "conversation_snapshot" || event.event_type === "agent_process_snapshot") &&
                  event.payload?.include_text === true
              }) as Record<string, unknown>
      }))
    };
  }

  async upload(tool: ToolName, events: ObservabilityEvent[]): Promise<BatchUploadResult> {
    const batch = this.makeBatch(tool, events);
    const queuePath = this.queuePathFor(tool);
    try {
      const result = await this.postBatch(batch);
      await this.flushQueue(tool);
      return result;
    } catch (error) {
      const errorCategory = classifyUploadError(error);
      await enqueueBatch(batch, queuePath, { errorCategory, lastError: safeErrorMessage(error) });
      return {
        accepted: 0,
        duplicates: 0,
        failed: 0,
        task_count: new Set(events.map((event) => event.task_id)).size,
        queued: true,
        events: events.map((event) => ({
          event_id: event.event_id,
          event_type: event.event_type,
          status: "failed",
          reason: errorCategory
        }))
      };
    }
  }

  async flushQueue(tool = this.tool): Promise<{ sent: number; remaining: number }> {
    const queuePath = this.queuePathFor(tool);
    const queued = await readQueuedBatches(queuePath);
    const remaining: EventBatch[] = [];
    let sent = 0;
    for (const batch of queued) {
      try {
        const result = await this.postBatch(batch);
        sent += result.accepted + result.duplicates;
      } catch {
        remaining.push(batch);
      }
    }
    await replaceQueue(remaining, queuePath);
    return { sent, remaining: remaining.length };
  }

  private queuePathFor(tool?: ToolName): string {
    return this.queuePath || tinyAiQueuePathForTool(tool || this.tool);
  }

  private async postBatch(batch: EventBatch): Promise<BatchUploadResult> {
    let lastError: unknown;
    for (const baseUrl of this.baseUrls) {
      try {
        return await this.postBatchToUrl(baseUrl, batch);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || "collector upload failed"));
  }

  private async postBatchToUrl(baseUrl: string, batch: EventBatch): Promise<BatchUploadResult> {
    assertCollectorSecurity(baseUrl, this.token);
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/events/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      throw new Error(`collector upload failed: ${response.status} ${await response.text()}`);
    }
    return await response.json() as BatchUploadResult;
  }
}

function splitCollectorUrls(value: string): string[] {
  return value.split(/[,\s]+/).map((url) => url.trim()).filter(Boolean);
}

function uniqueCollectorUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of urls) {
    const url = raw.trim().replace(/\/$/, "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    output.push(url);
  }
  return output.length > 0 ? output : [DEFAULT_COLLECTOR_URL];
}
