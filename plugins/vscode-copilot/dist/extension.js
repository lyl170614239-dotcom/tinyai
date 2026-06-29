// src/extension.ts
import * as vscode from "vscode";
import { execFileSync } from "node:child_process";
import { createHash as createHash6, randomUUID as randomUUID2 } from "node:crypto";
import { readdir as readdir3, readFile as readFile5, stat as stat3 } from "node:fs/promises";
import { homedir as homedir3, hostname } from "node:os";
import { basename as basename2, dirname as dirname3, join as join5 } from "node:path";

// ../../plugin-runtime/dist/client.js
import { createHash as createHash2 } from "node:crypto";
import { gzipSync } from "node:zlib";

// ../../plugin-runtime/dist/config.js
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cwd } from "node:process";
var DEFAULT_TINYAI_ENV_FILE = join(homedir(), ".tinyai-observability", "tinyai-observability.env");
var DEFAULT_COLLECTOR_URL = "http://10.161.248.133:18080";
var DEFAULT_COLLECTOR_FALLBACK_URLS = [];
var DEFAULT_DASHBOARD_URL = "http://10.161.248.133:18081";
var DEFAULT_DASHBOARD_FALLBACK_URLS = [];
var LEGACY_DEFAULT_URLS = /* @__PURE__ */ new Set([
  "http://192.168.215.94:18080",
  "http://192.168.215.94:18080/",
  "http://192.168.215.94:18081",
  "http://192.168.215.94:18081/",
  "http://10.161.248.127:18080",
  "http://10.161.248.127:18080/",
  "http://10.161.248.127:18081",
  "http://10.161.248.127:18081/"
]);
var cachedEnvFile;
var cachedEnvMtimeMs;
var cachedEnv;
var loadedEnvValues = /* @__PURE__ */ new Map();
function stripQuotes(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
function cleanConfiguredValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || /^\$\{[A-Z0-9_]+\}$/.test(trimmed))
    return void 0;
  if (LEGACY_DEFAULT_URLS.has(trimmed))
    return void 0;
  return trimmed;
}
function parseTinyAiEnv(content) {
  const env2 = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#"))
      continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0)
      continue;
    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^TINYAI_OBS_[A-Z0-9_]+$/.test(key))
      continue;
    const value = stripQuotes(normalized.slice(equalsIndex + 1));
    env2[key] = value;
  }
  return env2;
}
function resolveTinyAiEnvFile(workspacePath2) {
  const explicit = cleanConfiguredValue(process.env.TINYAI_OBS_ENV_FILE);
  if (explicit)
    return resolve(explicit.replace(/^file:\/\//, ""));
  const localWorkspaceFile = workspacePath2 ? join(workspacePath2, ".tinyai-observability.env") : "";
  if (localWorkspaceFile && existsSync(localWorkspaceFile))
    return localWorkspaceFile;
  const localCwdFile = join(cwd(), ".tinyai-observability.env");
  if (existsSync(localCwdFile))
    return localCwdFile;
  return DEFAULT_TINYAI_ENV_FILE;
}
function readTinyAiEnvFile(workspacePath2) {
  const path = resolveTinyAiEnvFile(workspacePath2);
  if (!existsSync(path))
    return { path, values: {}, exists: false };
  const mtimeMs = statSync(path).mtimeMs;
  if (cachedEnv && cachedEnvFile === path && cachedEnvMtimeMs === mtimeMs)
    return { path, values: cachedEnv, exists: true };
  const values = parseTinyAiEnv(readFileSync(path, "utf8"));
  cachedEnvFile = path;
  cachedEnvMtimeMs = mtimeMs;
  cachedEnv = values;
  return { path, values, exists: true };
}
function loadTinyAiEnvFile(workspacePath2) {
  const result = readTinyAiEnvFile(workspacePath2);
  for (const [key, value] of Object.entries(result.values)) {
    const previousLoadedValue = loadedEnvValues.get(key);
    if (!cleanConfiguredValue(process.env[key]) || process.env[key] === previousLoadedValue) {
      process.env[key] = value;
      loadedEnvValues.set(key, value);
    }
  }
  return result;
}
function tinyAiEnvValue(key, workspacePath2) {
  return cleanConfiguredValue(process.env[key]) || cleanConfiguredValue(readTinyAiEnvFile(workspacePath2).values[key]);
}
function normalizeToolName(tool) {
  const normalized = String(tool || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || void 0;
}
function tinyAiToolEnvValue(tool, suffix, workspacePath2) {
  const normalizedTool = normalizeToolName(tool);
  const normalizedSuffix = suffix.replace(/^TINYAI_OBS_/, "").replace(/^_+/, "");
  if (normalizedTool) {
    const toolValue = tinyAiEnvValue(`TINYAI_OBS_${normalizedTool}_${normalizedSuffix}`, workspacePath2);
    if (toolValue)
      return toolValue;
  }
  return tinyAiEnvValue(`TINYAI_OBS_${normalizedSuffix}`, workspacePath2);
}
function splitTinyAiUrls(value) {
  return String(value || "").split(/[,\s]+/).map((url) => url.trim().replace(/\/$/, "")).filter(Boolean);
}
function tinyAiCollectorUrlForTool(tool, workspacePath2) {
  return tinyAiToolEnvValue(tool, "COLLECTOR_URL", workspacePath2) || DEFAULT_COLLECTOR_URL;
}
function tinyAiCollectorFallbackUrlsForTool(tool, workspacePath2) {
  const configured = splitTinyAiUrls(tinyAiToolEnvValue(tool, "COLLECTOR_URLS", workspacePath2));
  return configured.length > 0 ? configured : DEFAULT_COLLECTOR_FALLBACK_URLS;
}
function tinyAiDashboardFallbackUrlsForTool(tool, workspacePath2) {
  const configured = splitTinyAiUrls(tinyAiToolEnvValue(tool, "DASHBOARD_URLS", workspacePath2));
  return configured.length > 0 ? configured : DEFAULT_DASHBOARD_FALLBACK_URLS;
}
function tinyAiQueuePathForTool(tool, workspacePath2) {
  const configured = tinyAiToolEnvValue(tool, "QUEUE", workspacePath2);
  if (configured)
    return resolve(configured.replace(/^file:\/\//, ""));
  const normalizedTool = String(tool || "unknown").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  return join(homedir(), ".tinyai-observability", `queue-${normalizedTool}.jsonl`);
}

// ../../plugin-runtime/dist/event-schema.js
import { createHash, randomUUID } from "node:crypto";
import { cwd as cwd2 } from "node:process";
var processTaskId = process.env.TINYAI_OBS_TASK_ID || randomUUID();
function hashWorkspace(workspacePath2 = cwd2()) {
  return createHash("sha256").update(workspacePath2).digest("hex").slice(0, 32);
}
function stableEventId(seed) {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}
function taskIdFromEnv() {
  return processTaskId;
}
function clientId(tool, overrides = {}) {
  const identity = resolveUserIdentity(overrides);
  const seed = `${tool}:${identity.user_id || identity.user_email || identity.user_display_name || identity.username}:${identity.machine_id || identity.host_hash || "local"}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}
function resolveUsername() {
  return process.env.USER || process.env.USERNAME || "unknown";
}
function clean(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : void 0;
}
function resolveUserIdentity(overrides = {}) {
  const userEmail = clean(overrides.user_email) || clean(process.env.TINYAI_OBS_USER_EMAIL);
  const userDisplayName = clean(overrides.user_display_name) || clean(process.env.TINYAI_OBS_USER_DISPLAY_NAME) || clean(process.env.TINYAI_OBS_USER_NAME);
  const username = clean(overrides.username) || clean(process.env.TINYAI_OBS_USERNAME) || userDisplayName || resolveUsername();
  const userId = clean(overrides.user_id) || clean(process.env.TINYAI_OBS_USER_ID) || userEmail || userDisplayName || username;
  const hostname2 = clean(process.env.HOSTNAME) || "local";
  return {
    username,
    user_id: userId,
    user_email: userEmail,
    user_display_name: userDisplayName,
    team: clean(overrides.team) || clean(process.env.TINYAI_OBS_TEAM),
    machine_id: clean(overrides.machine_id) || clean(process.env.TINYAI_OBS_MACHINE_ID),
    host_hash: clean(overrides.host_hash) || createHash("sha256").update(hostname2).digest("hex").slice(0, 32)
  };
}
function resolveModel() {
  return process.env.TINYAI_OBS_MODEL || process.env.CLAUDE_CODE_MODEL || process.env.OPENAI_MODEL || void 0;
}
function makeEvent(input) {
  const identity = resolveUserIdentity(input.userIdentity);
  return {
    event_id: input.eventId || randomUUID(),
    task_id: input.taskId || taskIdFromEnv(),
    session_id: input.sessionId || process.env.TINYAI_OBS_SESSION_ID,
    tool: input.tool,
    event_type: input.eventType,
    occurred_at: (/* @__PURE__ */ new Date()).toISOString(),
    workspace_path_hash: hashWorkspace(input.workspacePath),
    payload: input.payload || {},
    source_confidence: input.sourceConfidence || "direct",
    ...identity,
    model: input.model ?? resolveModel()
  };
}

// ../../plugin-runtime/dist/redactor.js
var SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{20,}/g,
  /(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[^'"\s]+/gi
];
var BLOCKED_KEYS = /* @__PURE__ */ new Set(["prompt", "message", "content", "answer", "code", "env", "dotenv"]);
function redactText(value, options = {}) {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  if (options.allowFullConversationText)
    return redacted;
  return redacted.length > 2048 ? `${redacted.slice(0, 2048)}...[truncated]` : redacted;
}
function redact(value, options = {}) {
  if (typeof value === "string")
    return redactText(value, options);
  if (Array.isArray(value)) {
    const items = options.allowFullConversationText ? value : value.slice(0, 50);
    return items.map((item) => redact(item, options));
  }
  if (value && typeof value === "object") {
    const output = {};
    const entries = Object.entries(value);
    const selectedEntries = options.allowFullConversationText ? entries : entries.slice(0, 80);
    for (const [key, item] of selectedEntries) {
      output[key] = BLOCKED_KEYS.has(key.toLowerCase()) && !options.allowFullConversationText ? "[REDACTED]" : redact(item, options);
    }
    return output;
  }
  return value;
}

// ../../plugin-runtime/dist/queue.js
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
var MAX_QUEUE_BYTES = Number(process.env.TINYAI_OBS_QUEUE_MAX_BYTES || 1024 * 1024 * 1024);
var MAX_QUEUE_BATCHES = Number(process.env.TINYAI_OBS_QUEUE_MAX_BATCHES || 2e3);
function toolFromBatch(batch) {
  return batch?.events?.[0]?.tool;
}
function defaultQueuePath(tool) {
  return tinyAiQueuePathForTool(tool || process.env.TINYAI_OBS_TOOL);
}
async function enqueueBatch(batch, queuePath = defaultQueuePath(toolFromBatch(batch))) {
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(queuePath, `${JSON.stringify(batch)}
`, { flag: "a" });
  const info = await stat(queuePath).catch(() => void 0);
  if (info && info.size > MAX_QUEUE_BYTES) {
    const batches = await readQueuedBatches(queuePath);
    await replaceQueue(batches.slice(-Math.max(1, Math.floor(MAX_QUEUE_BATCHES / 2))), queuePath);
  }
}
async function readQueuedBatches(queuePath = defaultQueuePath()) {
  try {
    const raw = await readFile(queuePath, "utf8");
    const batches = [];
    const corrupt = [];
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        batches.push(JSON.parse(line));
      } catch {
        corrupt.push(line);
      }
    }
    if (corrupt.length > 0) {
      await writeFile(`${queuePath}.corrupt`, `${corrupt.join("\n")}
`, { flag: "a" });
    }
    return batches.slice(-MAX_QUEUE_BATCHES);
  } catch (error) {
    if (error?.code === "ENOENT")
      return [];
    throw error;
  }
}
async function replaceQueue(batches, queuePath = defaultQueuePath()) {
  await mkdir(dirname(queuePath), { recursive: true });
  if (!batches.length) {
    await rm(queuePath, { force: true });
    return;
  }
  const temp = `${queuePath}.tmp`;
  await writeFile(temp, batches.map((batch) => JSON.stringify(batch)).join("\n") + "\n");
  await rename(temp, queuePath);
}

// ../../plugin-runtime/dist/client.js
loadTinyAiEnvFile();
var TURN_BLOB_INLINE_LIMIT = Number(process.env.TINYAI_OBS_TURN_BLOB_INLINE_LIMIT || 64 * 1024);
var TURN_BLOB_CHUNK_BYTES = Number(process.env.TINYAI_OBS_TURN_BLOB_CHUNK_BYTES || 256 * 1024);
var RAW_BLOB_KEYS = /* @__PURE__ */ new Set([
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
function isLocalCollectorUrl(value) {
  try {
    const url = new URL(value);
    const hostname2 = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname2 === "localhost" || hostname2 === "127.0.0.1" || hostname2 === "::1";
  } catch {
    return false;
  }
}
function isPrivateIpv4(hostname2) {
  const parts = hostname2.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const [first, second] = parts;
  return first === 10 || first === 192 && second === 168 || first === 172 && second >= 16 && second <= 31 || first === 169 && second === 254;
}
function isPrivateIpv6(hostname2) {
  const normalized = hostname2.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}
function isPrivateNetworkCollectorUrl(value) {
  try {
    const url = new URL(value);
    const hostname2 = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return isLocalCollectorUrl(value) || isPrivateIpv4(hostname2) || isPrivateIpv6(hostname2);
  } catch {
    return false;
  }
}
function assertCollectorSecurity(baseUrl, token) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("collector upload blocked: invalid collector URL");
  }
  if (isPrivateNetworkCollectorUrl(baseUrl))
    return;
  if (url.protocol !== "https:") {
    throw new Error("collector upload blocked: public collector must use HTTPS");
  }
  if (!token.trim()) {
    throw new Error("collector upload blocked: public collector requires a bearer token");
  }
}
function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}
function sha256(value) {
  return createHash2("sha256").update(value).digest("hex");
}
function chunksFor(base64) {
  const chunks = [];
  for (let index = 0; index < base64.length; index += TURN_BLOB_CHUNK_BYTES) {
    chunks.push(base64.slice(index, index + TURN_BLOB_CHUNK_BYTES));
  }
  return chunks;
}
function blobifyValue(value, blobKey) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized === void 0 || byteLength(serialized) <= TURN_BLOB_INLINE_LIMIT)
    return void 0;
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
function blobifyTurnPayload(payload) {
  const blobs = [];
  const visit = (value, path) => {
    if (Array.isArray(value))
      return value.map((item, index) => visit(item, `${path}[${index}]`));
    if (!value || typeof value !== "object")
      return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (RAW_BLOB_KEYS.has(key)) {
        const blobified = blobifyValue(child, childPath);
        if (blobified) {
          blobs.push(blobified.blob);
          output[key] = blobified.ref;
          continue;
        }
      }
      output[key] = visit(child, childPath);
    }
    return output;
  };
  const rewritten = visit(payload, "");
  if (blobs.length > 0) {
    rewritten.raw_event_blobs = blobs;
  }
  return rewritten;
}
var CollectorClient = class {
  baseUrl;
  baseUrls;
  token;
  pluginName;
  pluginVersion;
  tool;
  queuePath;
  constructor(options = {}) {
    loadTinyAiEnvFile(options.workspacePath);
    this.tool = options.tool;
    this.baseUrl = options.baseUrl || tinyAiCollectorUrlForTool(options.tool, options.workspacePath);
    this.baseUrls = uniqueCollectorUrls([
      this.baseUrl,
      ...options.fallbackUrls && options.fallbackUrls.length > 0 ? options.fallbackUrls : tinyAiCollectorFallbackUrlsForTool(options.tool, options.workspacePath),
      ...splitCollectorUrls(process.env.TINYAI_OBS_COLLECTOR_URLS || "")
    ]);
    this.token = options.token || process.env.TINYAI_OBS_TOKEN || "";
    this.pluginName = options.pluginName || "tinyai-observability";
    this.pluginVersion = options.pluginVersion || process.env.TINYAI_OBS_PLUGIN_VERSION || "0.1.0";
    this.queuePath = options.queuePath;
  }
  makeBatch(tool, events) {
    const identity = resolveUserIdentity(events[0]);
    return {
      client_id: clientId(tool, identity),
      plugin_name: this.pluginName,
      plugin_version: this.pluginVersion,
      ...identity,
      model: resolveModel(),
      events: events.map((event2) => ({
        ...event2,
        payload: event2.event_type === "turn_snapshot" || event2.event_type === "code_change" || event2.event_type === "commit_snapshot" || event2.event_type === "push_snapshot" ? blobifyTurnPayload(event2.payload) : redact(event2.payload, {
          allowFullConversationText: (event2.event_type === "conversation_snapshot" || event2.event_type === "agent_process_snapshot") && event2.payload?.include_text === true
        })
      }))
    };
  }
  async upload(tool, events) {
    const batch = this.makeBatch(tool, events);
    const queuePath = this.queuePathFor(tool);
    try {
      const result = await this.postBatch(batch);
      await this.flushQueue(tool);
      return result;
    } catch {
      await enqueueBatch(batch, queuePath);
      return {
        accepted: 0,
        duplicates: 0,
        failed: 0,
        task_count: new Set(events.map((event2) => event2.task_id)).size,
        queued: true,
        events: events.map((event2) => ({
          event_id: event2.event_id,
          event_type: event2.event_type,
          status: "failed",
          reason: "queued_for_retry"
        }))
      };
    }
  }
  async flushQueue(tool = this.tool) {
    const queuePath = this.queuePathFor(tool);
    const queued = await readQueuedBatches(queuePath);
    const remaining = [];
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
  queuePathFor(tool) {
    return this.queuePath || tinyAiQueuePathForTool(tool || this.tool);
  }
  async postBatch(batch) {
    let lastError;
    for (const baseUrl of this.baseUrls) {
      try {
        return await this.postBatchToUrl(baseUrl, batch);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || "collector upload failed"));
  }
  async postBatchToUrl(baseUrl, batch) {
    assertCollectorSecurity(baseUrl, this.token);
    const headers = {
      "content-type": "application/json"
    };
    if (this.token)
      headers.authorization = `Bearer ${this.token}`;
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/events/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(1e4)
    });
    if (!response.ok) {
      throw new Error(`collector upload failed: ${response.status} ${await response.text()}`);
    }
    return await response.json();
  }
};
function splitCollectorUrls(value) {
  return value.split(/[,\s]+/).map((url) => url.trim()).filter(Boolean);
}
function uniqueCollectorUrls(urls) {
  const seen = /* @__PURE__ */ new Set();
  const output = [];
  for (const raw of urls) {
    const url = raw.trim().replace(/\/$/, "");
    if (!url || seen.has(url))
      continue;
    seen.add(url);
    output.push(url);
  }
  return output.length > 0 ? output : [DEFAULT_COLLECTOR_URL];
}

// ../../plugin-runtime/dist/claude-turn.js
import { createHash as createHash3 } from "node:crypto";
import { homedir as homedir2 } from "node:os";
import { basename, join as join2 } from "node:path";
import { readdir, readFile as readFile2, stat as stat2 } from "node:fs/promises";
var CLAUDE_TURN_PARSER_VERSION = "claude-turn-v1.0.2";
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function array(value) {
  return Array.isArray(value) ? value : [];
}
function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function hashText(value) {
  return createHash3("sha256").update(value).digest("hex");
}
function hashJson(value) {
  return hashText(JSON.stringify(value ?? null));
}
function isoTimestamp(value) {
  if (typeof value !== "string" || !value.trim())
    return void 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
function isRealUserPrompt(entry) {
  if (entry.type !== "user" || entry.isMeta === true)
    return false;
  const message = record(entry.message);
  if (message?.role !== "user")
    return false;
  const content = message.content;
  const blocks = array(content);
  const hasUserText = typeof content === "string" ? Boolean(content.trim()) : blocks.some((part) => {
    const block = record(part);
    return typeof part === "string" || block?.type === "text";
  });
  if (!hasUserText)
    return false;
  const text = textFromClaudeContent(content, { excludeToolBlocks: true, excludeSystemReminder: true }).trim();
  if (!text)
    return false;
  if (/^\[Request interrupted by user/i.test(text))
    return false;
  return true;
}
function textFromClaudeContent(content, options = {}) {
  if (typeof content === "string")
    return content;
  return array(content).map((part) => {
    if (typeof part === "string")
      return part;
    const block = record(part);
    if (!block)
      return "";
    const type = String(block.type || "");
    if (options.excludeToolBlocks && (type === "tool_use" || type === "tool_result"))
      return "";
    if (type === "thinking")
      return options.excludeThinking ? "" : cleanString(block.thinking) || "";
    if (type === "text") {
      const text = cleanString(block.text) || "";
      if (options.excludeSystemReminder && /<system-reminder>[\s\S]*?<\/system-reminder>/i.test(text)) {
        return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
      }
      return text;
    }
    if (type === "tool_result")
      return cleanString(block.content) || "";
    return cleanString(block.text) || cleanString(block.content) || "";
  }).filter(Boolean).join("\n").trim();
}
function textFromEntry(entry) {
  const message = record(entry.message);
  return textFromClaudeContent(message?.content, {
    excludeToolBlocks: true,
    excludeSystemReminder: true
  });
}
function assistantTextFromEntry(entry) {
  const message = record(entry.message);
  return textFromClaudeContent(message?.content, {
    excludeToolBlocks: true,
    excludeSystemReminder: true,
    excludeThinking: true
  });
}
function normalizeToolName2(name) {
  const raw = String(name || "").trim();
  const lower = raw.toLowerCase();
  if (lower === "read")
    return "read_file";
  if (lower === "edit")
    return "replace_string_in_file";
  if (lower === "multiedit")
    return "edit_file";
  if (lower === "write")
    return "create_file";
  if (lower === "bash")
    return "run_in_terminal";
  if (lower === "grep")
    return "grep_search";
  if (lower === "glob")
    return "glob_search";
  if (lower === "ls")
    return "list_dir";
  return lower || raw || "unknown_tool";
}
function filePathFromArgs(args) {
  return cleanString(args.file_path) || cleanString(args.filePath) || cleanString(args.path) || cleanString(args.uri);
}
function toolSummary(toolName, args) {
  const path = filePathFromArgs(args);
  if (toolName === "read_file")
    return path ? `\u8BFB\u53D6\u6587\u4EF6\uFF1A${path}` : "\u8BFB\u53D6\u6587\u4EF6";
  if (toolName === "replace_string_in_file" || toolName === "edit_file")
    return path ? `\u4FEE\u6539\u6587\u4EF6\uFF1A${path}` : "\u4FEE\u6539\u6587\u4EF6";
  if (toolName === "create_file")
    return path ? `\u5199\u5165\u6587\u4EF6\uFF1A${path}` : "\u5199\u5165\u6587\u4EF6";
  if (toolName === "run_in_terminal")
    return cleanString(args.command) ? `\u6267\u884C\u547D\u4EE4\uFF1A${String(args.command).slice(0, 300)}` : "\u6267\u884C\u547D\u4EE4";
  if (toolName === "grep_search")
    return cleanString(args.pattern) ? `\u641C\u7D22\uFF1A${args.pattern}` : "\u641C\u7D22";
  if (toolName === "glob_search")
    return cleanString(args.pattern) ? `\u5339\u914D\u6587\u4EF6\uFF1A${args.pattern}` : "\u5339\u914D\u6587\u4EF6";
  if (toolName === "list_dir")
    return path ? `\u5217\u76EE\u5F55\uFF1A${path}` : "\u5217\u76EE\u5F55";
  return toolName;
}
function lineHash(filePath, text) {
  return hashText(`${filePath}\0${text}`);
}
function diffFromReplacement(args, toolName, toolCallId, requestId2, responseId, turnIndex) {
  const filePath = filePathFromArgs(args);
  if (!filePath)
    return void 0;
  const oldText = cleanString(args.old_string) ?? cleanString(args.oldString) ?? cleanString(args.original) ?? "";
  const newText = cleanString(args.new_string) ?? cleanString(args.newString) ?? cleanString(args.replacement) ?? cleanString(args.content) ?? "";
  if (!oldText && !newText)
    return void 0;
  const oldLines = oldText.split(/\r?\n/).filter((line) => line.length > 0);
  const newLines = newText.split(/\r?\n/).filter((line) => line.length > 0);
  const lines = [];
  oldLines.forEach((line, index) => {
    lines.push({
      line_type: "removed",
      old_line: index + 1,
      text: line,
      text_hash: lineHash(filePath, line)
    });
  });
  newLines.forEach((line, index) => {
    lines.push({
      line_type: "added",
      new_line: index + 1,
      text: line,
      text_hash: lineHash(filePath, line)
    });
  });
  return {
    snapshot_kind: "claude_turn_tool_patch",
    file_path: filePath,
    lines_added: newLines.length,
    lines_deleted: oldLines.length,
    hunks: [
      {
        old_start: 1,
        old_lines: oldLines.length,
        new_start: 1,
        new_lines: newLines.length,
        lines
      }
    ],
    request_id: requestId2,
    response_id: responseId,
    turn_index: turnIndex,
    tool_call_id: toolCallId,
    tool_name: toolName,
    status: "complete",
    source: "claude_tool_arguments",
    raw_json: args
  };
}
async function latestClaudeProjectFile(options = {}) {
  if (options.sessionFile) {
    try {
      await stat2(options.sessionFile);
      return options.sessionFile;
    } catch {
    }
  }
  const roots = [join2(homedir2(), ".claude", "projects"), join2(homedir2(), ".claude", "transcripts")];
  const candidates = [];
  async function walk2(dir, depth = 0) {
    if (depth > 3)
      return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join2(dir, entry.name);
      if (entry.isDirectory()) {
        await walk2(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const st = await stat2(full);
          let score = 0;
          if (options.sessionId && basename(full, ".jsonl") === options.sessionId)
            score += 1e3;
          if (options.workspacePath && full.includes(options.workspacePath.replace(/\//g, "-")))
            score += 100;
          candidates.push({ path: full, mtimeMs: st.mtimeMs, score });
        } catch {
        }
      }
    }
  }
  for (const root of roots)
    await walk2(root);
  candidates.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path;
}
function usageFromMessage(message) {
  const usage = record(message?.usage) || {};
  const input = Number(usage.input_tokens ?? usage.prompt_tokens);
  const output = Number(usage.output_tokens ?? usage.completion_tokens);
  return {
    ...Number.isFinite(input) ? { prompt_tokens: input } : {},
    ...Number.isFinite(output) ? { output_tokens: output, completion_tokens: output } : {}
  };
}
function contentBlocks(entry) {
  const message = record(entry.message);
  return array(message?.content);
}
function attachToolResult(turn, entry) {
  const at = isoTimestamp(entry.timestamp);
  updateTurnContext(turn, entry);
  for (const block of contentBlocks(entry)) {
    const rec = record(block);
    if (!rec || rec.type !== "tool_result")
      continue;
    const toolCallId = cleanString(rec.tool_use_id) || cleanString(entry.sourceToolAssistantUUID) || `tool_result_${hashJson(rec).slice(0, 16)}`;
    const content = textFromClaudeContent([rec]);
    const existing = turn.tools.get(toolCallId);
    if (existing) {
      existing.status = rec.is_error ? "failed" : "complete";
      existing.result_raw = entry.toolUseResult || rec.content;
      existing.completed_at = at;
    }
    turn.steps.push({
      step_id: hashText(`${turn.requestId}:tool_result:${toolCallId}:${content}`).slice(0, 32),
      step_type: "tool_result",
      text: content,
      text_hash: hashText(content),
      source: "claude_project_jsonl",
      source_event_type: "tool_result",
      tool_call_id: toolCallId,
      tool_name: existing?.tool_name,
      status: rec.is_error ? "failed" : "complete",
      occurred_at: at,
      actor_path: "top",
      actor_type: "assistant"
    });
  }
}
function attachAssistantBlocks(turn, entry) {
  const message = record(entry.message);
  const at = isoTimestamp(entry.timestamp);
  updateTurnContext(turn, entry);
  const responseId = cleanString(message?.id) || cleanString(entry.uuid) || turn.responseId;
  if (responseId)
    turn.responseId = responseId;
  const model = cleanString(message?.model);
  if (model)
    turn.model = model;
  const usage = usageFromMessage(message);
  turn.usage.prompt_tokens = usage.prompt_tokens ?? turn.usage.prompt_tokens;
  turn.usage.output_tokens = usage.output_tokens ?? turn.usage.output_tokens;
  turn.usage.completion_tokens = usage.completion_tokens ?? turn.usage.completion_tokens;
  for (const block of contentBlocks(entry)) {
    const rec = record(block);
    if (!rec)
      continue;
    const type = String(rec.type || "");
    if (type === "thinking") {
      const thinking = cleanString(rec.thinking);
      if (thinking) {
        turn.steps.push({
          step_id: hashText(`${turn.requestId}:thinking:${hashText(thinking)}`).slice(0, 32),
          step_type: "visible_reasoning",
          text: thinking,
          text_hash: hashText(thinking),
          source: "claude_project_jsonl",
          source_event_type: "thinking",
          occurred_at: at,
          actor_path: "top",
          actor_type: "assistant"
        });
      }
      continue;
    }
    if (type === "tool_use") {
      const toolCallId = cleanString(rec.id) || `call_${hashJson(rec).slice(0, 16)}`;
      const toolName = normalizeToolName2(rec.name);
      const args = record(rec.input) || {};
      const summary = toolSummary(toolName, args);
      const stepId2 = hashText(`${turn.requestId}:tool_call:${toolCallId}:${summary}`).slice(0, 32);
      const toolCall = {
        step_id: stepId2,
        tool_call_id: toolCallId,
        tool_name: toolName,
        arguments_raw: args,
        status: "requested",
        started_at: at,
        actor_path: "top",
        actor_type: "assistant",
        source: "claude_project_jsonl"
      };
      turn.tools.set(toolCallId, toolCall);
      turn.steps.push({
        step_id: stepId2,
        step_type: "tool_call",
        text: summary,
        text_hash: hashText(summary),
        source: "claude_project_jsonl",
        source_event_type: "tool_use",
        tool_call_id: toolCallId,
        tool_name: toolName,
        status: "requested",
        occurred_at: at,
        actor_path: "top",
        actor_type: "assistant"
      });
      if (["replace_string_in_file", "edit_file", "create_file"].includes(toolName)) {
        const change = diffFromReplacement(args, toolName, toolCallId, turn.requestId, responseId, turn.turnIndex);
        if (change)
          turn.codeChanges.push(change);
      }
      continue;
    }
    if (type === "text") {
      const text = cleanString(rec.text);
      if (text) {
        turn.steps.push({
          step_id: hashText(`${turn.requestId}:assistant_progress:${hashText(text)}`).slice(0, 32),
          step_type: "assistant_progress",
          text,
          text_hash: hashText(text),
          source: "claude_project_jsonl",
          source_event_type: "assistant_text",
          occurred_at: at,
          actor_path: "top",
          actor_type: "assistant"
        });
      }
    }
  }
}
function updateTurnContext(turn, entry) {
  turn.cwd = cleanString(entry.cwd) || turn.cwd;
  turn.gitBranch = cleanString(entry.gitBranch) || turn.gitBranch;
  turn.entrypoint = cleanString(entry.entrypoint) || turn.entrypoint;
  turn.version = cleanString(entry.version) || turn.version;
}
function finalizeTurn(turn, sourcePath, sourceInfo) {
  const responseId = turn.responseId || `${turn.requestId}:no_response`;
  for (const change of turn.codeChanges) {
    change.request_id = turn.requestId;
    change.response_id = responseId;
    change.turn_index = turn.turnIndex;
  }
  const finalAssistantHash = turn.assistantText ? hashText(turn.assistantText) : void 0;
  const processSteps = turn.steps.filter((step) => {
    if (step.step_type !== "assistant_progress")
      return true;
    return Boolean(finalAssistantHash && step.text_hash !== finalAssistantHash);
  });
  const visibleReasoning = processSteps.filter((step) => step.step_type === "visible_reasoning");
  const assistantProgress = processSteps.filter((step) => step.step_type === "assistant_progress");
  const elapsedMs = turn.startedAt && turn.completedAt ? Math.max(0, Date.parse(turn.completedAt) - Date.parse(turn.startedAt)) : void 0;
  const requestUsage = [
    {
      request_id: turn.requestId,
      response_id: responseId,
      request_index: Math.max(turn.turnIndex - 1, 0),
      turn_index: turn.turnIndex,
      model: turn.model,
      prompt_tokens: turn.usage.prompt_tokens,
      output_tokens: turn.usage.output_tokens,
      completion_tokens: turn.usage.completion_tokens,
      elapsed_ms: elapsedMs,
      credits_source: "claude",
      occurred_at: turn.completedAt
    }
  ];
  return {
    schema_version: "claude.turn_snapshot.v1",
    session_id: turn.sessionId,
    request_id: turn.requestId,
    response_id: responseId,
    turn_index: turn.turnIndex,
    attempt: 1,
    source: "claude_project_jsonl",
    cwd: turn.cwd,
    git_branch: turn.gitBranch,
    claude_entrypoint: turn.entrypoint,
    claude_version: turn.version,
    title: turn.userText.slice(0, 80),
    model: turn.model,
    resolved_model: turn.model,
    user_message: {
      role: "user",
      text: turn.userText,
      text_hash: hashText(turn.userText),
      source: "claude_project_jsonl",
      occurred_at: turn.userAt
    },
    assistant_message: turn.assistantText ? {
      role: "assistant",
      text: turn.assistantText,
      text_hash: hashText(turn.assistantText),
      source: "claude_project_jsonl",
      occurred_at: turn.assistantAt
    } : void 0,
    messages: turn.messages,
    assistant_progress: assistantProgress,
    visible_reasoning: visibleReasoning,
    process_steps: processSteps,
    tool_calls: [...turn.tools.values()],
    code_changes: turn.codeChanges,
    request_usage: requestUsage,
    usage_totals: {
      prompt_tokens: turn.usage.prompt_tokens,
      output_tokens: turn.usage.output_tokens,
      completion_tokens: turn.usage.completion_tokens,
      elapsed_ms: elapsedMs
    },
    turn: {
      turn_index: turn.turnIndex,
      request_id: turn.requestId,
      response_id: responseId,
      attempt: 1,
      status: turn.status,
      started_at: turn.startedAt,
      completed_at: turn.completedAt
    },
    source_files: {
      claude_project_jsonl: sourceInfo,
      parser_version: CLAUDE_TURN_PARSER_VERSION,
      capture_limitations: "Captured from Claude Code project JSONL. Visible thinking and tool calls are included when present. Hidden model reasoning is not available. Bash-created file diffs are only attributable when Claude logs explicit edit/write tool arguments."
    }
  };
}
async function captureLatestClaudeTurnSnapshots(options = {}) {
  const file = await latestClaudeProjectFile(options);
  if (!file)
    throw new Error("No Claude Code JSONL file found under ~/.claude/projects or ~/.claude/transcripts");
  const filePath = file;
  const raw = await readFile2(filePath, "utf8");
  const st = await stat2(filePath);
  const sourceInfo = {
    path: filePath.replace(homedir2(), "~"),
    sha256: hashText(raw),
    mtime_ms: st.mtimeMs,
    size_bytes: st.size
  };
  const entries = raw.split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return void 0;
    }
  }).filter((entry) => Boolean(entry));
  const turns = [];
  let current;
  let turnIndex = 0;
  const requestedSessionId = options.sessionId;
  function finishCurrent() {
    if (!current)
      return;
    if (!current.completedAt)
      current.completedAt = current.assistantAt || current.startedAt;
    turns.push(finalizeTurn(current, filePath, sourceInfo));
    current = void 0;
  }
  for (const entry of entries) {
    const sessionId = cleanString(entry.sessionId) || cleanString(entry.session_id) || requestedSessionId || basename(filePath, ".jsonl");
    if (requestedSessionId && sessionId !== requestedSessionId)
      continue;
    if (isRealUserPrompt(entry)) {
      finishCurrent();
      turnIndex += 1;
      const text = textFromEntry(entry);
      if (!text)
        continue;
      const requestId2 = cleanString(entry.uuid) || cleanString(entry.promptId) || stableEventId(`claude:request:${sessionId}:${turnIndex}:${text}`);
      const at = isoTimestamp(entry.timestamp);
      current = {
        sessionId,
        turnIndex,
        requestId: requestId2,
        userText: text,
        userAt: at,
        userKey: requestId2,
        status: "incomplete",
        startedAt: at,
        cwd: cleanString(entry.cwd),
        gitBranch: cleanString(entry.gitBranch),
        entrypoint: cleanString(entry.entrypoint),
        version: cleanString(entry.version),
        messages: [
          {
            role: "user",
            text,
            text_hash: hashText(text),
            source: "claude_project_jsonl",
            source_key: requestId2,
            occurred_at: at
          }
        ],
        steps: [],
        tools: /* @__PURE__ */ new Map(),
        codeChanges: [],
        usage: {}
      };
      continue;
    }
    if (!current)
      continue;
    if (entry.type === "user" && contentBlocks(entry).some((block) => record(block)?.type === "tool_result")) {
      attachToolResult(current, entry);
      continue;
    }
    if (entry.type === "assistant") {
      const message = record(entry.message);
      attachAssistantBlocks(current, entry);
      const text = assistantTextFromEntry(entry);
      const at = isoTimestamp(entry.timestamp);
      const hasError = Boolean(entry.error || entry.isApiErrorMessage || entry.apiErrorStatus);
      if (text) {
        current.assistantText = [current.assistantText, text].filter(Boolean).join("\n");
        current.assistantAt = at;
        current.messages.push({
          role: "assistant",
          text,
          text_hash: hashText(text),
          source: "claude_project_jsonl",
          source_key: cleanString(message?.id) || cleanString(entry.uuid) || hashText(text).slice(0, 32),
          occurred_at: at
        });
      }
      if (hasError) {
        current.status = "failed";
        current.completedAt = at;
        current.steps.push({
          step_id: hashText(`${current.requestId}:error:${entry.error || entry.apiErrorStatus || text}`).slice(0, 32),
          step_type: "error",
          text: text || String(entry.error || entry.apiErrorStatus || "Claude execution error"),
          text_hash: hashText(text || String(entry.error || entry.apiErrorStatus || "Claude execution error")),
          source: "claude_project_jsonl",
          source_event_type: "assistant_error",
          status: "failed",
          occurred_at: at,
          actor_path: "top",
          actor_type: "assistant"
        });
        finishCurrent();
      } else if (String(message?.stop_reason || "") !== "tool_use" && text) {
        current.status = "completed";
        current.completedAt = at;
        finishCurrent();
      }
    }
  }
  finishCurrent();
  const output = turns.filter((turn) => turn.messages.some((message) => message.role === "user"));
  return options.latestOnly === false ? output : output.slice(-1);
}

// ../../plugin-runtime/dist/copilot-turn.js
import { createHash as createHash4 } from "node:crypto";

// ../../plugin-runtime/dist/copilot-usage.js
function record2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function isoTimestamp2(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? void 0 : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  return void 0;
}
function cleanModel(value) {
  if (typeof value !== "string" || !value.trim())
    return void 0;
  return value.trim().replace(/^copilot\//, "");
}
function creditsFromDetails(value) {
  if (typeof value !== "string")
    return void 0;
  const match = /(?:^|[^\d])(\d+(?:\.\d+)?)\s*credits?\b/i.exec(value);
  return match ? Number(match[1]) : void 0;
}
function requestId(request, index, sessionId) {
  const value = request.requestId || request.id || request.request_id;
  if (typeof value === "string" && value.trim())
    return value.trim();
  return `${sessionId || "copilot"}:request:${index}`;
}
function setNumber(target, key, value) {
  const parsed = finiteNumber(value);
  if (parsed !== void 0) {
    target[key] = parsed;
  }
}
function applyResult(target, value) {
  const result = record2(value);
  if (!result)
    return;
  const metadata = record2(result.metadata);
  const timings = record2(result.timings);
  const resolvedModel = cleanModel(metadata?.resolvedModel || result.resolvedModel);
  if (resolvedModel)
    target.model = resolvedModel;
  setNumber(target, "prompt_tokens", metadata?.promptTokens ?? result.promptTokens);
  setNumber(target, "output_tokens", metadata?.outputTokens ?? result.outputTokens);
  setNumber(target, "completion_tokens", metadata?.completionTokens ?? result.completionTokens);
  if (target.elapsed_ms === void 0)
    setNumber(target, "elapsed_ms", timings?.totalElapsed);
  const directCredits = finiteNumber(result.copilotCredits ?? metadata?.copilotCredits);
  if (directCredits !== void 0) {
    target.copilot_credits = directCredits;
    target.credits_source = "direct";
  } else if (target.copilot_credits === void 0) {
    const derivedCredits = creditsFromDetails(result.details);
    if (derivedCredits !== void 0) {
      target.copilot_credits = derivedCredits;
      target.credits_source = "details";
    }
  }
}
function applyRequest(target, request) {
  const model = cleanModel(record2(request.result)?.metadata && record2(record2(request.result)?.metadata)?.resolvedModel) || cleanModel(record2(request.result)?.resolvedModel) || cleanModel(request.resolvedModel) || cleanModel(request.modelId);
  if (model)
    target.model = model;
  const occurredAt = isoTimestamp2(request.timestamp ?? request.createdAt);
  if (occurredAt)
    target.occurred_at = occurredAt;
  setNumber(target, "prompt_tokens", request.promptTokens);
  setNumber(target, "output_tokens", request.outputTokens);
  setNumber(target, "completion_tokens", request.completionTokens);
  setNumber(target, "elapsed_ms", request.elapsedMs);
  const directCredits = finiteNumber(request.copilotCredits);
  if (directCredits !== void 0) {
    target.copilot_credits = directCredits;
    target.credits_source = "direct";
  }
  applyResult(target, request.result);
}
function parseCopilotRequestUsage(entries) {
  let sessionId;
  let title;
  let startedAt;
  let nextRequestIndex = 0;
  const usages = /* @__PURE__ */ new Map();
  const usageAt = (index) => {
    let usage = usages.get(index);
    if (!usage) {
      usage = {
        request_id: `${sessionId || "copilot"}:request:${index}`,
        request_index: index
      };
      usages.set(index, usage);
    }
    return usage;
  };
  const registerRequest = (value, index) => {
    const request = record2(value);
    if (!request)
      return;
    const usage = usageAt(index);
    usage.request_id = requestId(request, index, sessionId);
    applyRequest(usage, request);
    nextRequestIndex = Math.max(nextRequestIndex, index + 1);
  };
  for (const entry of entries) {
    const kind = finiteNumber(entry.kind);
    if (kind === 0) {
      const snapshot = record2(entry.v);
      if (!snapshot)
        continue;
      if (typeof snapshot.sessionId === "string" && snapshot.sessionId.trim())
        sessionId = snapshot.sessionId.trim();
      if (typeof snapshot.customTitle === "string" && snapshot.customTitle.trim())
        title = snapshot.customTitle.trim();
      startedAt = isoTimestamp2(snapshot.creationDate) || startedAt;
      const requests = Array.isArray(snapshot.requests) ? snapshot.requests : [];
      requests.forEach((request, index) => registerRequest(request, index));
      continue;
    }
    const path = Array.isArray(entry.k) ? entry.k : [];
    if (path.length === 1 && path[0] === "customTitle" && typeof entry.v === "string") {
      title = entry.v.trim() || title;
      continue;
    }
    if (kind === 2 && path.length === 1 && path[0] === "requests" && Array.isArray(entry.v)) {
      for (const request of entry.v)
        registerRequest(request, nextRequestIndex);
      continue;
    }
    if (path.length < 3 || path[0] !== "requests" || typeof path[1] !== "number")
      continue;
    const usage = usageAt(path[1]);
    const field = String(path[2]);
    if (field === "result") {
      applyResult(usage, entry.v);
    } else if (field === "modelId" || field === "resolvedModel") {
      const model = cleanModel(entry.v);
      if (model)
        usage.model = model;
    } else if (field === "timestamp" || field === "createdAt") {
      const occurredAt = isoTimestamp2(entry.v);
      if (occurredAt)
        usage.occurred_at = occurredAt;
    } else if (field === "promptTokens") {
      setNumber(usage, "prompt_tokens", entry.v);
    } else if (field === "outputTokens") {
      setNumber(usage, "output_tokens", entry.v);
    } else if (field === "completionTokens") {
      setNumber(usage, "completion_tokens", entry.v);
    } else if (field === "elapsedMs") {
      setNumber(usage, "elapsed_ms", entry.v);
    } else if (field === "copilotCredits") {
      const credits = finiteNumber(entry.v);
      if (credits !== void 0) {
        usage.copilot_credits = credits;
        usage.credits_source = "direct";
      }
    } else if (field === "details" && usage.credits_source !== "direct") {
      const credits = creditsFromDetails(entry.v);
      if (credits !== void 0) {
        usage.copilot_credits = credits;
        usage.credits_source = "details";
      }
    }
  }
  const requestUsage = [...usages.values()].sort((left, right) => left.request_index - right.request_index);
  const usageTotals = requestUsage.reduce((totals, usage) => ({
    prompt_tokens: totals.prompt_tokens + (usage.prompt_tokens ?? 0),
    output_tokens: totals.output_tokens + (usage.output_tokens ?? 0),
    completion_tokens: totals.completion_tokens + (usage.completion_tokens ?? 0),
    elapsed_ms: totals.elapsed_ms + (usage.elapsed_ms ?? 0),
    copilot_credits: Math.round((totals.copilot_credits + (usage.copilot_credits ?? 0)) * 1e3) / 1e3
  }), { prompt_tokens: 0, output_tokens: 0, completion_tokens: 0, elapsed_ms: 0, copilot_credits: 0 });
  const resolvedModel = [...requestUsage].reverse().find((usage) => usage.model)?.model;
  return {
    sessionId,
    title,
    startedAt,
    resolvedModel,
    requestUsage,
    usageTotals,
    requestCount: requestUsage.length
  };
}

// ../../plugin-runtime/dist/copilot-turn.js
var COPILOT_TURN_PARSER_VERSION = "copilot-turn-v1.0.1";
function record3(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function array2(value) {
  return Array.isArray(value) ? value : [];
}
function cleanString2(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function isoTimestamp3(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? void 0 : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  return void 0;
}
function millis(value) {
  if (!value)
    return void 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? void 0 : parsed;
}
function hashText2(value) {
  return createHash4("sha256").update(value).digest("hex");
}
function hashJson2(value) {
  return hashText2(JSON.stringify(value ?? null));
}
function stepId(seed) {
  return hashText2(seed).slice(0, 32);
}
function textFromUnknown(value) {
  if (typeof value === "string")
    return value;
  if (Array.isArray(value))
    return value.map(textFromUnknown).filter(Boolean).join("\n");
  const rec = record3(value);
  if (!rec)
    return "";
  for (const key of ["text", "content", "value", "message"]) {
    const candidate = rec[key];
    if (typeof candidate === "string")
      return candidate;
  }
  if (Array.isArray(rec.parts))
    return rec.parts.map(textFromUnknown).filter(Boolean).join("\n");
  return "";
}
function userTextFromRendered(value) {
  const rendered = textFromUnknown(value);
  if (!rendered)
    return "";
  const match = /<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/i.exec(rendered);
  return (match?.[1] || "").trim();
}
function userTextFromRequest(request) {
  const messageText = textFromUnknown(request.message);
  if (messageText.trim())
    return messageText.trim();
  const metadata = record3(request.metadata) || {};
  return userTextFromRendered(request.renderedUserMessage) || userTextFromRendered(metadata.renderedUserMessage);
}
function assistantTextFromResponseParts(value) {
  return array2(value).map((part) => {
    const rec = record3(part);
    if (!rec)
      return "";
    const kind = String(rec.kind || "");
    if (kind === "thinking" || kind === "mcpServersStarting" || kind === "toolInvocationSerialized")
      return "";
    return textFromUnknown(rec.value || rec);
  }).filter(Boolean).join("\n").trim();
}
function finalAnswerFromRequest(request) {
  if (Array.isArray(request.response))
    return assistantTextFromResponseParts(request.response);
  const result = record3(request.result);
  if (result && Array.isArray(result.response))
    return assistantTextFromResponseParts(result.response);
  return textFromUnknown(request.responseText || result?.text || result?.content).trim();
}
function completedAtFromRequest(request) {
  const modelState = record3(request.modelState);
  return isoTimestamp3(modelState?.completedAt || request.completedAt || record3(request.result)?.completedAt);
}
function responseIdFromRequest(request, requestId2, finalAnswer, completedAt) {
  const modelState = record3(request.modelState);
  const result = record3(request.result);
  return cleanString2(request.responseId) || cleanString2(modelState?.responseId) || cleanString2(result?.responseId) || `${requestId2}:response:${hashText2(`${finalAnswer}:${completedAt}`).slice(0, 16)}`;
}
function requestIdFromRequest(request, index, sessionId) {
  return cleanString2(request.requestId) || cleanString2(request.id) || cleanString2(request.request_id) || `${sessionId}:request:${index}`;
}
function applyJournalEntry(root, entry) {
  if (entry.kind === 0)
    return record3(entry.v) || root;
  if (!root)
    return root;
  const path = Array.isArray(entry.k) ? entry.k : [];
  if (!path.length)
    return root;
  let cursor = root;
  for (const part of path.slice(0, -1)) {
    if (cursor == null)
      return root;
    cursor = cursor[part];
  }
  const last = path[path.length - 1];
  if (entry.kind === 2) {
    const existing = Array.isArray(cursor[last]) ? cursor[last] : [];
    const values = Array.isArray(entry.v) ? entry.v : [entry.v];
    const replaceAt = typeof entry.i === "number" && Number.isInteger(entry.i) ? entry.i : void 0;
    if (replaceAt === void 0) {
      cursor[last] = existing.concat(values);
    } else {
      const next = existing.slice();
      next.splice(Math.max(0, replaceAt), values.length, ...values);
      cursor[last] = next;
    }
  } else {
    cursor[last] = entry.v;
  }
  return root;
}
function replayCopilotChatSession(entries) {
  let snapshot;
  for (const entry of entries)
    snapshot = applyJournalEntry(snapshot, entry);
  const usage = parseCopilotRequestUsage(entries);
  const sessionId = cleanString2(snapshot?.sessionId) || usage.sessionId || "copilot-session";
  const title = cleanString2(snapshot?.customTitle) || usage.title;
  const startedAt = isoTimestamp3(snapshot?.creationDate) || usage.startedAt;
  const usageByIndex = new Map(usage.requestUsage.map((item) => [item.request_index, item]));
  const attempts = /* @__PURE__ */ new Map();
  const turns = [];
  array2(snapshot?.requests).forEach((rawRequest, index) => {
    const request = record3(rawRequest);
    if (!request)
      return;
    const userText = userTextFromRequest(request);
    const finalAnswer = finalAnswerFromRequest(request);
    const completedAt = completedAtFromRequest(request);
    if (!userText || !finalAnswer || !completedAt)
      return;
    const requestId2 = requestIdFromRequest(request, index, sessionId);
    const responseId = responseIdFromRequest(request, requestId2, finalAnswer, completedAt);
    const attempt = (attempts.get(requestId2) || 0) + 1;
    attempts.set(requestId2, attempt);
    const usageForTurn = usageByIndex.get(index);
    turns.push({
      session_id: sessionId,
      title,
      turn_index: index + 1,
      request_id: requestId2,
      response_id: responseId,
      attempt,
      user_text: userText,
      final_answer: finalAnswer,
      started_at: isoTimestamp3(request.timestamp || request.createdAt) || usageForTurn?.occurred_at || startedAt,
      completed_at: completedAt,
      model: usageForTurn?.model || cleanString2(request.modelId)?.replace(/^copilot\//, "") || usage.resolvedModel,
      usage: usageForTurn
    });
  });
  return {
    session_id: sessionId,
    title,
    started_at: startedAt,
    turns,
    usage_totals: usage.usageTotals,
    resolved_model: usage.resolvedModel
  };
}
function eventTime(entry, data) {
  return isoTimestamp3(entry.timestamp || entry.time || data.timestamp || data.startTime || data.completedAt || data.createdAt);
}
function actorInfo(data) {
  const parentToolCallId = cleanString2(data.parentToolCallId) || cleanString2(data.parent_tool_call_id) || cleanString2(data.parentId);
  const actorType = cleanString2(data.actorType) || cleanString2(data.actor_type) || (parentToolCallId ? "sub_agent" : "top_level");
  const actorPath = cleanString2(data.actorPath) || cleanString2(data.actor_path) || (parentToolCallId ? `top/${parentToolCallId}` : "top");
  return { actor_path: actorPath, actor_type: actorType, parent_tool_call_id: parentToolCallId };
}
function rawArgumentsFromToolRequest(request) {
  const fn = record3(request.function);
  return request.arguments ?? request.input ?? request.args ?? fn?.arguments;
}
function toolNameFromToolRequest(request) {
  const fn = record3(request.function);
  return cleanString2(request.name) || cleanString2(request.toolName) || cleanString2(fn?.name) || "tool";
}
function toolCallIdFrom(value, fallback) {
  return cleanString2(value.toolCallId) || cleanString2(value.tool_call_id) || cleanString2(value.id) || fallback;
}
function textStep(stepType, text, source, eventType, occurredAt, extra = {}) {
  if (!text.trim())
    return void 0;
  const hash = hashText2(text);
  return {
    step_id: extra.step_id || stepId(`${stepType}:${hash}:${extra.tool_call_id || ""}:${occurredAt || ""}`),
    step_type: stepType,
    text,
    text_hash: hash,
    source,
    source_event_type: eventType,
    occurred_at: occurredAt,
    ...extra
  };
}
function parseCopilotTranscriptEvents(entries) {
  let sessionId;
  let startedAt;
  const toolCalls = /* @__PURE__ */ new Map();
  const assistantProgress = [];
  const visibleReasoning = [];
  const processSteps = [];
  const subAgents = [];
  entries.forEach((entry, index) => {
    const type = cleanString2(entry.type) || "";
    const data = record3(entry.data) || {};
    const occurredAt = eventTime(entry, data);
    if (type === "session.start") {
      sessionId = cleanString2(data.sessionId) || sessionId;
      startedAt = isoTimestamp3(data.startTime) || startedAt;
      return;
    }
    if (data.sessionId && !sessionId)
      sessionId = cleanString2(data.sessionId);
    const actor = actorInfo(data);
    if (actor.actor_type === "sub_agent") {
      subAgents.push({ source_event_type: type, occurred_at: occurredAt, ...actor, data });
    }
    if (type === "assistant.message") {
      const content = textFromUnknown(data.content);
      const progress = textStep("assistant_progress", content, "transcript", type, occurredAt, actor);
      if (progress) {
        assistantProgress.push(progress);
        processSteps.push(progress);
      }
      const reasoning = textFromUnknown(data.reasoningText || data.thinking);
      const reasoningStep = textStep("visible_reasoning", reasoning, "transcript", type, occurredAt, {
        ...actor,
        status: "complete"
      });
      if (reasoningStep) {
        visibleReasoning.push(reasoningStep);
        processSteps.push(reasoningStep);
      }
      array2(data.toolRequests || data.toolCalls).forEach((rawRequest, requestIndex) => {
        const request = record3(rawRequest);
        if (!request)
          return;
        const toolCallId = toolCallIdFrom(request, `assistant:${index}:${requestIndex}`);
        const toolName = toolNameFromToolRequest(request);
        const existing = toolCalls.get(toolCallId);
        const step_id = existing?.step_id || stepId(`tool:${toolCallId}:${toolName}`);
        toolCalls.set(toolCallId, {
          ...existing || {},
          step_id,
          tool_call_id: toolCallId,
          tool_name: toolName,
          arguments_raw: existing?.arguments_raw ?? rawArgumentsFromToolRequest(request),
          result_raw: existing?.result_raw,
          status: existing?.status || "requested",
          started_at: existing?.started_at || occurredAt,
          actor_path: actor.actor_path,
          actor_type: actor.actor_type,
          parent_tool_call_id: actor.parent_tool_call_id,
          source: "transcript"
        });
      });
      return;
    }
    if (type === "tool.execution_start" || type === "tool.execution_complete") {
      const toolCallId = toolCallIdFrom(data, `tool:${index}`);
      const toolName = cleanString2(data.toolName) || cleanString2(data.name) || cleanString2(data.invocationMessage) || "tool";
      const existing = toolCalls.get(toolCallId);
      const step_id = existing?.step_id || stepId(`tool:${toolCallId}:${toolName}`);
      const isComplete = type === "tool.execution_complete";
      const status = isComplete ? data.success === false ? "failed" : "complete" : "running";
      toolCalls.set(toolCallId, {
        ...existing || {},
        step_id,
        tool_call_id: toolCallId,
        tool_name: existing?.tool_name || toolName,
        arguments_raw: existing?.arguments_raw ?? (data.input ?? data.arguments ?? data.args),
        result_raw: isComplete ? data.output ?? data.result ?? data.error ?? data.message : existing?.result_raw,
        status,
        started_at: existing?.started_at || occurredAt,
        completed_at: isComplete ? occurredAt : existing?.completed_at,
        actor_path: existing?.actor_path || actor.actor_path,
        actor_type: existing?.actor_type || actor.actor_type,
        parent_tool_call_id: existing?.parent_tool_call_id || actor.parent_tool_call_id,
        source: "transcript"
      });
    }
  });
  for (const tool of toolCalls.values()) {
    const text = `${tool.tool_name} ${tool.status}`;
    processSteps.push({
      step_id: tool.step_id,
      step_type: "tool_call",
      text,
      text_hash: hashText2(text),
      source: tool.source,
      source_event_type: "tool",
      tool_call_id: tool.tool_call_id,
      tool_name: tool.tool_name,
      status: tool.status,
      occurred_at: tool.started_at,
      started_at: tool.started_at,
      completed_at: tool.completed_at,
      actor_path: tool.actor_path,
      actor_type: tool.actor_type,
      parent_tool_call_id: tool.parent_tool_call_id
    });
  }
  return {
    session_id: sessionId,
    started_at: startedAt,
    assistant_progress: assistantProgress,
    visible_reasoning: visibleReasoning,
    process_steps: processSteps,
    tool_calls: [...toolCalls.values()],
    sub_agents: subAgents
  };
}
function inTurnWindow(value, turn) {
  const start = millis(turn.started_at);
  const end = millis(turn.completed_at);
  const candidate = millis(value.occurred_at || value.started_at || value.completed_at);
  if (candidate === void 0 || start === void 0 || end === void 0)
    return true;
  return candidate >= start - 2e3 && candidate <= end + 2e3;
}
function buildCopilotTurnSnapshots(input) {
  const chat2 = replayCopilotChatSession(input.chat_entries);
  const transcript = input.transcript_entries ? parseCopilotTranscriptEvents(input.transcript_entries) : void 0;
  const usageByRequest = new Map((chat2.turns || []).map((turn) => [turn.request_id, turn.usage]));
  return chat2.turns.map((turn) => {
    const assistantProgress = (transcript?.assistant_progress || []).filter((step) => inTurnWindow(step, turn));
    const visibleReasoning = (transcript?.visible_reasoning || []).filter((step) => inTurnWindow(step, turn));
    const toolCalls = (transcript?.tool_calls || []).filter((tool) => inTurnWindow(tool, turn));
    const processSteps = (transcript?.process_steps || []).filter((step) => inTurnWindow(step, turn)).map((step) => ({ ...step, request_id: turn.request_id, response_id: turn.response_id }));
    const subAgents = (transcript?.sub_agents || []).filter((agent) => inTurnWindow(agent, turn));
    const usage = usageByRequest.get(turn.request_id) || turn.usage;
    const requestUsage = usage ? [{ ...usage, request_id: turn.request_id, response_id: turn.response_id }] : [];
    const usageTotals = requestUsage.reduce((totals, item) => ({
      prompt_tokens: totals.prompt_tokens + (item.prompt_tokens || 0),
      output_tokens: totals.output_tokens + (item.output_tokens || 0),
      completion_tokens: totals.completion_tokens + (item.completion_tokens || 0),
      elapsed_ms: totals.elapsed_ms + (item.elapsed_ms || 0),
      copilot_credits: Math.round((totals.copilot_credits + (item.copilot_credits || 0)) * 1e3) / 1e3
    }), { prompt_tokens: 0, output_tokens: 0, completion_tokens: 0, elapsed_ms: 0, copilot_credits: 0 });
    const userHash = hashText2(turn.user_text);
    const assistantHash = hashText2(turn.final_answer);
    return {
      schema_version: "copilot.turn_snapshot.v1",
      session_id: turn.session_id,
      title: turn.title || chat2.title,
      request_id: turn.request_id,
      response_id: turn.response_id,
      turn_index: turn.turn_index,
      attempt: turn.attempt,
      source: transcript ? "copilot_dual_source" : "copilot_chat_session_only",
      user_message: {
        role: "user",
        text: turn.user_text,
        text_hash: userHash,
        source: "chatSessions",
        occurred_at: turn.started_at
      },
      assistant_message: {
        role: "assistant",
        text: turn.final_answer,
        text_hash: assistantHash,
        source: "chatSessions",
        occurred_at: turn.completed_at
      },
      messages: [
        {
          role: "user",
          text: turn.user_text,
          text_hash: userHash,
          source: "chatSessions",
          source_key: `${turn.request_id}:user`,
          occurred_at: turn.started_at
        },
        {
          role: "assistant",
          text: turn.final_answer,
          text_hash: assistantHash,
          source: "chatSessions",
          source_key: `${turn.request_id}:${turn.response_id}:assistant`,
          occurred_at: turn.completed_at
        }
      ],
      assistant_progress: assistantProgress,
      visible_reasoning: visibleReasoning,
      process_steps: processSteps,
      tool_calls: toolCalls.map((tool) => ({ ...tool, request_id: turn.request_id, response_id: turn.response_id })),
      sub_agents: subAgents,
      request_usage: requestUsage,
      usage_totals: usageTotals,
      resolved_model: turn.model || chat2.resolved_model,
      model: turn.model || chat2.resolved_model,
      turn: {
        turn_index: turn.turn_index,
        request_id: turn.request_id,
        response_id: turn.response_id,
        attempt: turn.attempt,
        status: "completed",
        started_at: turn.started_at,
        completed_at: turn.completed_at
      },
      source_files: {
        chat_session: input.chat_file,
        transcript: input.transcript_file,
        parser_version: COPILOT_TURN_PARSER_VERSION,
        capture_limitations: "Captured from persisted VS Code Copilot chatSessions and GitHub.copilot-chat transcript files. visible_reasoning only contains reasoning text that those files actually persisted; hidden model chain-of-thought is not available."
      }
    };
  });
}
function copilotTurnEventId(snapshot, clientId2) {
  return hashText2(`copilot:turn:${clientId2 || "unknown-client"}:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}`).slice(0, 32);
}
function copilotTurnSignature(snapshot) {
  return hashJson2({
    request_id: snapshot.request_id,
    response_id: snapshot.response_id,
    user: snapshot.user_message.text_hash,
    assistant: snapshot.assistant_message.text_hash,
    tools: snapshot.tool_calls.map((tool) => [tool.tool_call_id, tool.status, hashJson2(tool.arguments_raw), hashJson2(tool.result_raw)]),
    reasoning: snapshot.visible_reasoning.map((step) => step.text_hash),
    completed_at: snapshot.turn.completed_at
  });
}

// ../../plugin-runtime/dist/git.js
import { execFile } from "node:child_process";
import { createHash as createHash5 } from "node:crypto";
import { chmod, mkdir as mkdir2, readFile as readFile3, unlink, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2, join as join3 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
async function git(workspacePath2, args, timeout = 1e4) {
  const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], { cwd: workspacePath2, timeout });
  return stdout.trim();
}
async function resolvedGitDir(workspacePath2) {
  const gitDir = await git(workspacePath2, ["rev-parse", "--git-dir"]);
  return gitDir.startsWith("/") ? gitDir : join3(workspacePath2, gitDir);
}
async function aiActivityMarkerPath(workspacePath2) {
  return join3(await resolvedGitDir(workspacePath2), "tinyai-observability", "ai-activity.json");
}
async function aiLineEvidencePath(workspacePath2) {
  return join3(await resolvedGitDir(workspacePath2), "tinyai-observability", "ai-line-spans.jsonl");
}
function markerTtlMs() {
  const seconds = Number.parseInt(process.env.TINYAI_OBS_AI_MARKER_TTL_SECONDS || "21600", 10);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 21600) * 1e3;
}
function lineHash2(filePath, content) {
  return createHash5("sha256").update(`${filePath}\0${content}`).digest("hex");
}
function isSensitiveDiffPath(filePath) {
  const normalized = filePath.toLowerCase();
  return /(^|\/)\.env(?:\.|$)/.test(normalized) || /(^|\/)(\.?npmrc|\.?pypirc|\.?netrc|id_rsa|id_ed25519)$/.test(normalized) || /(secret|secrets|credential|credentials|token|private-key|private_key)/.test(normalized);
}
function decodeGitQuotedPath(raw) {
  const trimmed = raw.trim();
  const isQuoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
  const inner = isQuoted ? trimmed.slice(1, -1) : trimmed;
  if (!/\\(?:[0-7]{3}|[abfnrtv\\"'])/.test(inner))
    return trimmed;
  const bytes = [];
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char !== "\\") {
      for (const byte of Buffer.from(char, "utf8"))
        bytes.push(byte);
      continue;
    }
    const next = inner[index + 1];
    const octal = inner.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }
    const escapes = {
      a: 7,
      b: 8,
      f: 12,
      n: 10,
      r: 13,
      t: 9,
      v: 11,
      "\\": 92,
      '"': 34,
      "'": 39
    };
    if (next && Object.prototype.hasOwnProperty.call(escapes, next)) {
      bytes.push(escapes[next]);
      index += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
function normalizeDiffPath(raw) {
  let path = decodeGitQuotedPath(raw.trim()).replace(/\\/g, "/");
  if (path.startsWith("a/") || path.startsWith("b/"))
    path = path.slice(2);
  return path;
}
function safeDiffLineText(filePath, text, includeText) {
  if (!includeText)
    return { text: "[text not stored]", redacted: true };
  if (isSensitiveDiffPath(filePath))
    return { text: "[REDACTED:SENSITIVE_FILE]", redacted: true };
  const redacted = redactText(text, { allowFullConversationText: true });
  return { text: redacted, redacted: redacted !== text };
}
function parseUnifiedDiffDetails(diff, options = {}) {
  const includeText = options.includeText ?? true;
  const maxFiles = options.maxFiles ?? 30;
  const maxLinesPerFile = options.maxLinesPerFile ?? 240;
  const files = [];
  let currentFile;
  let currentHunk;
  let pendingOldPath;
  let oldLine = 0;
  let newLine = 0;
  let totalAdded = 0;
  let totalDeleted = 0;
  let truncated = false;
  function pushFile(file) {
    if (!file)
      return;
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    files.push(file);
  }
  function addLine(lineType, rawText) {
    if (!currentFile || !currentHunk)
      return;
    if (currentFile.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) >= maxLinesPerFile) {
      truncated = true;
      return;
    }
    const display = safeDiffLineText(currentFile.file_path, rawText, includeText);
    const detail = {
      line_type: lineType,
      text: display.text,
      text_hash: lineHash2(currentFile.file_path, rawText)
    };
    if (display.redacted)
      detail.redacted = true;
    if (lineType === "added") {
      detail.new_line = newLine;
      currentFile.lines_added += 1;
      totalAdded += 1;
      newLine += 1;
    } else if (lineType === "removed") {
      detail.old_line = oldLine;
      currentFile.lines_deleted += 1;
      totalDeleted += 1;
      oldLine += 1;
    } else {
      detail.old_line = oldLine;
      detail.new_line = newLine;
      oldLine += 1;
      newLine += 1;
    }
    currentHunk.lines.push(detail);
  }
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      pushFile(currentFile);
      currentFile = void 0;
      currentHunk = void 0;
      pendingOldPath = void 0;
      continue;
    }
    if (line.startsWith("Binary files ")) {
      if (currentFile)
        currentFile.binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      const oldPath = line.slice(4).trim();
      pendingOldPath = oldPath === "/dev/null" ? void 0 : normalizeDiffPath(oldPath);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      const filePath = path === "/dev/null" ? currentFile?.old_path || "" : normalizeDiffPath(path);
      currentFile = {
        file_path: filePath,
        old_path: pendingOldPath,
        sensitive: isSensitiveDiffPath(filePath),
        lines_added: 0,
        lines_deleted: 0,
        hunks: []
      };
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && currentFile) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[3], 10);
      currentHunk = {
        old_start: oldLine,
        old_lines: Number.parseInt(hunk[2] || "1", 10),
        new_start: newLine,
        new_lines: Number.parseInt(hunk[4] || "1", 10),
        lines: []
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }
    if (!currentFile || !currentHunk || line.startsWith("\\ No newline"))
      continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      addLine("added", line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      addLine("removed", line.slice(1));
    } else if (line.startsWith(" ")) {
      addLine("context", line.slice(1));
    }
  }
  pushFile(currentFile);
  const filePaths = files.map((file) => file.file_path).filter(Boolean);
  return {
    snapshot_kind: "workspace_diff",
    diff_hash: createHash5("sha256").update(diff).digest("hex").slice(0, 32),
    include_text: includeText,
    truncated,
    files_changed: filePaths.length,
    lines_added: totalAdded,
    lines_deleted: totalDeleted,
    file_paths: filePaths.slice(0, 100),
    files
  };
}
function parseUnifiedAddedLines(diff) {
  const added = [];
  let currentFile = "";
  let newLine = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      currentFile = "";
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      currentFile = path === "/dev/null" ? "" : normalizeDiffPath(path);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (!currentFile || !line)
      continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1);
      added.push({
        file_path: currentFile,
        new_line: newLine,
        content,
        line_hash: lineHash2(currentFile, content)
      });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }
    if (line.startsWith(" ")) {
      newLine += 1;
    }
  }
  return added;
}
async function diffAddedLines(workspacePath2, args) {
  try {
    return parseUnifiedAddedLines(await git(workspacePath2, args, 2e4));
  } catch {
    return [];
  }
}
async function markAiActivity(workspacePath2, options) {
  try {
    const path = await aiActivityMarkerPath(workspacePath2);
    const now = /* @__PURE__ */ new Date();
    const ttlMs = options.ttlSeconds && options.ttlSeconds > 0 ? options.ttlSeconds * 1e3 : markerTtlMs();
    const marker = {
      tool: options.tool,
      task_id: options.taskId,
      source: options.source,
      marked_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlMs).toISOString()
    };
    await mkdir2(dirname2(path), { recursive: true });
    await writeFile2(path, JSON.stringify(marker, null, 2));
    return marker;
  } catch {
    return void 0;
  }
}
async function recordAiLineSnapshot(workspacePath2, options) {
  const activeMarker = await readActiveAiMarker(workspacePath2);
  if (options.requireAiMarker && !activeMarker) {
    return { recorded_lines: 0, files_changed: 0, skipped: true, reason: "no_active_ai_task_marker" };
  }
  const addedLines = [
    ...await diffAddedLines(workspacePath2, ["diff", "--cached", "--unified=0", "--no-color", "--", "."]),
    ...options.stagedOnly ? [] : await diffAddedLines(workspacePath2, ["diff", "--unified=0", "--no-color", "--", "."])
  ];
  if (addedLines.length === 0) {
    return { recorded_lines: 0, files_changed: 0, skipped: false };
  }
  const now = /* @__PURE__ */ new Date();
  const ttlMs = options.ttlSeconds && options.ttlSeconds > 0 ? options.ttlSeconds * 1e3 : markerTtlMs();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const evidence = addedLines.map((line) => ({
    tool: options.tool,
    task_id: options.taskId || activeMarker?.marker.task_id,
    source: options.source,
    file_path: line.file_path,
    new_line: line.new_line,
    line_hash: line.line_hash,
    recorded_at: now.toISOString(),
    expires_at: expiresAt
  }));
  const path = await aiLineEvidencePath(workspacePath2);
  await mkdir2(dirname2(path), { recursive: true });
  await writeFile2(path, evidence.map((item) => JSON.stringify(item)).join("\n") + "\n", { flag: "a" });
  return {
    recorded_lines: evidence.length,
    files_changed: new Set(evidence.map((item) => item.file_path)).size,
    skipped: false
  };
}
async function readActiveAiMarker(workspacePath2) {
  try {
    const raw = await readFile3(await aiActivityMarkerPath(workspacePath2), "utf8");
    const marker = JSON.parse(raw);
    const markedAt = Date.parse(marker.marked_at);
    const expiresAt = Date.parse(marker.expires_at);
    const now = Date.now();
    if (!Number.isFinite(markedAt) || !Number.isFinite(expiresAt) || expiresAt < now)
      return void 0;
    return { marker, age_seconds: Math.max(0, Math.round((now - markedAt) / 1e3)) };
  } catch {
    return void 0;
  }
}
async function attribution(workspacePath2, options = {}) {
  const activeMarker = await readActiveAiMarker(workspacePath2);
  const aiAssisted = options.aiAssisted ?? (options.requireAiMarker ? Boolean(activeMarker) : true);
  const evidence = options.attributionEvidence || (activeMarker ? "active_ai_task_marker" : options.requireAiMarker ? "no_active_ai_task_marker" : "manual_snapshot");
  return {
    ai_assisted: aiAssisted,
    ai_attribution_evidence: evidence,
    ai_marker_task_id: activeMarker?.marker.task_id,
    ai_marker_age_seconds: activeMarker?.age_seconds
  };
}
function parseNumstat(stdout) {
  const rows = stdout.split("\n").filter(Boolean);
  let linesAdded = 0;
  let linesDeleted = 0;
  const filePaths = [];
  for (const row of rows) {
    const parts = row.includes("	") ? row.split("	") : row.split(/\s+/);
    const [added, deleted, ...pathParts] = parts;
    const filePath = normalizeDiffPath(pathParts.join(row.includes("	") ? "	" : " "));
    if (filePath)
      filePaths.push(filePath);
    linesAdded += Number.parseInt(added, 10) || 0;
    linesDeleted += Number.parseInt(deleted, 10) || 0;
  }
  return {
    files_changed: filePaths.length,
    lines_added: linesAdded,
    lines_deleted: linesDeleted,
    file_paths: filePaths.slice(0, 100)
  };
}
async function diffSummary(workspacePath2) {
  try {
    return parseNumstat(await git(workspacePath2, ["diff", "--numstat", "--", "."]));
  } catch {
    return { files_changed: 0, lines_added: 0, lines_deleted: 0, file_paths: [] };
  }
}
async function currentDiffDetails(workspacePath2, options = {}) {
  try {
    const paths = normalizePathspecs(options.paths);
    const pathspecs = paths.length > 0 ? paths : ["."];
    const args = [options.staged ? "diff" : "diff", options.staged ? "--cached" : "", "--unified=3", "--no-color", "--", ...pathspecs].filter(Boolean);
    const trackedDiff = await git(workspacePath2, args, 3e4);
    const untrackedDiff = options.includeUntracked && !options.staged ? await untrackedFilesDiff(workspacePath2, pathspecs, options.includeText ?? true) : "";
    const diff = [trackedDiff, untrackedDiff].filter(Boolean).join("\n");
    return {
      ...parseUnifiedDiffDetails(diff, options),
      diff_raw: diff || void 0
    };
  } catch {
    return {
      snapshot_kind: "workspace_diff",
      diff_hash: "",
      diff_raw: void 0,
      include_text: options.includeText ?? true,
      truncated: false,
      files_changed: 0,
      lines_added: 0,
      lines_deleted: 0,
      file_paths: [],
      files: []
    };
  }
}
function normalizePathspecs(paths) {
  const output = /* @__PURE__ */ new Set();
  for (const raw of paths || []) {
    let value = raw.trim().replace(/\\/g, "/");
    if (!value || value.includes("\0"))
      continue;
    value = value.replace(/^file:\/\//, "");
    value = value.replace(/^\.?\//, "");
    if (value.startsWith("a/") || value.startsWith("b/"))
      value = value.slice(2);
    if (value && value.length < 1e3)
      output.add(value);
  }
  return [...output].slice(0, 50);
}
async function untrackedFilesDiff(workspacePath2, pathspecs, includeText) {
  let raw = "";
  try {
    raw = await git(workspacePath2, ["ls-files", "--others", "--exclude-standard", "--", ...pathspecs], 2e4);
  } catch {
    return "";
  }
  const files = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 50);
  const chunks = [];
  for (const filePath of files) {
    if (isSensitiveDiffPath(filePath))
      continue;
    try {
      const content = await readFile3(join3(workspacePath2, filePath), "utf8");
      const lines = content.split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === "")
        lines.pop();
      chunks.push([
        `diff --git a/${filePath} b/${filePath}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${includeText ? line : "[text not stored]"}`)
      ].join("\n"));
    } catch {
    }
  }
  return chunks.join("\n");
}
async function currentBranch(workspacePath2) {
  try {
    return await git(workspacePath2, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return void 0;
  }
}
async function currentHead(workspacePath2) {
  try {
    return await git(workspacePath2, ["rev-parse", "HEAD"]);
  } catch {
    return void 0;
  }
}
async function commitSnapshot(workspacePath2, ref = "HEAD", options = {}) {
  try {
    const summary = parseNumstat(await git(workspacePath2, ["show", "--numstat", "--format=", ref, "--", "."]));
    const attr = await attribution(workspacePath2, options);
    const diffRaw = await git(workspacePath2, ["show", "--unified=3", "--no-color", "--format=", ref, "--", "."], 3e4);
    const diffDetails = parseUnifiedDiffDetails(diffRaw, { includeText: true, maxFiles: 1e3, maxLinesPerFile: 2e4 });
    return {
      ...summary,
      commit_sha: await git(workspacePath2, ["rev-parse", ref]),
      branch: await currentBranch(workspacePath2),
      snapshot_kind: "commit",
      diff_hash: diffDetails.diff_hash,
      diff_raw: diffRaw,
      include_text: true,
      truncated: diffDetails.truncated,
      files: diffDetails.files,
      ...attr,
      ai_lines_added: 0,
      ai_lines_deleted: 0,
      ai_lines_modified: 0,
      human_lines_added: summary.lines_added,
      human_lines_deleted: summary.lines_deleted,
      human_lines_modified: 0,
      ai_added_ratio: 0,
      ai_deleted_ratio: 0,
      ai_modified_ratio: 0,
      ai_overall_change_ratio: 0,
      line_attribution: { total_added_lines: summary.lines_added, ai_added_lines: 0, human_added_lines: summary.lines_added, files: [] },
      ai_attribution_method: "server_commit_diff_matched_to_ai_code_changes"
    };
  } catch {
    return {
      files_changed: 0,
      lines_added: 0,
      lines_deleted: 0,
      file_paths: [],
      snapshot_kind: "commit",
      ai_assisted: false,
      ai_lines_added: 0,
      ai_lines_deleted: 0,
      ai_lines_modified: 0,
      ai_attribution_method: "server_commit_diff_matched_to_ai_code_changes",
      ai_attribution_evidence: "snapshot_failed",
      human_lines_added: 0,
      human_lines_deleted: 0,
      human_lines_modified: 0,
      ai_added_ratio: 0,
      ai_deleted_ratio: 0,
      ai_modified_ratio: 0,
      ai_overall_change_ratio: 0,
      line_attribution: { total_added_lines: 0, ai_added_lines: 0, human_added_lines: 0, files: [] }
    };
  }
}
async function upstreamRef(workspacePath2) {
  try {
    return await git(workspacePath2, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    return void 0;
  }
}
async function commitCount(workspacePath2, range) {
  try {
    return Number.parseInt(await git(workspacePath2, ["rev-list", "--count", range]), 10) || 0;
  } catch {
    return 0;
  }
}
async function pushSnapshot(workspacePath2, options = {}) {
  const branch = await currentBranch(workspacePath2);
  const headSha = await currentHead(workspacePath2);
  const attr = await attribution(workspacePath2, options);
  const upstream = await upstreamRef(workspacePath2);
  if (!upstream || !headSha) {
    return {
      files_changed: 0,
      lines_added: 0,
      lines_deleted: 0,
      file_paths: [],
      branch,
      head_sha: headSha,
      commit_count: 0,
      snapshot_kind: "push",
      ...attr,
      ai_lines_added: 0,
      ai_lines_deleted: 0,
      ai_attribution_method: "push_range_diff_attributed_to_recent_ai_task"
    };
  }
  try {
    const baseSha = await git(workspacePath2, ["merge-base", "HEAD", upstream]);
    const range = `${baseSha}..HEAD`;
    const summary = parseNumstat(await git(workspacePath2, ["diff", "--numstat", range, "--", "."]));
    return {
      ...summary,
      branch,
      upstream_ref: upstream,
      base_sha: baseSha,
      head_sha: headSha,
      commit_count: await commitCount(workspacePath2, range),
      snapshot_kind: "push",
      ...attr,
      ai_lines_added: attr.ai_assisted ? summary.lines_added : 0,
      ai_lines_deleted: attr.ai_assisted ? summary.lines_deleted : 0,
      ai_attribution_method: "push_range_diff_attributed_to_recent_ai_task"
    };
  } catch {
    return {
      files_changed: 0,
      lines_added: 0,
      lines_deleted: 0,
      file_paths: [],
      branch,
      upstream_ref: upstream,
      head_sha: headSha,
      commit_count: 0,
      snapshot_kind: "push",
      ...attr,
      ai_lines_added: 0,
      ai_lines_deleted: 0,
      ai_attribution_method: "push_range_diff_attributed_to_recent_ai_task"
    };
  }
}
async function installGitHooks(workspacePath2, options) {
  const gitDir = await resolvedGitDir(workspacePath2);
  const hooksDir = join3(gitDir, "hooks");
  await mkdir2(hooksDir, { recursive: true });
  const hookScript = fileURLToPath(new URL("./hook.js", import.meta.url));
  const envFile = options.envFile || process.env.TINYAI_OBS_ENV_FILE || DEFAULT_TINYAI_ENV_FILE;
  const hookTool = process.env.TINYAI_OBS_GIT_HOOK_TOOL || "copilot";
  const fallbackUrls = (options.fallbackUrls && options.fallbackUrls.length > 0 ? options.fallbackUrls : tinyAiCollectorFallbackUrlsForTool(options.tool, workspacePath2)).filter(Boolean);
  const fallbackEnv = fallbackUrls.length > 0 ? fallbackUrls.join(",") : process.env.TINYAI_OBS_COLLECTOR_URLS;
  const setupLines = [
    `TINYAI_OBS_ENV_FILE=${shellQuote(envFile)}`,
    `if [ -f "$TINYAI_OBS_ENV_FILE" ]; then . "$TINYAI_OBS_ENV_FILE"; fi`,
    `if [ -z "\${TINYAI_OBS_COLLECTOR_URL:-}" ]; then TINYAI_OBS_COLLECTOR_URL=${shellQuote(options.collectorUrl || tinyAiCollectorUrlForTool(options.tool, workspacePath2))}; fi`,
    fallbackEnv ? `if [ -z "\${TINYAI_OBS_COLLECTOR_URLS:-}" ]; then TINYAI_OBS_COLLECTOR_URLS=${shellQuote(fallbackEnv)}; fi` : "",
    options.token || process.env.TINYAI_OBS_TOKEN ? `if [ -z "\${TINYAI_OBS_TOKEN:-}" ]; then TINYAI_OBS_TOKEN=${shellQuote(options.token || process.env.TINYAI_OBS_TOKEN || "")}; fi` : "",
    `export TINYAI_OBS_ENV_FILE TINYAI_OBS_COLLECTOR_URL TINYAI_OBS_COLLECTOR_URLS TINYAI_OBS_TOKEN`,
    `export TINYAI_OBS_WORKSPACE=${shellQuote(workspacePath2)}`,
    `if [ -z "\${TINYAI_OBS_GIT_HOOK_TOOL:-}" ]; then TINYAI_OBS_GIT_HOOK_TOOL=${shellQuote(hookTool)}; fi`,
    `export TINYAI_OBS_TOOL="$TINYAI_OBS_GIT_HOOK_TOOL"`,
    `export TINYAI_OBS_HOOK_INSTALLER_TOOL=${shellQuote(options.tool)}`,
    `export TINYAI_OBS_PLUGIN_VERSION=${shellQuote(options.pluginVersion || process.env.TINYAI_OBS_PLUGIN_VERSION || "0.1.0")}`
  ];
  const setupScript = setupLines.filter(Boolean).join("; ");
  const postCommit = managedHookBlock("record commit diff evidence for server-side AI attribution", `${setupScript}; TINYAI_OBS_EVENT_TYPE=commit_snapshot node ${shellQuote(hookScript)} >/dev/null 2>&1 || true`);
  const prePush = managedHookBlock("record AI-attributed branch diff before push", `${setupScript}; TINYAI_OBS_EVENT_TYPE=push_snapshot node ${shellQuote(hookScript)} >/dev/null 2>&1 || true`);
  const preCommitPath = join3(hooksDir, "pre-commit");
  const postCommitPath = join3(hooksDir, "post-commit");
  const prePushPath = join3(hooksDir, "pre-push");
  await removeManagedHook(preCommitPath);
  await writeManagedHook(postCommitPath, postCommit);
  await writeManagedHook(prePushPath, prePush);
  await chmod(postCommitPath, 493);
  await chmod(prePushPath, 493);
  return { installed: [postCommitPath, prePushPath], git_dir: dirname2(hooksDir) };
}
function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
var TINYAI_HOOK_BEGIN = "# >>> TinyAI Observability >>>";
var TINYAI_HOOK_END = "# <<< TinyAI Observability <<<";
var TINYAI_HOOK_RE = new RegExp(`${escapeRegExp(TINYAI_HOOK_BEGIN)}[\\s\\S]*?${escapeRegExp(TINYAI_HOOK_END)}\\n?`, "m");
function managedHookBlock(description, command) {
  return `${TINYAI_HOOK_BEGIN}
# TinyAI Observability: ${description}.
${command}
${TINYAI_HOOK_END}
`;
}
async function writeManagedHook(hookPath, block) {
  let existing = "";
  try {
    existing = await readFile3(hookPath, "utf8");
  } catch {
    existing = "";
  }
  let next;
  if (TINYAI_HOOK_RE.test(existing)) {
    next = existing.replace(TINYAI_HOOK_RE, block);
  } else if (isLegacyTinyAiHook(existing)) {
    next = `#!/bin/sh
${block}`;
  } else if (existing.trim()) {
    next = existing.startsWith("#!") ? `${existing.trimEnd()}

${block}` : `#!/bin/sh
${existing.trimEnd()}

${block}`;
  } else {
    next = `#!/bin/sh
${block}`;
  }
  await writeFile2(hookPath, next, { mode: 493 });
}
async function removeManagedHook(hookPath) {
  let existing = "";
  try {
    existing = await readFile3(hookPath, "utf8");
  } catch {
    return;
  }
  if (!TINYAI_HOOK_RE.test(existing) && !isLegacyTinyAiHook(existing))
    return;
  const next = TINYAI_HOOK_RE.test(existing) ? existing.replace(TINYAI_HOOK_RE, "") : "";
  const normalized = next.trim();
  if (!normalized || normalized === "#!/bin/sh") {
    try {
      await unlink(hookPath);
    } catch {
    }
    return;
  }
  await writeFile2(hookPath, next.endsWith("\n") ? next : `${next}
`, { mode: 493 });
}
function isLegacyTinyAiHook(value) {
  return value.includes("TinyAI Observability:") && value.includes("TINYAI_OBS_EVENT_TYPE=");
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ../../plugin-runtime/dist/spec-detector.js
import { readFile as readFile4, readdir as readdir2 } from "node:fs/promises";
import { join as join4, relative } from "node:path";
function classifySpecPath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  const isCatalog = normalized.includes("/_meta/catalog") || normalized.endsWith("_meta/catalog.yml");
  const isPersonal = normalized.includes("openspec/specs/workspaces/") && normalized.includes("/specs/");
  const isOfficial = normalized.includes("openspec/specs/official/");
  return {
    spec_scope: isCatalog ? "catalog" : isPersonal ? "personal" : isOfficial ? "official" : "unknown",
    doc_path: normalized,
    via_catalog: isCatalog,
    matched_by: inferMatchedBy(normalized),
    fallback_used: false
  };
}
function inferMatchedBy(text) {
  const hits = [];
  if (/keywords?/i.test(text))
    hits.push("keywords");
  if (/related[_-]?code/i.test(text))
    hits.push("related_code");
  if (/modules?/i.test(text))
    hits.push("module");
  if (/tags?/i.test(text))
    hits.push("tags");
  return hits;
}
async function walk(root, maxFiles = 300) {
  const results = [];
  async function visit(dir) {
    if (results.length >= maxFiles)
      return;
    let entries;
    try {
      entries = await readdir2(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles)
        return;
      const path = join4(dir, entry.name);
      if (entry.isDirectory())
        await visit(path);
      else if (/\.(md|ya?ml)$/i.test(entry.name))
        results.push(path);
    }
  }
  await visit(root);
  return results;
}
function inferContentMatchedBy(content, terms) {
  const lower = content.toLowerCase();
  const hits = /* @__PURE__ */ new Set();
  const fields = [
    ["keywords", /keywords?\s*[:\n]/i],
    ["related_code", /related[_-]?code\s*[:\n]/i],
    ["module", /modules?\s*[:\n]/i],
    ["tags", /tags?\s*[:\n]/i]
  ];
  for (const [name, pattern] of fields) {
    const match = pattern.exec(content);
    if (!match || match.index < 0)
      continue;
    const window2 = lower.slice(match.index, match.index + 900);
    if (terms.some((term) => window2.includes(term)))
      hits.add(name);
  }
  if (hits.size === 0 && terms.some((term) => lower.includes(term)))
    hits.add("body");
  return [...hits];
}
async function searchSpecs(workspacePath2, query) {
  const roots = [
    join4(workspacePath2, "openspec", "specs", "workspaces"),
    join4(workspacePath2, "openspec", "specs", "official")
  ];
  const files = (await Promise.all(roots.map((root) => walk(root)))).flat();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const scored = [];
  for (const file of files) {
    const content = await readFile4(file, "utf8").catch(() => "");
    const lower = content.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
    if (score > 0) {
      const hitIndexes = terms.map((term) => lower.indexOf(term)).filter((idx) => idx >= 0);
      const firstHit = Math.max(0, Math.min(...hitIndexes) - 120);
      const relativePath = relative(workspacePath2, file);
      scored.push({
        path: relativePath,
        excerpt: content.slice(firstHit, firstHit + 420),
        score,
        matched_by: [.../* @__PURE__ */ new Set([...inferMatchedBy(relativePath), ...inferContentMatchedBy(content, terms)])]
      });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 10).map(({ path, excerpt, matched_by }) => ({ path, excerpt, matched_by }));
}

// src/extension.ts
var currentTaskId;
var currentModel;
var statusBar;
var panelProvider;
var extensionContext;
var pendingEvents = [];
var conversationMessages = [];
var COPILOT_TRANSCRIPT_STATE_KEY = "tinyaiObservability.copilotTurnSnapshots";
var COPILOT_SESSION_CURSOR_STATE_KEY = "tinyaiObservability.copilotSessionCursors";
var COPILOT_CAPTURE_CAPABILITY = "turn-snapshot-v5";
var CLAUDE_TRANSCRIPT_STATE_KEY = "tinyaiObservability.claudeTurnSnapshots";
var CLAUDE_SESSION_CURSOR_STATE_KEY = "tinyaiObservability.claudeSessionCursors";
var CLAUDE_CAPTURE_CAPABILITY = "claude-turn-snapshot-v1";
var codeChangeFlushTimer;
var EDITOR_CHANGE_BUFFER_MS = 30 * 6e4;
var TURN_EDITOR_WINDOW_BEFORE_MS = 2e3;
var TURN_EDITOR_WINDOW_AFTER_MS = 1e4;
var EDITOR_DELTA_INLINE_LINE_LIMIT = 5e3;
var recentEditorChanges = [];
var pendingTurnStateKeysByEventId = /* @__PURE__ */ new Map();
var LEGACY_DEFAULT_COLLECTOR_URLS = /* @__PURE__ */ new Set([
  "http://192.168.215.94:18080",
  "http://192.168.215.94:18080/",
  "http://10.161.248.127:18080",
  "http://10.161.248.127:18080/"
]);
var lastCopilotCaptureDiagnostics;
function workspacePath() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}
function configuredCollectorUrl() {
  const value = vscode.workspace.getConfiguration("tinyaiObservability").get("collectorUrl")?.trim();
  if (!value || LEGACY_DEFAULT_COLLECTOR_URLS.has(value)) return void 0;
  return value;
}
function config() {
  loadTinyAiEnvFile(workspacePath());
  const cfg = vscode.workspace.getConfiguration("tinyaiObservability");
  return {
    collectorUrl: tinyAiToolEnvValue("copilot", "COLLECTOR_URL", workspacePath()) || configuredCollectorUrl() || DEFAULT_COLLECTOR_URL,
    collectorFallbackUrls: tinyAiCollectorFallbackUrlsForTool("copilot", workspacePath()),
    dashboardUrl: tinyAiToolEnvValue("copilot", "DASHBOARD_URL", workspacePath()) || DEFAULT_DASHBOARD_URL,
    dashboardFallbackUrls: tinyAiDashboardFallbackUrlsForTool("copilot", workspacePath()),
    token: tinyAiToolEnvValue("copilot", "TOKEN", workspacePath()) || cfg.get("token") || "",
    userName: cfg.get("userName")?.trim() || tinyAiToolEnvValue("copilot", "USER_NAME", workspacePath()) || "",
    userId: cfg.get("userId")?.trim() || tinyAiToolEnvValue("copilot", "USER_ID", workspacePath()) || "",
    userEmail: cfg.get("userEmail")?.trim() || tinyAiToolEnvValue("copilot", "USER_EMAIL", workspacePath()) || "",
    team: cfg.get("team")?.trim() || tinyAiToolEnvValue("copilot", "TEAM", workspacePath()) || "",
    captureConversationText: cfg.get("captureConversationText") ?? true,
    captureVisibleReasoningText: cfg.get("captureVisibleReasoningText") ?? false,
    autoCaptureCopilotLocalTranscripts: cfg.get("autoCaptureCopilotLocalTranscripts") ?? true,
    autoCaptureClaudeLocalTranscripts: cfg.get("autoCaptureClaudeLocalTranscripts") ?? true,
    autoCaptureCopilotCodeChanges: cfg.get("autoCaptureCopilotCodeChanges") ?? true,
    autoInstallGitHooks: cfg.get("autoInstallGitHooks") ?? true,
    autoCaptureRecentMinutes: cfg.get("autoCaptureRecentMinutes") ?? 30
  };
}
async function migrateLegacyCollectorUrl() {
  const settings = vscode.workspace.getConfiguration("tinyaiObservability");
  const configured = settings.get("collectorUrl")?.trim();
  if (configured && LEGACY_DEFAULT_COLLECTOR_URLS.has(configured)) {
    await settings.update("collectorUrl", DEFAULT_COLLECTOR_URL, vscode.ConfigurationTarget.Global);
  }
}
var PLUGIN_VERSION = "0.1.39";
function client() {
  const cfg = config();
  return new CollectorClient({
    tool: "copilot",
    workspacePath: workspacePath(),
    baseUrl: cfg.collectorUrl,
    fallbackUrls: cfg.collectorFallbackUrls,
    token: cfg.token,
    pluginName: "tinyai-observability-vscode",
    pluginVersion: PLUGIN_VERSION
  });
}
function gitConfigValue(key) {
  try {
    const value = execFileSync("git", ["-C", workspacePath(), "config", "--get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return value || void 0;
  } catch {
    return void 0;
  }
}
function slugIdentity(value) {
  return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._@-]/g, "");
}
function userIdentity() {
  const cfg = config();
  const gitName = gitConfigValue("user.name");
  const gitEmail = gitConfigValue("user.email");
  const displayName = cfg.userName || process.env.TINYAI_OBS_USER_NAME || process.env.TINYAI_OBS_USER_DISPLAY_NAME || gitName || "";
  const email = cfg.userEmail || process.env.TINYAI_OBS_USER_EMAIL || gitEmail || "";
  const userId = cfg.userId || process.env.TINYAI_OBS_USER_ID || email || (displayName ? slugIdentity(displayName) : "");
  const host = hostname();
  return {
    username: displayName || process.env.USER || process.env.USERNAME || "unknown",
    user_id: userId || void 0,
    user_email: email || void 0,
    user_display_name: displayName || void 0,
    team: cfg.team || process.env.TINYAI_OBS_TEAM || void 0,
    machine_id: vscode.env.machineId ? hashText3(vscode.env.machineId) : void 0,
    host_hash: hashText3(host)
  };
}
function event(eventType, payload = {}, sourceConfidence = "direct", eventId) {
  if (!currentTaskId) return;
  return eventForTask(currentTaskId, eventType, payload, sourceConfidence, eventId);
}
function eventForTask(taskId, eventType, payload = {}, sourceConfidence = "direct", eventId, model, tool = "copilot", eventWorkspacePath = workspacePath()) {
  const payloadSessionId = payload.session_id || payload.sessionId;
  const sessionId = typeof payloadSessionId === "string" && payloadSessionId.trim() ? payloadSessionId.trim() : void 0;
  const createdEvent = makeEvent({
    tool,
    eventType,
    taskId,
    sessionId,
    workspacePath: eventWorkspacePath,
    payload,
    sourceConfidence,
    eventId,
    userIdentity: userIdentity(),
    model: model ?? currentModel
  });
  pendingEvents.push(createdEvent);
  return createdEvent;
}
async function ensureTask(trigger) {
  const created = !currentTaskId;
  if (!currentTaskId) {
    currentTaskId = randomUUID2();
    conversationMessages.splice(0, conversationMessages.length);
  }
  await markAiActivity(workspacePath(), { tool: "copilot", taskId: currentTaskId, source: trigger });
  if (!created) return;
  event("task_start", { trigger });
  updateStatus();
  await flush();
}
function hashText3(text) {
  return createHash6("sha256").update(text).digest("hex").slice(0, 32);
}
function currentCollectorHash() {
  return hashText3(config().collectorUrl.replace(/\/$/, ""));
}
function fileFingerprint(file, capability = COPILOT_CAPTURE_CAPABILITY) {
  return file ? `${file.mtimeMs}:${file.size}:${capability}` : void 0;
}
function queuedOrAcknowledgedSignature(state) {
  if (!state) return void 0;
  if (typeof state === "string") return state;
  return state.status === "queued" || state.status === "uploaded" || state.status === "acknowledged" ? state.signature : void 0;
}
function isSensitiveCodePath(filePath) {
  const normalized = filePath.toLowerCase();
  return /(^|\/)\.env(?:\.|$)/.test(normalized) || /(^|\/)(\.?npmrc|\.?pypirc|\.?netrc|id_rsa|id_ed25519)$/.test(normalized) || /(secret|secrets|credential|credentials|token|private-key|private_key)/.test(normalized);
}
function safeCodeLine(filePath, text) {
  if (isSensitiveCodePath(filePath)) return { text: "[REDACTED:SENSITIVE_FILE]", redacted: true };
  const redacted = redactText(text, { allowFullConversationText: true });
  return { text: redacted, redacted: redacted !== text };
}
function addedLinesFromEdit(filePath, startLine, text) {
  if (!text) return [];
  const rawLines = text.split(/\r?\n/);
  if (rawLines.at(-1) === "") rawLines.pop();
  return rawLines.slice(0, 80).map((line, index) => {
    const display = safeCodeLine(filePath, line);
    return {
      new_line: startLine + index,
      text: display.text,
      text_hash: hashText3(`${filePath}\0${line}`),
      redacted: display.redacted || void 0
    };
  });
}
function displayPath(filePath) {
  const root = workspacePath();
  return filePath.startsWith(`${root}/`) ? filePath.slice(root.length + 1) : filePath.replace(/^file:\/\//, "");
}
function splitPatchLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
function codeEditFromReplacement(filePathInput, oldStringInput, newStringInput, source, toolName) {
  if (typeof filePathInput !== "string" || typeof oldStringInput !== "string" || typeof newStringInput !== "string") return void 0;
  const filePath = displayPath(filePathInput);
  const oldLines = splitPatchLines(oldStringInput);
  const newLines = splitPatchLines(newStringInput);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix + prefix < oldLines.length && suffix + prefix < newLines.length && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) {
    suffix += 1;
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  if (removed.length === 0 && added.length === 0) return void 0;
  const hunkLines = [];
  removed.forEach((line, index) => {
    const display = safeCodeLine(filePath, line);
    hunkLines.push({
      line_type: "removed",
      old_line: prefix + index + 1,
      text: display.text,
      text_hash: hashText3(`${filePath}\0${line}`),
      redacted: display.redacted || void 0
    });
  });
  added.forEach((line, index) => {
    const display = safeCodeLine(filePath, line);
    hunkLines.push({
      line_type: "added",
      new_line: prefix + index + 1,
      text: display.text,
      text_hash: hashText3(`${filePath}\0${line}`),
      redacted: display.redacted || void 0
    });
  });
  return {
    file_path: filePath,
    sensitive: isSensitiveCodePath(filePath),
    lines_added: added.length,
    lines_deleted: removed.length,
    source,
    tool_name: toolName,
    hunks: [
      {
        old_start: prefix + 1,
        old_lines: Math.max(removed.length, 0),
        new_start: prefix + 1,
        new_lines: Math.max(added.length, 0),
        lines: hunkLines
      }
    ]
  };
}
function codeEditsFromApplyPatch(patchInput, source, toolName) {
  if (typeof patchInput !== "string" || !patchInput.includes("*** Begin Patch")) return [];
  const edits = [];
  let current;
  let oldLine = 1;
  let newLine = 1;
  function finish() {
    if (current && current.hunks.some((hunk) => hunk.lines.length > 0)) edits.push(current);
    current = void 0;
  }
  for (const rawLine of patchInput.split(/\r?\n/)) {
    if (rawLine.startsWith("*** Update File: ") || rawLine.startsWith("*** Add File: ")) {
      finish();
      const filePath = displayPath(rawLine.replace(/^\*\*\* (?:Update|Add) File: /, "").trim());
      current = {
        file_path: filePath,
        sensitive: isSensitiveCodePath(filePath),
        lines_added: 0,
        lines_deleted: 0,
        source,
        tool_name: toolName || "apply_patch",
        hunks: [{ old_start: 1, old_lines: 0, new_start: 1, new_lines: 0, lines: [] }]
      };
      oldLine = 1;
      newLine = 1;
      continue;
    }
    if (!current) continue;
    if (rawLine.startsWith("@@")) {
      const hunk2 = { old_start: oldLine, old_lines: 0, new_start: newLine, new_lines: 0, lines: [] };
      current.hunks.push(hunk2);
      continue;
    }
    const hunk = current.hunks.at(-1);
    if (!hunk) continue;
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      const text = rawLine.slice(1);
      const display = safeCodeLine(current.file_path, text);
      hunk.lines.push({
        line_type: "added",
        new_line: newLine,
        text: display.text,
        text_hash: hashText3(`${current.file_path}\0${text}`),
        redacted: display.redacted || void 0
      });
      current.lines_added += 1;
      hunk.new_lines += 1;
      newLine += 1;
    } else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      const text = rawLine.slice(1);
      const display = safeCodeLine(current.file_path, text);
      hunk.lines.push({
        line_type: "removed",
        old_line: oldLine,
        text: display.text,
        text_hash: hashText3(`${current.file_path}\0${text}`),
        redacted: display.redacted || void 0
      });
      current.lines_deleted += 1;
      hunk.old_lines += 1;
      oldLine += 1;
    } else if (rawLine.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  finish();
  return edits.map((edit) => ({ ...edit, hunks: edit.hunks.filter((hunk) => hunk.lines.length > 0) }));
}
function collectCodeEditsFromUnknown(value, output, source, toolName) {
  if (!value) return;
  if (typeof value === "string") {
    try {
      collectCodeEditsFromUnknown(JSON.parse(value), output, source, toolName);
    } catch {
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCodeEditsFromUnknown(item, output, source, toolName);
    return;
  }
  if (typeof value !== "object") return;
  const record4 = value;
  const currentToolName = readableValue(record4.toolName || record4.name || record4.toolId || record4.invocationMessage || toolName);
  const directEdit = codeEditFromReplacement(
    record4.filePath ?? record4.path ?? record4.file,
    record4.oldString ?? record4.old_string,
    record4.newString ?? record4.new_string,
    source,
    currentToolName || toolName
  );
  if (directEdit) output.push(directEdit);
  const args = record4.arguments ?? record4.input ?? record4;
  if (args && typeof args === "object") {
    const argRecord = args;
    for (const edit2 of codeEditsFromApplyPatch(argRecord.input ?? argRecord.patch, source, currentToolName || toolName)) output.push(edit2);
    const edit = codeEditFromReplacement(
      argRecord.filePath ?? argRecord.path ?? argRecord.file,
      argRecord.oldString ?? argRecord.old_string,
      argRecord.newString ?? argRecord.new_string,
      source,
      currentToolName || toolName
    );
    if (edit) output.push(edit);
  } else if (typeof args === "string") {
    collectCodeEditsFromUnknown(args, output, source, currentToolName || toolName);
  }
  for (const item of Object.values(record4)) collectCodeEditsFromUnknown(item, output, source, currentToolName || toolName);
}
function dedupeCodeEdits(edits) {
  const seen = /* @__PURE__ */ new Set();
  return edits.filter((edit) => {
    const key = `${edit.file_path}:${edit.lines_added}:${edit.lines_deleted}:${JSON.stringify(edit.hunks)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function editorChangePayload(change) {
  const filePath = vscode.workspace.asRelativePath(change.document.uri, false);
  const changeRecords = change.contentChanges.map((item) => {
    const removedLineCount = item.rangeLength > 0 ? Math.max(1, item.range.end.line - item.range.start.line + 1) : 0;
    const addedLines = addedLinesFromEdit(filePath, item.range.start.line + 1, item.text);
    return {
      file_path: filePath,
      range_start_line: item.range.start.line + 1,
      range_end_line: item.range.end.line + 1,
      range_length: item.rangeLength,
      added_line_count: addedLines.length,
      removed_line_count: removedLineCount,
      added_lines: addedLines,
      sensitive: isSensitiveCodePath(filePath) || void 0
    };
  });
  const linesAdded = changeRecords.reduce((sum, item) => sum + item.added_line_count, 0);
  const linesDeleted = changeRecords.reduce((sum, item) => sum + item.removed_line_count, 0);
  const keepInlineChanges = linesAdded + linesDeleted <= EDITOR_DELTA_INLINE_LINE_LIMIT;
  return {
    snapshot_kind: "vscode_text_change",
    trigger: "edit",
    file_path: filePath,
    files_changed: 1,
    lines_added: linesAdded,
    lines_deleted: linesDeleted,
    change_count: change.contentChanges.length,
    include_text: true,
    inline_line_limit: EDITOR_DELTA_INLINE_LINE_LIMIT,
    line_detail_policy: keepInlineChanges ? "inline_changes" : "summary_only",
    truncated: !keepInlineChanges,
    changes: keepInlineChanges ? changeRecords : []
  };
}
function pruneEditorChangeBuffer(nowMs = Date.now()) {
  const cutoff = nowMs - EDITOR_CHANGE_BUFFER_MS;
  while (recentEditorChanges.length > 0 && recentEditorChanges[0].occurred_at_ms < cutoff) {
    recentEditorChanges.shift();
  }
}
function rememberEditorChange(change) {
  const occurredAtMs = Date.now();
  const payload = editorChangePayload(change);
  recentEditorChanges.push({
    occurred_at: new Date(occurredAtMs).toISOString(),
    occurred_at_ms: occurredAtMs,
    payload
  });
  pruneEditorChangeBuffer(occurredAtMs);
  return payload;
}
function timestampMs(value) {
  if (!value) return void 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? void 0 : parsed;
}
function turnEditorWindow(snapshot) {
  const completedAtMs = timestampMs(snapshot.turn.completed_at || snapshot.assistant_message?.occurred_at);
  if (!completedAtMs) return void 0;
  const startedAtMs = timestampMs(snapshot.turn.started_at) ?? timestampMs(snapshot.user_message?.occurred_at) ?? completedAtMs;
  return {
    startMs: startedAtMs - TURN_EDITOR_WINDOW_BEFORE_MS,
    endMs: completedAtMs + TURN_EDITOR_WINDOW_AFTER_MS
  };
}
function bufferedEditorChangesForTurn(snapshot) {
  const window2 = turnEditorWindow(snapshot);
  if (!window2) return [];
  pruneEditorChangeBuffer();
  return recentEditorChanges.filter((entry) => entry.occurred_at_ms >= window2.startMs && entry.occurred_at_ms <= window2.endMs);
}
function editorDeltaFiles(entries) {
  const files = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const filePath = typeof entry.payload.file_path === "string" ? entry.payload.file_path : void 0;
    if (!filePath) continue;
    const existing = files.get(filePath) || {
      file_path: filePath,
      sensitive: isSensitiveCodePath(filePath) || void 0,
      lines_added: 0,
      lines_deleted: 0,
      change_count: 0,
      changes: [],
      source: "vscode_text_change_buffer",
      first_occurred_at: entry.occurred_at,
      last_occurred_at: entry.occurred_at
    };
    existing.lines_added += Number(entry.payload.lines_added || 0);
    existing.lines_deleted += Number(entry.payload.lines_deleted || 0);
    existing.change_count += Number(entry.payload.change_count || 0);
    existing.last_occurred_at = entry.occurred_at;
    for (const change of entry.payload.changes) {
      existing.changes.push({ ...change, occurred_at: entry.occurred_at });
    }
    files.set(filePath, existing);
  }
  return Array.from(files.values()).filter((file) => file.lines_added > 0 || file.lines_deleted > 0 || file.changes.length > 0);
}
function normalizeTurnDiffPath(raw, rootPath = workspacePath()) {
  let candidate = cleanReadPath(raw) || raw.trim();
  if (!candidate || candidate.length > 1e3 || candidate.includes("\0")) return void 0;
  candidate = candidate.replace(/^file:\/\//, "").replace(/\\/g, "/");
  const workspace2 = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
  if (candidate.startsWith(`${workspace2}/`)) candidate = candidate.slice(workspace2.length + 1);
  candidate = candidate.replace(/^\.?\//, "");
  if (candidate.startsWith("a/") || candidate.startsWith("b/")) candidate = candidate.slice(2);
  if (!candidate || /^(https?:|data:|[a-z]+:\/\/)/i.test(candidate)) return void 0;
  return candidate;
}
var PROJECT_SPEC_ROOT = "openspec/specs";
var PROJECT_SPEC_ABSOLUTE_ROOT = "/Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs";
var SPEC_READ_TOOLS = /* @__PURE__ */ new Set(["read_file"]);
var SPEC_DIRECTORY_TOOLS = /* @__PURE__ */ new Set(["list_dir", "list_directory"]);
var SPEC_EDIT_TOOLS = /* @__PURE__ */ new Set(["replace_string_in_file", "create_file", "edit_file", "apply_patch"]);
function normalizeSpecDocPath(raw, cwd3) {
  if (!raw) return void 0;
  let candidate = cleanReadPath(raw) || raw.trim();
  if (!candidate || candidate.includes("\0")) return void 0;
  candidate = candidate.replace(/^file:\/\//, "").replace(/\\/g, "/").replace(/^['"`]|['"`]$/g, "");
  const normalizedCwd = cwd3.replace(/\\/g, "/").replace(/\/$/, "");
  if (candidate.startsWith(`${normalizedCwd}/`)) candidate = candidate.slice(normalizedCwd.length + 1);
  candidate = candidate.replace(/^\.?\//, "");
  const marker = `${PROJECT_SPEC_ROOT}/`;
  const markerIndex = candidate.indexOf(marker);
  if (markerIndex >= 0) candidate = candidate.slice(markerIndex);
  if (!candidate.startsWith(marker)) return void 0;
  if (!/\.[A-Za-z0-9]+$/.test(candidate)) return void 0;
  return candidate.replace(/[),.;:\s]+$/, "");
}
function jsonRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}
function toolArguments(tool) {
  return jsonRecord(tool.arguments_raw);
}
function toolPathArgument(args) {
  for (const key of ["filePath", "file_path", "path", "file", "uri"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return void 0;
}
function addSpecAccess(map, docPath, accessType, source, toolName, occurredAt, matchedDocs, sourceKey) {
  if (!docPath) return;
  const docs = matchedDocs && matchedDocs.length > 0 ? [...new Set(matchedDocs)].sort() : docPath !== PROJECT_SPEC_ROOT ? [docPath] : [];
  const key = `${sourceKey || source}:${accessType}:${docPath}`;
  if (map.has(key)) return;
  const matchedBy = ["derived", source, `access:${accessType}`];
  if (toolName) matchedBy.push(`tool:${toolName}`);
  map.set(key, {
    spec_scope: "project",
    doc_path: docPath,
    access_type: accessType,
    access_source: source,
    matched_doc_count: docs.length,
    matched_docs: docs,
    source_key: sourceKey || key,
    via_catalog: false,
    matched_by: matchedBy,
    confidence: "derived",
    occurred_at: occurredAt
  });
}
function specPathsInCommand(command, cwd3) {
  const paths = /* @__PURE__ */ new Set();
  const pathPattern = /(?:file:\/\/)?(?:\/[^\s"'`<>\]\)]+\/)?openspec\/specs\/[^\s"'`<>\]\);|]+?\.[A-Za-z0-9]+/gi;
  for (const match of command.matchAll(pathPattern)) {
    const normalized = normalizeSpecDocPath(match[0], cwd3);
    if (normalized) paths.add(normalized);
  }
  return [...paths];
}
function terminalCommandReadsSpecDirectory(command) {
  if (!command.includes(PROJECT_SPEC_ROOT)) return false;
  return /\b(read_text|readBytes|readFileSync|readFile|open\s*\(|cat\s+|head\s+|tail\s+|sed\s+-n|find\s+|ls\s+|stat\s+|wc\s+|du\s+|os\.listdir|iterdir\s*\(|glob\s*\()\b/i.test(command);
}
function terminalCommandEditsSpecs(command) {
  if (!command.includes(PROJECT_SPEC_ROOT)) return false;
  return /\b(write_text|writeFileSync|writeFile|appendFile|open\s*\([^)]*['"]w|tee\s+)|>\s*(?:['"])?[^\n]*openspec\/specs\//i.test(command);
}
function projectSpecRootCandidates(cwd3) {
  return [...new Set([join5(cwd3, PROJECT_SPEC_ROOT), PROJECT_SPEC_ABSOLUTE_ROOT].map((item) => item.replace(/\\/g, "/").replace(/\/$/, "")))];
}
async function projectSpecFileEntries(cwd3) {
  async function visit(root, relativeDir) {
    const absoluteDir = relativeDir ? join5(root, relativeDir) : root;
    let entries;
    try {
      entries = await readdir3(absoluteDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const results = [];
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}`.replace(/\\/g, "/") : entry.name;
      if (entry.isDirectory()) {
        results.push(...await visit(root, relativePath));
      } else if (entry.isFile()) {
        results.push({
          doc_path: `${PROJECT_SPEC_ROOT}/${relativePath}`.replace(/\\/g, "/"),
          absolute_path: join5(root, relativePath)
        });
      }
    }
    return results;
  }
  for (const root of projectSpecRootCandidates(cwd3)) {
    const rootStat = await stat3(root).catch(() => void 0);
    if (rootStat?.isDirectory()) return visit(root, "");
  }
  return [];
}
async function listProjectSpecFiles(cwd3) {
  return (await projectSpecFileEntries(cwd3)).map((entry) => entry.doc_path);
}
async function projectSpecDocuments(cwd3) {
  const docs = await projectSpecFileEntries(cwd3);
  const records = [];
  for (const doc of docs) {
    try {
      const [fileStat, content] = await Promise.all([stat3(doc.absolute_path), readFile5(doc.absolute_path)]);
      records.push({
        spec_scope: "project",
        doc_path: doc.doc_path,
        file_name: basename2(doc.doc_path),
        size_bytes: fileStat.size,
        line_count: content.length === 0 ? 0 : content.toString("utf8").split(/\r\n|\r|\n/).length,
        content_hash: createHash6("sha256").update(content).digest("hex"),
        mtime_ms: fileStat.mtimeMs,
        exists: true
      });
    } catch {
    }
  }
  return records.sort((a, b) => a.doc_path.localeCompare(b.doc_path));
}
async function specAccessesFromCopilotTurn(snapshot, cwd3) {
  const accesses = /* @__PURE__ */ new Map();
  for (const tool of snapshot.tool_calls || []) {
    const toolName = String(tool.tool_name || "");
    const args = toolArguments(tool);
    const occurredAt = tool.completed_at || tool.started_at || snapshot.turn.completed_at;
    const sourceKey = tool.tool_call_id || `${toolName}:${occurredAt || ""}`;
    if (SPEC_READ_TOOLS.has(toolName) || SPEC_EDIT_TOOLS.has(toolName)) {
      const accessType = SPEC_READ_TOOLS.has(toolName) ? "read" : "edit";
      addSpecAccess(accesses, normalizeSpecDocPath(toolPathArgument(args), cwd3), accessType, "tool_call", toolName, occurredAt, void 0, sourceKey);
    }
    if (SPEC_DIRECTORY_TOOLS.has(toolName)) {
      const pathArg = toolPathArgument(args);
      const normalized = pathArg?.replace(/^file:\/\//, "").replace(/\\/g, "/").replace(/\/$/, "");
      const cwdRoot = join5(cwd3, PROJECT_SPEC_ROOT).replace(/\\/g, "/").replace(/\/$/, "");
      if (normalized === PROJECT_SPEC_ROOT || normalized === cwdRoot || normalized?.endsWith(`/${PROJECT_SPEC_ROOT}`)) {
        addSpecAccess(accesses, PROJECT_SPEC_ROOT, "read", "tool_call", toolName, occurredAt, await listProjectSpecFiles(cwd3), sourceKey);
      }
    }
    if (toolName !== "run_in_terminal") continue;
    const command = typeof args.command === "string" ? args.command : "";
    if (!command) continue;
    const commandEdit = terminalCommandEditsSpecs(command);
    const commandRead = terminalCommandReadsSpecDirectory(command);
    const explicitDocs = specPathsInCommand(command, cwd3);
    if (explicitDocs.length > 0) {
      const accessType = commandEdit ? "edit" : "read";
      const docPath = explicitDocs.length === 1 ? explicitDocs[0] : PROJECT_SPEC_ROOT;
      addSpecAccess(accesses, docPath, accessType, "terminal_command", toolName, occurredAt, explicitDocs, sourceKey);
    }
    if (commandRead && !commandEdit) {
      addSpecAccess(accesses, PROJECT_SPEC_ROOT, "read", "terminal_command", toolName, occurredAt, await listProjectSpecFiles(cwd3), sourceKey);
    }
  }
  return [...accesses.values()];
}
function collectCodePathsFromString(text, output, rootPath = workspacePath()) {
  const pathPattern = /(?:file:\/\/)?(?:\/[^\s"'`<>\]\)]+\/)?[A-Za-z0-9._@+~/-]+\.(?:[cm]?[jt]sx?|json|ya?ml|md|py|java|kt|go|rs|rb|php|cs|cpp|c|h|hpp|sql|html|css|scss|less|vue|svelte|xml|toml|ini|env|sh|zsh|bash|gradle|properties|txt)(?::\d+(?:-\d+)?)?/gi;
  for (const match of text.matchAll(pathPattern)) {
    const rawPath = match[0];
    if (!rawPath.includes("/") && !rawPath.includes("\\") && !rawPath.startsWith(".") && !rawPath.startsWith("file://")) {
      continue;
    }
    const normalized = normalizeTurnDiffPath(rawPath, rootPath);
    if (normalized) output.add(normalized);
  }
}
function collectCodePathsFromUnknown(value, output, rootPath = workspacePath()) {
  if (typeof value === "string") {
    collectCodePathsFromString(value, output, rootPath);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCodePathsFromUnknown(item, output, rootPath);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record4 = value;
  for (const key of ["path", "file", "filePath", "filepath", "fsPath", "uri", "resource", "target"]) {
    const field = record4[key];
    if (typeof field === "string") {
      const normalized = normalizeTurnDiffPath(field, rootPath);
      if (normalized) output.add(normalized);
    }
  }
  for (const item of Object.values(record4)) collectCodePathsFromUnknown(item, output, rootPath);
}
function hasExternalFileWriteSignal(snapshot) {
  const haystack = JSON.stringify({
    user: snapshot.user_message,
    assistant: snapshot.assistant_message,
    steps: snapshot.process_steps,
    tools: snapshot.tool_calls
  }).toLowerCase();
  return /(run_in_terminal|terminal|shell|bash|zsh|python\d?|node|ruby|perl|执行命令|运行命令|脚本|写入文件|追加)/i.test(haystack);
}
function turnWorkspaceDiffPaths(snapshot, toolFiles, editorFiles, editorEntries, rootPath = workspacePath()) {
  const paths = /* @__PURE__ */ new Set();
  for (const file of [...toolFiles, ...editorFiles]) {
    const normalized = normalizeTurnDiffPath(file.file_path, rootPath);
    if (normalized) paths.add(normalized);
  }
  for (const entry of editorEntries) {
    const normalized = typeof entry.payload.file_path === "string" ? normalizeTurnDiffPath(entry.payload.file_path, rootPath) : void 0;
    if (normalized) paths.add(normalized);
  }
  collectCodePathsFromUnknown(snapshot.user_message, paths, rootPath);
  collectCodePathsFromUnknown(snapshot.assistant_message, paths, rootPath);
  collectCodePathsFromUnknown(snapshot.process_steps, paths, rootPath);
  collectCodePathsFromUnknown(snapshot.tool_calls, paths, rootPath);
  collectCodePathsFromUnknown(snapshot.sub_agents, paths, rootPath);
  collectCodePathsFromUnknown(snapshot.code_changes, paths, rootPath);
  return [...paths].slice(0, 50);
}
function codeEditsFromCopilotTurn(snapshot) {
  const edits = [];
  collectCodeEditsFromUnknown(snapshot.tool_calls, edits, "copilot_turn_tool_calls");
  collectCodeEditsFromUnknown(snapshot.process_steps, edits, "copilot_turn_process_steps");
  collectCodeEditsFromUnknown(snapshot.sub_agents, edits, "copilot_turn_sub_agents");
  return dedupeCodeEdits(edits);
}
async function recordCopilotTurnEditorDelta(snapshot, taskId, turnClientId) {
  if (!config().autoCaptureCopilotCodeChanges) return;
  const toolFiles = codeEditsFromCopilotTurn(snapshot);
  const toolPaths = new Set(toolFiles.map((file) => file.file_path));
  const editorEntries = bufferedEditorChangesForTurn(snapshot);
  const editorFiles = editorDeltaFiles(editorEntries).filter((file) => !toolPaths.has(file.file_path));
  const files = [...toolFiles, ...editorFiles];
  if (files.length > 0) {
    const linesAdded = files.reduce((sum, file) => sum + Number(file.lines_added || 0), 0);
    const linesDeleted = files.reduce((sum, file) => sum + Number(file.lines_deleted || 0), 0);
    const signature = hashText3(JSON.stringify(files));
    eventForTask(
      taskId,
      "code_change",
      {
        session_id: snapshot.session_id,
        request_id: snapshot.request_id,
        response_id: snapshot.response_id,
        turn_index: snapshot.turn_index,
        attempt: snapshot.attempt,
        turn_started_at: snapshot.turn.started_at,
        turn_completed_at: snapshot.turn.completed_at,
        snapshot_kind: "copilot_turn_editor_delta",
        trigger: "auto_copilot_turn_completed",
        attribution_scope: "turn_delta",
        ai_assisted: true,
        attribution_evidence: "copilot_turn_tool_calls_or_vscode_editor_changes",
        capture_strategy: toolFiles.length > 0 && editorFiles.length > 0 ? "tool_call_delta+editor_delta" : toolFiles.length > 0 ? "tool_call_delta" : "editor_delta",
        files_changed: files.length,
        lines_added: linesAdded,
        lines_deleted: linesDeleted,
        include_text: true,
        truncated: files.some((file) => Boolean(file.truncated)),
        file_paths: files.map((file) => file.file_path).slice(0, 100),
        files,
        capture_note: "Per-turn code delta captured from Copilot tool-call edit payloads and VS Code text document change events within the request/response time window. This intentionally excludes pre-existing workspace git diff."
      },
      "derived",
      stableEventId(
        `copilot:turn_editor_delta:${turnClientId}:${workspacePath()}:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}:${signature}`
      ),
      snapshot.model
    );
  }
  await recordCopilotTurnWorkspaceDiffFallback(snapshot, taskId, turnClientId, toolFiles, editorFiles, editorEntries);
}
async function recordCopilotTurnWorkspaceDiffFallback(snapshot, taskId, turnClientId, toolFiles, editorFiles, editorEntries) {
  if (!hasExternalFileWriteSignal(snapshot)) return;
  const paths = turnWorkspaceDiffPaths(snapshot, toolFiles, editorFiles, editorEntries);
  if (paths.length === 0) return;
  const diff = await currentDiffDetails(workspacePath(), {
    includeText: true,
    includeUntracked: true,
    maxFiles: 50,
    maxLinesPerFile: EDITOR_DELTA_INLINE_LINE_LIMIT + 1,
    paths
  });
  if (!diff.files.length || diff.lines_added + diff.lines_deleted === 0) return;
  const totalLines = diff.lines_added + diff.lines_deleted;
  const signature = hashText3(JSON.stringify([diff.diff_hash, diff.file_paths, diff.lines_added, diff.lines_deleted]));
  eventForTask(
    taskId,
    "code_change",
    {
      session_id: snapshot.session_id,
      request_id: snapshot.request_id,
      response_id: snapshot.response_id,
      turn_index: snapshot.turn_index,
      attempt: snapshot.attempt,
      turn_started_at: snapshot.turn.started_at,
      turn_completed_at: snapshot.turn.completed_at,
      snapshot_kind: "copilot_turn_workspace_diff",
      trigger: "auto_copilot_turn_completed",
      attribution_scope: "turn_workspace_diff",
      ai_assisted: true,
      attribution_evidence: "copilot_turn_external_file_write_fallback",
      capture_strategy: "workspace_diff_fallback_for_terminal_or_external_file_write",
      files_changed: diff.files_changed,
      lines_added: diff.lines_added,
      lines_deleted: diff.lines_deleted,
      diff_hash: diff.diff_hash,
      diff_raw: diff.diff_raw,
      include_text: true,
      inline_line_limit: EDITOR_DELTA_INLINE_LINE_LIMIT,
      line_detail_policy: totalLines <= EDITOR_DELTA_INLINE_LINE_LIMIT ? "inline_hunks" : "summary_only",
      truncated: diff.truncated || totalLines > EDITOR_DELTA_INLINE_LINE_LIMIT,
      file_paths: diff.file_paths,
      files: diff.files.map((file) => ({
        ...file,
        source: "workspace_diff_fallback",
        snapshot_kind: "copilot_turn_workspace_diff"
      })),
      related_path_candidates: paths,
      capture_note: "Fallback code evidence captured after a Copilot turn with terminal/script/external-write signals. It is limited to files related to this turn, so terminal-written files can be captured even when VS Code editor delta is incomplete."
    },
    "derived",
    stableEventId(
      `copilot:turn_workspace_diff:${turnClientId}:${workspacePath()}:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}:${signature}`
    ),
    snapshot.model
  );
}
function codeEditsFromClaudeTurn(snapshot) {
  const edits = (snapshot.code_changes || []).map((change) => ({
    file_path: displayPath(String(change.file_path || "")),
    sensitive: isSensitiveCodePath(String(change.file_path || "")),
    lines_added: Number(change.lines_added || 0),
    lines_deleted: Number(change.lines_deleted || 0),
    hunks: Array.isArray(change.hunks) ? change.hunks : [],
    source: "claude_turn_tool_patch",
    tool_name: change.tool_name
  })).filter((change) => change.file_path && (change.lines_added > 0 || change.lines_deleted > 0 || change.hunks.length > 0));
  return dedupeCodeEdits(edits);
}
async function recordClaudeTurnEditorDelta(snapshot, taskId, turnClientId) {
  if (!config().autoCaptureCopilotCodeChanges) return;
  const cwd3 = snapshot.cwd || workspacePath();
  const toolFiles = codeEditsFromClaudeTurn(snapshot);
  const toolPaths = new Set(toolFiles.map((file) => normalizeTurnDiffPath(file.file_path, cwd3) || file.file_path));
  const editorEntries = bufferedEditorChangesForTurn(snapshot);
  const editorFiles = editorDeltaFiles(editorEntries).filter((file) => {
    const normalized = normalizeTurnDiffPath(file.file_path, cwd3) || file.file_path;
    return !toolPaths.has(normalized);
  });
  const files = [...editorFiles];
  if (files.length > 0) {
    const linesAdded = files.reduce((sum, file) => sum + Number(file.lines_added || 0), 0);
    const linesDeleted = files.reduce((sum, file) => sum + Number(file.lines_deleted || 0), 0);
    const signature = hashText3(JSON.stringify(files));
    eventForTask(
      taskId,
      "code_change",
      {
        session_id: snapshot.session_id,
        request_id: snapshot.request_id,
        response_id: snapshot.response_id,
        turn_index: snapshot.turn_index,
        attempt: snapshot.attempt,
        turn_started_at: snapshot.turn.started_at,
        turn_completed_at: snapshot.turn.completed_at,
        snapshot_kind: "claude_turn_editor_delta",
        trigger: "auto_claude_turn_completed",
        attribution_scope: "turn_delta",
        ai_assisted: true,
        attribution_evidence: "claude_jsonl_or_vscode_editor_changes",
        capture_strategy: "editor_delta",
        files_changed: files.length,
        lines_added: linesAdded,
        lines_deleted: linesDeleted,
        include_text: true,
        truncated: files.some((file) => Boolean(file.truncated)),
        file_paths: files.map((file) => file.file_path).slice(0, 100),
        files,
        cwd: cwd3,
        capture_note: "Per-turn code delta captured from VS Code text document changes near a Claude turn. It is used when Claude JSONL does not include explicit edit/write tool arguments."
      },
      "derived",
      stableEventId(
        `claude:turn_editor_delta:${turnClientId}:${cwd3}:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}:${signature}`
      ),
      snapshot.model,
      "claude",
      cwd3
    );
  }
  await recordClaudeTurnWorkspaceDiffFallback(snapshot, taskId, turnClientId, toolFiles, editorFiles, editorEntries);
}
async function recordClaudeTurnWorkspaceDiffFallback(snapshot, taskId, turnClientId, toolFiles, editorFiles, editorEntries) {
  if (!hasExternalFileWriteSignal(snapshot)) return;
  const cwd3 = snapshot.cwd || workspacePath();
  const paths = turnWorkspaceDiffPaths(snapshot, toolFiles, editorFiles, editorEntries, cwd3);
  if (paths.length === 0) return;
  const diff = await currentDiffDetails(cwd3, {
    includeText: true,
    includeUntracked: true,
    maxFiles: 50,
    maxLinesPerFile: EDITOR_DELTA_INLINE_LINE_LIMIT + 1,
    paths
  });
  if (!diff.files.length || diff.lines_added + diff.lines_deleted === 0) return;
  const totalLines = diff.lines_added + diff.lines_deleted;
  const signature = hashText3(JSON.stringify([diff.diff_hash, diff.file_paths, diff.lines_added, diff.lines_deleted]));
  eventForTask(
    taskId,
    "code_change",
    {
      session_id: snapshot.session_id,
      request_id: snapshot.request_id,
      response_id: snapshot.response_id,
      turn_index: snapshot.turn_index,
      attempt: snapshot.attempt,
      turn_started_at: snapshot.turn.started_at,
      turn_completed_at: snapshot.turn.completed_at,
      snapshot_kind: "claude_turn_workspace_diff",
      trigger: "auto_claude_turn_completed",
      attribution_scope: "turn_workspace_diff",
      ai_assisted: true,
      attribution_evidence: "claude_turn_external_file_write_fallback",
      capture_strategy: "workspace_diff_fallback_for_terminal_or_external_file_write",
      files_changed: diff.files_changed,
      lines_added: diff.lines_added,
      lines_deleted: diff.lines_deleted,
      diff_hash: diff.diff_hash,
      diff_raw: diff.diff_raw,
      include_text: true,
      inline_line_limit: EDITOR_DELTA_INLINE_LINE_LIMIT,
      line_detail_policy: totalLines <= EDITOR_DELTA_INLINE_LINE_LIMIT ? "inline_hunks" : "summary_only",
      truncated: diff.truncated || totalLines > EDITOR_DELTA_INLINE_LINE_LIMIT,
      file_paths: diff.file_paths,
      files: diff.files.map((file) => ({
        ...file,
        source: "workspace_diff_fallback",
        snapshot_kind: "claude_turn_workspace_diff"
      })),
      cwd: cwd3,
      related_path_candidates: paths,
      capture_note: "Fallback code evidence captured after a Claude turn with terminal/script/external-write signals. It is limited to files related to this turn and uses the Claude JSONL cwd as the git diff root."
    },
    "derived",
    stableEventId(
      `claude:turn_workspace_diff:${turnClientId}:${cwd3}:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}:${signature}`
    ),
    snapshot.model,
    "claude",
    cwd3
  );
}
function scheduleFlush(delayMs = 1200) {
  if (codeChangeFlushTimer) clearTimeout(codeChangeFlushTimer);
  codeChangeFlushTimer = setTimeout(() => {
    codeChangeFlushTimer = void 0;
    void flush();
  }, delayMs);
}
function appendConversationMessage(role, text, source) {
  const message = conversationMessage(role, text, source);
  if (message) conversationMessages.push(message);
}
function conversationMessage(role, text, source, sourceKey, occurredAt) {
  const trimmed = text.trim();
  if (!trimmed) return void 0;
  const includeText = config().captureConversationText;
  const message = {
    role,
    text_len: trimmed.length,
    text_hash: hashText3(trimmed),
    source,
    source_key: sourceKey,
    occurred_at: occurredAt
  };
  if (includeText) message.text = trimmed;
  return message;
}
function readableValue(value, fallback = "") {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => readableValue(item)).filter(Boolean).join(" ") || fallback;
  if (value && typeof value === "object") {
    const record4 = value;
    for (const key of ["name", "toolName", "displayName", "label", "title", "id", "kind", "command"]) {
      const text2 = readableValue(record4[key]);
      if (text2) return text2;
    }
    const text = readableValue(record4.value) || readableValue(record4.message) || readableValue(record4.input);
    if (text) return text;
  }
  return fallback;
}
function cleanReadPath(raw) {
  let candidate = raw.trim();
  const markdownLink = /\[[^\]]*\]\(([^)]+)\)/.exec(candidate);
  if (markdownLink) candidate = markdownLink[1];
  candidate = candidate.replace(/^\]\(/, "").replace(/^file:\/\//, "").replace(/#.*/, "").replace(/^[`"'\[(<\s]+/, "").replace(/[`"'\])>,.;:\s]+$/, "");
  const extensionMatch = /^(.*?\.(?:[cm]?[jt]sx?|json|ya?ml|md|py|java|kt|go|rs|rb|php|cs|cpp|c|h|hpp|sql|html|css|scss|less|vue|svelte|xml|toml|ini|env|sh|zsh|bash|dockerfile|gradle|properties|txt))(?:$|[#?:,)\]\s].*)/i.exec(candidate);
  if (extensionMatch) candidate = extensionMatch[1];
  if (!candidate || candidate.length > 500) return void 0;
  if (/^(https?:|data:|[a-z]+:\/\/)/i.test(candidate)) return void 0;
  if (!/[./\\]/.test(candidate)) return void 0;
  return candidate;
}
function appendTranscriptText(text, source) {
  const lines = text.split(/\r?\n/);
  let currentRole = "transcript";
  let buffer = [];
  const flushBuffer = () => {
    const body = buffer.join("\n").trim();
    if (body) appendConversationMessage(currentRole, body, source);
    buffer = [];
  };
  for (const line of lines) {
    const match = /^(user|human|assistant|copilot|github copilot|tinyai|claude|codex)\s*:\s*(.*)$/i.exec(line);
    if (match) {
      flushBuffer();
      currentRole = /^(user|human)$/i.test(match[1]) ? "user" : "assistant";
      buffer.push(match[2]);
    } else {
      buffer.push(line);
    }
  }
  flushBuffer();
}
function looksLikeCommandText(text) {
  const trimmed = text.trim();
  return /^TinyAI Observability:/i.test(trimmed) || /^>\s*TinyAI Observability:/i.test(trimmed);
}
function conversationSnapshotPayload() {
  const userMessageCount = conversationMessages.filter((message) => message.role === "user").length;
  const assistantMessageCount = conversationMessages.filter((message) => message.role === "assistant").length;
  return {
    session_id: currentTaskId,
    session_file: "vscode-extension-memory",
    cwd: workspacePath(),
    source: "vscode-copilot-extension",
    message_count: conversationMessages.length,
    user_message_count: userMessageCount,
    assistant_message_count: assistantMessageCount,
    user_followup_count: Math.max(userMessageCount - 1, 0),
    turn_started_count: userMessageCount,
    turn_completed_count: assistantMessageCount,
    turn_aborted_count: 0,
    task_repeat_attempts: Math.max(userMessageCount - 1, 0),
    tool_call_count: 0,
    tool_result_count: 0,
    patch_apply_count: 0,
    patch_success_count: 0,
    include_text: config().captureConversationText,
    capture_limitations: "Direct capture covers @tinyai, TinyAI LM tools, and user-imported transcripts. Regular GitHub Copilot Chat is captured from local VS Code workspaceStorage transcript JSONL files when present, and is classified as derived because it is read from persisted local transcript files rather than the Copilot Chat API.",
    messages: conversationMessages
  };
}
function emitConversationSnapshot(sourceConfidence = "derived") {
  if (!currentTaskId || conversationMessages.length === 0) return;
  event("conversation_snapshot", conversationSnapshotPayload(), sourceConfidence);
}
function workspaceStorageRoot() {
  if (!extensionContext?.storageUri?.fsPath) return void 0;
  return dirname3(extensionContext.storageUri.fsPath);
}
async function workspaceStorageRoots() {
  const roots = /* @__PURE__ */ new Set();
  const currentRoot = workspaceStorageRoot();
  if (currentRoot) roots.add(currentRoot);
  const userDataRoots = [
    join5(homedir3(), "Library", "Application Support", "Code", "User", "workspaceStorage"),
    join5(homedir3(), "Library", "Application Support", "Code - Insiders", "User", "workspaceStorage"),
    join5(homedir3(), "Library", "Application Support", "Cursor", "User", "workspaceStorage"),
    join5(homedir3(), ".config", "Code", "User", "workspaceStorage"),
    join5(homedir3(), ".config", "Code - Insiders", "User", "workspaceStorage"),
    join5(homedir3(), ".config", "Cursor", "User", "workspaceStorage")
  ];
  if (process.env.APPDATA) {
    userDataRoots.push(
      join5(process.env.APPDATA, "Code", "User", "workspaceStorage"),
      join5(process.env.APPDATA, "Code - Insiders", "User", "workspaceStorage"),
      join5(process.env.APPDATA, "Cursor", "User", "workspaceStorage")
    );
  }
  for (const candidate of userDataRoots) {
    try {
      const entries = await readdir3(candidate, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) roots.add(join5(candidate, entry.name));
      }
    } catch {
    }
  }
  return [...roots];
}
async function listJsonlFiles(dir, transcriptKind) {
  try {
    const entries = await readdir3(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map(async (entry) => {
        const path = join5(dir, entry.name);
        const info = await stat3(path);
        return { path, transcriptKind, mtimeMs: info.mtimeMs, size: info.size };
      })
    );
    return files;
  } catch {
    return [];
  }
}
async function listJsonlFilesRecursive(dir, transcriptKind, maxDepth = 3) {
  const results = [];
  async function visit(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir3(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join5(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const info = await stat3(full);
          results.push({ path: full, transcriptKind, mtimeMs: info.mtimeMs, size: info.size });
        } catch {
        }
      }
    }
  }
  await visit(dir, 0);
  return results;
}
async function globalChatSessionFiles() {
  const roots = [
    join5(homedir3(), "Library", "Application Support", "Code", "User", "globalStorage", "emptyWindowChatSessions"),
    join5(homedir3(), "Library", "Application Support", "Code - Insiders", "User", "globalStorage", "emptyWindowChatSessions"),
    join5(homedir3(), "Library", "Application Support", "Cursor", "User", "globalStorage", "emptyWindowChatSessions"),
    join5(homedir3(), ".config", "Code", "User", "globalStorage", "emptyWindowChatSessions"),
    join5(homedir3(), ".config", "Code - Insiders", "User", "globalStorage", "emptyWindowChatSessions"),
    join5(homedir3(), ".config", "Cursor", "User", "globalStorage", "emptyWindowChatSessions")
  ];
  if (process.env.APPDATA) {
    roots.push(
      join5(process.env.APPDATA, "Code", "User", "globalStorage", "emptyWindowChatSessions"),
      join5(process.env.APPDATA, "Code - Insiders", "User", "globalStorage", "emptyWindowChatSessions"),
      join5(process.env.APPDATA, "Cursor", "User", "globalStorage", "emptyWindowChatSessions")
    );
  }
  const files = await Promise.all(roots.map((root) => listJsonlFiles(root, "vscode-empty-window-chat-session")));
  return files.flat();
}
async function readJsonlRecords(path) {
  const content = await readFile5(path, "utf8");
  return content.split(/\r?\n/).filter((line) => line.trim()).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}
async function sourceFileInfo(path, mtimeMs, size) {
  const content = await readFile5(path, "utf8");
  return {
    path,
    sha256: createHash6("sha256").update(content).digest("hex"),
    mtime_ms: mtimeMs,
    size_bytes: size
  };
}
async function captureCopilotLocalTranscripts(options = {}) {
  const context = extensionContext;
  if (!context) {
    if (!options.silent) vscode.window.showWarningMessage("TinyAI Observability cannot locate VS Code workspaceStorage yet.");
    return;
  }
  const cfg = config();
  const roots = await workspaceStorageRoots();
  const maxAgeMs = Math.max(1, cfg.autoCaptureRecentMinutes) * 6e4;
  const newestAllowedMtime = options.includeHistory ? 0 : Date.now() - maxAgeMs;
  const workspaceFiles = (await Promise.all(
    roots.map(async (root) => [
      ...await listJsonlFiles(join5(root, "GitHub.copilot-chat", "transcripts"), "github-copilot-transcript"),
      ...await listJsonlFiles(join5(root, "chatSessions"), "vscode-chat-session")
    ])
  )).flat();
  const files = [...await globalChatSessionFiles(), ...workspaceFiles].filter((file) => file.mtimeMs >= newestAllowedMtime).sort((left, right) => right.mtimeMs - left.mtimeMs);
  const seen = { ...context.workspaceState.get(COPILOT_TRANSCRIPT_STATE_KEY) || {} };
  const cursors = { ...context.workspaceState.get(COPILOT_SESSION_CURSOR_STATE_KEY) || {} };
  const bySession = /* @__PURE__ */ new Map();
  let parseErrorCount = 0;
  let seenChanged = false;
  for (const file of files) {
    const sessionId = basename2(file.path, ".jsonl");
    const bucket = bySession.get(sessionId) || {};
    if (file.transcriptKind === "vscode-chat-session" || file.transcriptKind === "vscode-empty-window-chat-session") {
      if (!bucket.chat || file.mtimeMs > bucket.chat.mtimeMs) bucket.chat = file;
    } else if (file.transcriptKind === "github-copilot-transcript") {
      if (!bucket.transcript || file.mtimeMs > bucket.transcript.mtimeMs) bucket.transcript = file;
    }
    bySession.set(sessionId, bucket);
  }
  let uploaded = 0;
  let capturedMessages = 0;
  let skippedWithoutChatSession = 0;
  let skippedTooRecent = 0;
  let skippedUnchanged = 0;
  const now = Date.now();
  let cursorChanged = false;
  for (const [sessionKey, { chat: chat2, transcript }] of bySession.entries()) {
    if (!chat2) {
      skippedWithoutChatSession += 1;
      continue;
    }
    const newestSourceMtime = Math.max(chat2.mtimeMs, transcript?.mtimeMs || 0);
    if (now - newestSourceMtime < 5e3) {
      skippedTooRecent += 1;
      continue;
    }
    const chatFingerprint = fileFingerprint(chat2);
    const transcriptFingerprint = fileFingerprint(transcript);
    const cursor = cursors[sessionKey];
    if (!options.includeHistory && cursor?.chat_fingerprint === chatFingerprint && cursor?.transcript_fingerprint === transcriptFingerprint) {
      skippedUnchanged += 1;
      continue;
    }
    try {
      const chatEntries = await readJsonlRecords(chat2.path);
      const transcriptEntries = transcript ? await readJsonlRecords(transcript.path) : void 0;
      const snapshots = buildCopilotTurnSnapshots({
        chat_entries: chatEntries,
        transcript_entries: transcriptEntries,
        chat_file: await sourceFileInfo(chat2.path, chat2.mtimeMs, chat2.size),
        transcript_file: transcript ? await sourceFileInfo(transcript.path, transcript.mtimeMs, transcript.size) : void 0
      });
      for (const snapshot of snapshots) {
        const seenKey = `turn:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}:${COPILOT_CAPTURE_CAPABILITY}`;
        const signature = copilotTurnSignature(snapshot);
        if (queuedOrAcknowledgedSignature(seen[seenKey]) === signature) continue;
        const taskId = `copilot-local-${snapshot.session_id}`.slice(0, 64);
        const turnClientId = clientId("copilot", userIdentity());
        const eventId = copilotTurnEventId(snapshot, turnClientId);
        const nowIso = (/* @__PURE__ */ new Date()).toISOString();
        const cwd3 = workspacePath();
        const specAccesses = await specAccessesFromCopilotTurn(snapshot, cwd3);
        const specDocuments = await projectSpecDocuments(cwd3);
        eventForTask(
          taskId,
          "turn_snapshot",
          {
            ...snapshot,
            cwd: cwd3,
            spec_accesses: specAccesses,
            spec_documents: specDocuments,
            retention_policy: "permanent",
            include_text: true
          },
          "derived",
          eventId,
          snapshot.model
        );
        await recordCopilotTurnEditorDelta(snapshot, taskId, turnClientId);
        seen[seenKey] = {
          event_id: eventId,
          signature,
          status: "queued",
          collector_url_hash: currentCollectorHash(),
          first_seen_at: typeof seen[seenKey] === "object" ? seen[seenKey].first_seen_at : nowIso,
          last_attempt_at: nowIso,
          error_count: typeof seen[seenKey] === "object" ? seen[seenKey].error_count || 0 : 0
        };
        pendingTurnStateKeysByEventId.set(eventId, seenKey);
        seenChanged = true;
        uploaded += 1;
        capturedMessages += 2;
      }
      cursors[sessionKey] = {
        chat_fingerprint: chatFingerprint,
        transcript_fingerprint: transcriptFingerprint,
        processed_at: (/* @__PURE__ */ new Date()).toISOString()
      };
      cursorChanged = true;
    } catch (error) {
      parseErrorCount += 1;
      console.warn("TinyAI Observability failed to build Copilot turn snapshots", chat2.path, error);
      continue;
    }
  }
  lastCopilotCaptureDiagnostics = {
    scanned_at: (/* @__PURE__ */ new Date()).toISOString(),
    platform: process.platform,
    workspace_storage_roots: roots.length,
    files_total: files.length,
    workspace_files: workspaceFiles.length,
    sessions_total: bySession.size,
    chat_session_files: files.filter((file) => file.transcriptKind === "vscode-chat-session" || file.transcriptKind === "vscode-empty-window-chat-session").length,
    transcript_files: files.filter((file) => file.transcriptKind === "github-copilot-transcript").length,
    uploaded,
    parse_error_count: parseErrorCount,
    skipped_without_chat_session: skippedWithoutChatSession,
    skipped_too_recent: skippedTooRecent,
    skipped_unchanged: skippedUnchanged,
    include_history: Boolean(options.includeHistory),
    recent_minutes: cfg.autoCaptureRecentMinutes
  };
  if (uploaded > 0) {
    await markAiActivity(workspacePath(), { tool: "copilot", source: "copilot_turn_snapshot" });
    const uploadResult = await flush();
    applyTurnUploadResult(seen, uploadResult);
    seenChanged = true;
    updateStatus();
  }
  if (seenChanged) {
    await context.workspaceState.update(COPILOT_TRANSCRIPT_STATE_KEY, seen);
  }
  if (cursorChanged) {
    await context.workspaceState.update(COPILOT_SESSION_CURSOR_STATE_KEY, cursors);
  }
  if (!options.silent) {
    vscode.window.showInformationMessage(
      uploaded > 0 ? `TinyAI captured ${uploaded} Copilot turn snapshot(s) (${capturedMessages} top-level messages).` : `TinyAI found no completed Copilot turns ready in the last ${cfg.autoCaptureRecentMinutes} minute(s). Parsed ${bySession.size} session(s), ${parseErrorCount} parse error(s).`
    );
  }
  if (options.silent || uploaded === 0) {
    void heartbeat();
  }
}
function claudeTurnSignature(snapshot) {
  return hashText3(
    JSON.stringify({
      schema_version: snapshot.schema_version,
      session_id: snapshot.session_id,
      request_id: snapshot.request_id,
      response_id: snapshot.response_id,
      status: snapshot.turn.status,
      user_hash: snapshot.user_message.text_hash,
      assistant_hash: snapshot.assistant_message?.text_hash,
      tool_count: snapshot.tool_calls?.length || 0,
      step_count: snapshot.process_steps?.length || 0,
      code_change_count: snapshot.code_changes?.length || 0,
      usage: snapshot.usage_totals,
      parser: snapshot.source_files?.parser_version
    })
  );
}
function claudeTurnEventId(snapshot, turnClientId) {
  return stableEventId(`claude:turn:${turnClientId}:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}`);
}
async function claudeJsonlFiles(options = {}) {
  const cfg = config();
  const maxAgeMs = Math.max(1, cfg.autoCaptureRecentMinutes) * 6e4;
  const newestAllowedMtime = options.includeHistory ? 0 : Date.now() - maxAgeMs;
  const roots = [
    join5(homedir3(), ".claude", "projects"),
    join5(homedir3(), ".claude", "transcripts")
  ];
  const files = (await Promise.all(roots.map((root) => listJsonlFilesRecursive(root, "claude-project-jsonl", 4)))).flat().filter((file) => file.mtimeMs >= newestAllowedMtime).sort((left, right) => right.mtimeMs - left.mtimeMs);
  return files;
}
async function captureClaudeLocalTranscripts(options = {}) {
  const context = extensionContext;
  if (!context) {
    if (!options.silent) vscode.window.showWarningMessage("TinyAI Observability cannot locate VS Code extension state yet.");
    return;
  }
  const files = await claudeJsonlFiles(options);
  const seen = { ...context.globalState.get(CLAUDE_TRANSCRIPT_STATE_KEY) || {} };
  const cursors = { ...context.globalState.get(CLAUDE_SESSION_CURSOR_STATE_KEY) || {} };
  const now = Date.now();
  let uploaded = 0;
  let parseErrorCount = 0;
  let seenChanged = false;
  let cursorChanged = false;
  for (const file of files) {
    if (now - file.mtimeMs < 5e3) continue;
    const fingerprint = fileFingerprint(file, CLAUDE_CAPTURE_CAPABILITY);
    const cursorKey = file.path;
    const cursor = cursors[cursorKey];
    if (!options.includeHistory && cursor?.chat_fingerprint === fingerprint) continue;
    try {
      const snapshots = await captureLatestClaudeTurnSnapshots({
        sessionFile: file.path,
        latestOnly: false,
        includeText: config().captureConversationText
      });
      for (const snapshot of snapshots) {
        if (snapshot.turn.status === "incomplete" && !snapshot.assistant_message && (snapshot.tool_calls?.length || 0) === 0 && (snapshot.process_steps?.length || 0) === 0) {
          continue;
        }
        const cwd3 = snapshot.cwd || workspacePath();
        const seenKey = `claude-turn:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}:${CLAUDE_CAPTURE_CAPABILITY}`;
        const signature = claudeTurnSignature(snapshot);
        if (queuedOrAcknowledgedSignature(seen[seenKey]) === signature) continue;
        const identity = userIdentity();
        const turnClientId = clientId("claude", identity);
        const eventId = claudeTurnEventId(snapshot, turnClientId);
        const taskId = `claude-local-${snapshot.session_id}`.slice(0, 64);
        const nowIso = (/* @__PURE__ */ new Date()).toISOString();
        const specAccesses = await specAccessesFromCopilotTurn(snapshot, cwd3);
        const specDocuments = await projectSpecDocuments(cwd3);
        eventForTask(
          taskId,
          "turn_snapshot",
          {
            ...snapshot,
            cwd: cwd3,
            spec_accesses: specAccesses,
            spec_documents: specDocuments,
            retention_policy: "permanent",
            include_text: true,
            capture_source: "vscode_plugin_claude_jsonl_scanner"
          },
          "derived",
          eventId,
          snapshot.model,
          "claude",
          cwd3
        );
        await recordClaudeTurnEditorDelta(snapshot, taskId, turnClientId);
        await markAiActivity(cwd3, { tool: "claude", source: "claude_turn_snapshot" });
        seen[seenKey] = {
          event_id: eventId,
          signature,
          status: "queued",
          collector_url_hash: currentCollectorHash(),
          first_seen_at: typeof seen[seenKey] === "object" ? seen[seenKey].first_seen_at : nowIso,
          last_attempt_at: nowIso,
          error_count: typeof seen[seenKey] === "object" ? seen[seenKey].error_count || 0 : 0
        };
        pendingTurnStateKeysByEventId.set(eventId, seenKey);
        seenChanged = true;
        uploaded += 1;
      }
      cursors[cursorKey] = {
        chat_fingerprint: fingerprint,
        processed_at: (/* @__PURE__ */ new Date()).toISOString()
      };
      cursorChanged = true;
    } catch (error) {
      parseErrorCount += 1;
      console.warn("TinyAI Observability failed to build Claude turn snapshots", file.path, error);
    }
  }
  if (uploaded > 0) {
    const uploadResult = await flush();
    applyTurnUploadResult(seen, uploadResult);
    seenChanged = true;
    updateStatus();
  }
  if (seenChanged) {
    await context.globalState.update(CLAUDE_TRANSCRIPT_STATE_KEY, seen);
  }
  if (cursorChanged) {
    await context.globalState.update(CLAUDE_SESSION_CURSOR_STATE_KEY, cursors);
  }
  if (!options.silent) {
    vscode.window.showInformationMessage(
      uploaded > 0 ? `TinyAI captured ${uploaded} Claude turn snapshot(s).` : `TinyAI found no completed Claude turns ready in the last ${config().autoCaptureRecentMinutes} minute(s). Parsed ${files.length} file(s), ${parseErrorCount} parse error(s).`
    );
  }
}
function applyTurnUploadResult(seen, result) {
  if (!result?.events) return;
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  for (const eventResult of result.events) {
    const seenKey = pendingTurnStateKeysByEventId.get(eventResult.event_id);
    if (!seenKey) continue;
    const current = seen[seenKey];
    if (!current || typeof current === "string") continue;
    if (eventResult.status === "accepted" || eventResult.status === "duplicate") {
      seen[seenKey] = {
        ...current,
        status: "acknowledged",
        acknowledged_at: nowIso,
        last_error: void 0
      };
      pendingTurnStateKeysByEventId.delete(eventResult.event_id);
    } else {
      seen[seenKey] = {
        ...current,
        status: eventResult.reason === "queued_for_retry" ? "queued" : "failed",
        error_count: (current.error_count || 0) + 1,
        last_error: eventResult.reason || "upload_failed"
      };
    }
  }
}
async function flush() {
  if (!pendingEvents.length) return void 0;
  const toUpload = pendingEvents.splice(0, pendingEvents.length);
  const grouped = /* @__PURE__ */ new Map();
  for (const item of toUpload) {
    const bucket = grouped.get(item.tool) || [];
    bucket.push(item);
    grouped.set(item.tool, bucket);
  }
  let merged;
  for (const [tool, events] of grouped.entries()) {
    const result = await client().upload(tool, events);
    merged = {
      accepted: (merged?.accepted || 0) + (result.accepted || 0),
      duplicates: (merged?.duplicates || 0) + (result.duplicates || 0),
      failed: (merged?.failed || 0) + (result.failed || 0),
      task_count: (merged?.task_count || 0) + (result.task_count || 0),
      queued: Boolean(merged?.queued || result.queued),
      events: [...merged?.events || [], ...result.events || []]
    };
  }
  return merged;
}
async function heartbeat() {
  const cfg = config();
  const identity = userIdentity();
  const heartbeatSignature = hashText3(
    JSON.stringify({
      plugin_version: PLUGIN_VERSION,
      workspace: workspacePath(),
      user_id: identity.user_id || identity.username,
      auto_capture: cfg.autoCaptureCopilotLocalTranscripts,
      auto_capture_claude: cfg.autoCaptureClaudeLocalTranscripts,
      capture_text: cfg.captureConversationText,
      capture_reasoning: cfg.captureVisibleReasoningText,
      recent_minutes: cfg.autoCaptureRecentMinutes
    })
  );
  eventForTask(
    "copilot-plugin-heartbeat",
    "plugin_heartbeat",
    {
      activation: "vscode",
      auto_capture_copilot_local_transcripts: config().autoCaptureCopilotLocalTranscripts,
      auto_capture_claude_local_transcripts: config().autoCaptureClaudeLocalTranscripts,
      capture_conversation_text: config().captureConversationText,
      capture_visible_reasoning_text: config().captureVisibleReasoningText,
      auto_capture_recent_minutes: config().autoCaptureRecentMinutes,
      diagnostics: {
        copilot_capture: lastCopilotCaptureDiagnostics
      }
    },
    "direct",
    stableEventId(`copilot:plugin_heartbeat:${heartbeatSignature}:${(/* @__PURE__ */ new Date()).toISOString().slice(0, 16)}`)
  );
  await flush();
}
function updateStatus() {
  const cfg = config();
  statusBar.text = currentTaskId ? "TinyAI Obs: Task" : "TinyAI Obs: Auto";
  statusBar.tooltip = currentTaskId ? `Current task: ${currentTaskId}` : cfg.autoCaptureCopilotLocalTranscripts || cfg.autoCaptureClaudeLocalTranscripts ? `Auto-capturing recent Copilot/Claude sessions every 15s; window: ${cfg.autoCaptureRecentMinutes} min.` : "TinyAI automatic transcript capture is disabled.";
  statusBar.command = "tinyaiObservability.showMenu";
  panelProvider?.refresh();
}
async function configure() {
  const cfg = config();
  const userName = await vscode.window.showInputBox({ title: "TinyAI user name", value: cfg.userName, prompt: "\u7528\u4E8E\u76D1\u63A7\u9762\u677F\u6309\u4EBA\u805A\u5408\uFF0C\u4F8B\u5982\uFF1A\u5F20\u4E09 / lyl / Alice" });
  if (userName) await vscode.workspace.getConfiguration("tinyaiObservability").update("userName", userName, vscode.ConfigurationTarget.Global);
  if (!cfg.collectorUrl) {
    await vscode.workspace.getConfiguration("tinyaiObservability").update("collectorUrl", DEFAULT_COLLECTOR_URL, vscode.ConfigurationTarget.Global);
  }
  await heartbeat();
  vscode.window.showInformationMessage("TinyAI Observability configured. Reload VS Code once to apply the latest extension settings.");
}
async function remindMissingUserName(context) {
  const cfg = config();
  if (cfg.userName) return;
  const reminderKey = "tinyaiObservability.userNameReminderShown";
  if (context.globalState.get(reminderKey)) return;
  await context.globalState.update(reminderKey, true);
  const choice = await vscode.window.showWarningMessage(
    "TinyAI Observability: configure your user name so all AI coding sessions group under the correct teammate.",
    "Configure"
  );
  if (choice === "Configure") await configure();
}
async function openDashboard() {
  const cfg = config();
  const dashboardUrl = await firstReachableUrl([cfg.dashboardUrl, ...cfg.dashboardFallbackUrls]);
  await vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
}
async function firstReachableUrl(urls) {
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(1500)
      });
      if (response.ok) return url;
    } catch {
    }
  }
  return urls[0];
}
async function openPanel() {
  await vscode.commands.executeCommand("workbench.view.extension.tinyaiObservability");
  await vscode.commands.executeCommand("tinyaiObservability.actionsView.focus");
}
async function startTask() {
  currentTaskId = randomUUID2();
  conversationMessages.splice(0, conversationMessages.length);
  event("task_start", { trigger: "vscode_command" });
  updateStatus();
  await flush();
  vscode.window.showInformationMessage("TinyAI Observability task started.");
}
function matchedByCountsFor(results) {
  return results.reduce((counts, result) => {
    for (const match of result.matched_by || []) counts[match] = (counts[match] || 0) + 1;
    return counts;
  }, {});
}
function fallbackTinyAIResponse(prompt, results) {
  if (results.length === 0) {
    return `TinyAI did not find matching specs for this request.

Request: ${prompt}`;
  }
  const top = results.slice(0, 3).map((result, index) => `${index + 1}. ${result.path}
${result.excerpt.trim()}`).join("\n\n");
  return `TinyAI found relevant specs and recorded telemetry.

${top}`;
}
async function callLanguageModel(prompt, results, token, preferredModel) {
  const lmApi = vscode.lm;
  const Message = vscode.LanguageModelChatMessage;
  if (!lmApi?.selectChatModels || !Message?.User) return fallbackTinyAIResponse(prompt, results);
  const models = preferredModel ? [preferredModel] : await lmApi.selectChatModels({ vendor: "copilot" }).catch(() => []) || await lmApi.selectChatModels().catch(() => []);
  const model = models[0];
  if (!model) return fallbackTinyAIResponse(prompt, results);
  const modelId = model.id || model.name || void 0;
  if (modelId) currentModel = modelId;
  const context = results.slice(0, 5).map((result, index) => `Spec ${index + 1}: ${result.path}
${result.excerpt}`).join("\n\n");
  const request = [
    Message.User(
      [
        "You are TinyAI, a coding assistant that must ground answers in project personal specs when available.",
        "Use the provided specs context first. If context is insufficient, say what is missing.",
        "",
        `User request:
${prompt}`,
        "",
        `Specs context:
${context || "No matching specs found."}`
      ].join("\n")
    )
  ];
  try {
    const response = await model.sendRequest(request, {}, token);
    let text = "";
    for await (const chunk of response.text) text += chunk;
    return text.trim() || fallbackTinyAIResponse(prompt, results);
  } catch (error) {
    return `${fallbackTinyAIResponse(prompt, results)}

Language model request failed: ${String(error)}`;
  }
}
async function runTinyAIProxyPrompt(prompt, source, token, preferredModel) {
  const trimmed = prompt.trim();
  if (!trimmed) return "";
  await ensureTask(source);
  appendConversationMessage("user", trimmed, source);
  const results = await searchSpecs(workspacePath(), trimmed).catch(() => []);
  event(
    results.length > 0 ? "catalog_hit" : "fallback_search",
    {
      query_hash: "present",
      result_count: results.length,
      source,
      matched_by_counts: matchedByCountsFor(results),
      fallback_used: results.length === 0
    },
    "direct"
  );
  const responseText = await callLanguageModel(trimmed, results, token, preferredModel);
  appendConversationMessage("assistant", responseText, source);
  emitConversationSnapshot("direct");
  await flush();
  updateStatus();
  return responseText;
}
async function endTask() {
  if (!currentTaskId) {
    vscode.window.showInformationMessage("No TinyAI Observability task is active.");
    return;
  }
  const summary = await diffSummary(workspacePath());
  emitConversationSnapshot("derived");
  event("code_change", { ...summary, snapshot_kind: "task_end" }, "derived");
  event("task_end", { result: "unknown" });
  const endedTask = currentTaskId;
  currentTaskId = void 0;
  updateStatus();
  await flush();
  vscode.window.showInformationMessage(`TinyAI Observability task ended: ${endedTask}`);
}
async function captureClipboardConversation() {
  if (!currentTaskId) {
    currentTaskId = randomUUID2();
    event("task_start", { trigger: "capture_clipboard_conversation" });
    updateStatus();
  }
  const text = await vscode.env.clipboard.readText();
  if (!text.trim() || looksLikeCommandText(text)) {
    vscode.window.showWarningMessage("Clipboard does not contain a conversation transcript. Paste the transcript into an editor and run Capture Active Editor Conversation.");
    return;
  }
  appendTranscriptText(text, "clipboard_import");
  emitConversationSnapshot("derived");
  await flush();
  vscode.window.showInformationMessage("TinyAI Observability captured clipboard conversation text.");
}
async function captureActiveEditorConversation() {
  if (!currentTaskId) {
    currentTaskId = randomUUID2();
    event("task_start", { trigger: "capture_active_editor_conversation" });
    updateStatus();
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Open or paste a conversation transcript in an editor first.");
    return;
  }
  const selections = editor.selections.filter((selection) => !selection.isEmpty).map((selection) => editor.document.getText(selection)).join("\n\n");
  const text = selections.trim() ? selections : editor.document.getText();
  if (!text.trim() || looksLikeCommandText(text)) {
    vscode.window.showWarningMessage("Active editor does not contain a conversation transcript.");
    return;
  }
  appendTranscriptText(text, "active_editor_import");
  emitConversationSnapshot("derived");
  await flush();
  vscode.window.showInformationMessage("TinyAI Observability captured active editor conversation text.");
}
async function recordFeedback() {
  await ensureTask("feedback");
  const kind = await vscode.window.showQuickPick(["user_correction", "regenerate", "interruption", "official_misread"], { title: "Feedback type" });
  if (!kind) return;
  const reason = await vscode.window.showInputBox({ title: "Feedback reason", value: kind === "user_correction" ? "specs_misunderstanding" : "" });
  event(kind, { reason: reason || void 0 }, "direct");
  await flush();
}
async function adoptionSnapshot() {
  if (!currentTaskId) {
    vscode.window.showInformationMessage("Start a TinyAI Observability task first.");
    return;
  }
  const generated = Number(await vscode.window.showInputBox({ title: "Generated lines", validateInput: (value) => Number.isFinite(Number(value)) ? null : "Enter a number" }));
  if (!Number.isFinite(generated)) return;
  const retained = Number(await vscode.window.showInputBox({ title: "Retained lines", validateInput: (value) => Number.isFinite(Number(value)) ? null : "Enter a number" }));
  if (!Number.isFinite(retained)) return;
  event(
    "adoption_snapshot",
    {
      lines_added: generated,
      retained_lines: retained,
      adoption_rate: generated > 0 ? retained / generated : void 0,
      snapshot_kind: "vscode_manual_retention_check"
    },
    "direct"
  );
  await flush();
}
async function recordCommitSnapshot(options = {}) {
  await ensureTask("commit_snapshot");
  const snapshot = await commitSnapshot(workspacePath(), "HEAD", {
    aiAssisted: true,
    attributionEvidence: "manual_vscode_commit_snapshot"
  });
  event(
    "commit_snapshot",
    { ...snapshot, source: "vscode_command" },
    "derived",
    snapshot.commit_sha ? stableEventId(`copilot:commit_snapshot:${workspacePath()}:${snapshot.commit_sha}`) : void 0
  );
  updateStatus();
  await flush();
  if (!options.silent) {
    vscode.window.showInformationMessage(
      `TinyAI recorded commit snapshot: ${snapshot.ai_lines_added} AI-added line(s), ${snapshot.files_changed} file(s).`
    );
  }
}
async function recordAiLinesSnapshot(options = {}) {
  await ensureTask("ai_line_snapshot");
  const snapshot = await recordAiLineSnapshot(workspacePath(), {
    tool: "copilot",
    taskId: currentTaskId,
    source: "vscode_command_ai_line_snapshot"
  });
  event("ai_line_snapshot", { ...snapshot, snapshot_kind: "vscode_command_ai_line_snapshot" }, "direct");
  updateStatus();
  await flush();
  if (!options.silent) {
    vscode.window.showInformationMessage(`TinyAI recorded ${snapshot.recorded_lines} AI line fingerprint(s).`);
  }
}
async function recordPushSnapshot(options = {}) {
  await ensureTask("push_snapshot");
  const snapshot = await pushSnapshot(workspacePath(), {
    aiAssisted: true,
    attributionEvidence: "manual_vscode_push_snapshot"
  });
  const rangeKey = snapshot.head_sha ? `${snapshot.upstream_ref || ""}:${snapshot.base_sha || ""}:${snapshot.head_sha}` : "";
  event(
    "push_snapshot",
    { ...snapshot, source: "vscode_command" },
    "derived",
    rangeKey ? stableEventId(`copilot:push_snapshot:${workspacePath()}:${rangeKey}`) : void 0
  );
  updateStatus();
  await flush();
  if (!options.silent) {
    vscode.window.showInformationMessage(
      `TinyAI recorded push/PR snapshot: ${snapshot.ai_lines_added} AI-added line(s), ${snapshot.commit_count} commit(s).`
    );
  }
}
async function installGitHooksForWorkspace(options = {}) {
  try {
    const cfg = config();
    const result = await installGitHooks(workspacePath(), {
      tool: "copilot",
      collectorUrl: cfg.collectorUrl,
      fallbackUrls: cfg.collectorFallbackUrls,
      token: cfg.token || void 0,
      pluginVersion: PLUGIN_VERSION
    });
    if (options.emitHeartbeat ?? !options.silent) {
      eventForTask(
        "copilot-git-hooks",
        "plugin_heartbeat",
        {
          activation: options.silent ? "git_hooks_auto_install" : "git_hooks_install",
          installed_hooks: result.installed,
          git_dir: result.git_dir,
          hook_events: ["commit_snapshot", "push_snapshot"]
        },
        "direct"
      );
      await flush();
    }
    if (!options.silent) {
      vscode.window.showInformationMessage("TinyAI installed Git hooks for automatic commit/push AI code attribution.");
    }
  } catch (error) {
    if (!options.silent) {
      vscode.window.showErrorMessage(`TinyAI failed to install Git hooks: ${String(error)}`);
    } else {
      console.warn("TinyAI Observability failed to auto-install Git hooks", error);
    }
  }
}
async function showMenu() {
  const choice = await vscode.window.showQuickPick(
    [
      { label: "Configure User", detail: "\u914D\u7F6E\u59D3\u540D\uFF0C\u786E\u4FDD\u91C7\u96C6\u6570\u636E\u5F52\u5230\u6B63\u786E\u7528\u6237\u3002", command: "configure" }
    ],
    { title: "TinyAI Observability" }
  );
  if (!choice) return;
  if (choice.command === "configure") await configure();
}
var ObservabilityPanelProvider = class {
  view;
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml();
    view.webview.onDidReceiveMessage(async (message) => {
      if (message?.command === "configure") await configure();
      this.refresh();
    });
  }
  refresh(latestResponse) {
    if (this.view) this.view.webview.html = this.renderHtml(latestResponse);
  }
  renderHtml(_latestResponse = "") {
    const cfg = config();
    const identity = userIdentity();
    const userLabel = identity.user_display_name || identity.username || "\u672A\u914D\u7F6E";
    const taskText = currentTaskId ? `\u6D3B\u52A8\u4E2D\uFF1A${currentTaskId.slice(0, 8)}` : "\u81EA\u52A8\u91C7\u96C6\u4E2D";
    const enabledSources = [
      cfg.autoCaptureCopilotLocalTranscripts ? "Copilot" : void 0,
      cfg.autoCaptureClaudeLocalTranscripts ? "Claude" : void 0
    ].filter(Boolean).join(" / ");
    const autoText = enabledSources ? `\u5DF2\u5F00\u542F\uFF0C\u6BCF 15 \u79D2\u626B\u63CF\u6700\u8FD1 ${cfg.autoCaptureRecentMinutes} \u5206\u949F\u7684 ${enabledSources} \u672C\u5730\u4F1A\u8BDD\u3002` : "\u5DF2\u5173\u95ED\uFF0C\u53EF\u5728\u8BBE\u7F6E\u91CC\u5F00\u542F autoCaptureCopilotLocalTranscripts \u6216 autoCaptureClaudeLocalTranscripts\u3002";
    const collectorLabel = cfg.collectorUrl || DEFAULT_COLLECTOR_URL;
    return (
      /* html */
      `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); padding: 12px; }
    .hero { border: 1px solid var(--vscode-panel-border); border-radius: 8px; margin-bottom: 12px; padding: 12px; }
    .status { border: 1px solid var(--vscode-panel-border); border-radius: 8px; margin-bottom: 10px; padding: 10px; }
    .label { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; letter-spacing: .04em; margin-bottom: 5px; text-transform: uppercase; }
    .value { font-size: 14px; font-weight: 700; overflow-wrap: anywhere; }
    .hint { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; margin-top: 6px; }
    .section { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; letter-spacing: .04em; margin: 16px 0 8px; text-transform: uppercase; }
    .pill-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .pill { background: var(--vscode-badge-background); border-radius: 999px; color: var(--vscode-badge-foreground); font-size: 11px; padding: 2px 7px; }
    button { align-items: center; background: var(--vscode-button-background); border: 0; border-radius: 6px; color: var(--vscode-button-foreground); cursor: pointer; display: flex; font: inherit; justify-content: center; margin-bottom: 8px; min-height: 32px; padding: 7px 9px; width: 100%; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    p { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; margin: 10px 0; }
  </style>
</head>
<body>
  <div class="hero">
    <div class="label">\u91C7\u96C6\u72B6\u6001</div>
    <div class="value">${escapeHtml(taskText)}</div>
    <div class="hint">${escapeHtml(autoText)}</div>
    <div class="pill-row">
      <span class="pill">turn_snapshot</span>
      <span class="pill">code_change</span>
      <span class="pill">commit_snapshot</span>
    </div>
  </div>
  <div class="status">
    <div class="label">\u5F53\u524D\u7528\u6237</div>
    <div class="value">${escapeHtml(userLabel)}</div>
    <div class="hint">\u6240\u6709 session \u4F1A\u6309\u8FD9\u4E2A\u7528\u6237\u805A\u5408\u3002Collector\uFF1A${escapeHtml(collectorLabel)}</div>
  </div>
  <div class="status">
    <div class="label">\u4EE3\u7801\u5F52\u56E0</div>
    <div class="value">Commit \u540E\u81EA\u52A8\u8BA1\u7B97 AI / Human \u5360\u6BD4</div>
    <div class="hint">\u4E0D\u9700\u8981\u624B\u52A8\u6807\u8BB0\u5F53\u524D diff\u3002AI \u8BC1\u636E\u6765\u81EA Copilot / Claude \u4F1A\u8BDD\uFF0Ccommit \u5168\u91CF diff \u7531 Git hook \u81EA\u52A8\u4E0A\u4F20\uFF0Ccollector \u6309\u6587\u4EF6\u3001\u884C\u7C7B\u578B\u548C text_hash \u5339\u914D\u3002</div>
  </div>
  <div class="section">\u9700\u8981\u65F6\u914D\u7F6E</div>
  <button data-command="configure">Configure User</button>
  <p>\u6B63\u5E38\u4F7F\u7528 Copilot\u3001Claude Code / Claude CLI \u548C git commit \u5373\u53EF\u81EA\u52A8\u91C7\u96C6\u3002\u4E00\u822C\u60C5\u51B5\u4E0B\u4E0D\u9700\u8981\u624B\u52A8\u64CD\u4F5C\u3002</p>
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll("button[data-command]").forEach((button) => {
      button.addEventListener("click", () => vscode.postMessage({ command: button.dataset.command }));
    });
  </script>
</body>
</html>`
    );
  }
};
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
}
function recordSpecAccess(uri) {
  if (!currentTaskId) return;
  const path = vscode.workspace.asRelativePath(uri, false);
  const classification = classifySpecPath(path);
  if (classification.spec_scope === "unknown") return;
  event("spec_read", { ...classification }, classification.via_catalog ? "direct" : "derived");
}
function registerChatSurface(context) {
  const chatApi = vscode.chat;
  if (chatApi?.createChatParticipant) {
    const participant = chatApi.createChatParticipant("tinyai.tinyai-observability-copilot.tinyai", async (request, _context, stream, token) => {
      const prompt = String(request?.prompt || "");
      const responseText = await runTinyAIProxyPrompt(prompt, "chat_participant", token, request?.model);
      stream.markdown(responseText || "TinyAI did not receive a prompt.");
    });
    participant.iconPath = new vscode.ThemeIcon("book");
    participant.followupProvider = {
      provideFollowups() {
        return [
          { prompt: "\u7EE7\u7EED\u6309\u4E2A\u4EBA specs \u5B8C\u6210\u5B9E\u73B0\u5E76\u8BB0\u5F55\u91C7\u7EB3\u5FEB\u7167", label: "Continue with specs" },
          { prompt: "\u7ED3\u675F\u5F53\u524D TinyAI \u4EFB\u52A1\u5E76\u4E0A\u4F20 diff \u5FEB\u7167", label: "End TinyAI task" }
        ];
      }
    };
    context.subscriptions.push(participant);
  }
  const lmApi = vscode.lm;
  if (lmApi?.registerTool && vscode.LanguageModelToolResult && vscode.LanguageModelTextPart) {
    const disposable = lmApi.registerTool("tinyai_specs", {
      async invoke(options) {
        const query = String(options?.input?.query || "");
        await ensureTask("lm_tool");
        const results = await searchSpecs(workspacePath(), query).catch(() => []);
        const matchedByCounts = results.reduce((counts, result) => {
          for (const match of result.matched_by || []) counts[match] = (counts[match] || 0) + 1;
          return counts;
        }, {});
        event(
          results.length > 0 ? "catalog_hit" : "fallback_search",
          { query_hash: query ? "present" : "empty", result_count: results.length, source: "lm_tool", matched_by_counts: matchedByCounts },
          "direct"
        );
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify({ results }, null, 2))
        ]);
      }
    });
    context.subscriptions.push(disposable);
  }
}
function activate(context) {
  extensionContext = context;
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.show();
  context.subscriptions.push(statusBar);
  panelProvider = new ObservabilityPanelProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("tinyaiObservability.actionsView", panelProvider));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.configure", configure));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.openPanel", openPanel));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.showMenu", showMenu));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.openDashboard", openDashboard));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.startTask", startTask));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.endTask", endTask));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.flushEvents", flush));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.captureClipboardConversation", captureClipboardConversation));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.captureActiveEditorConversation", captureActiveEditorConversation));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.captureCopilotLocalTranscripts", () => captureCopilotLocalTranscripts()));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.captureClaudeLocalTranscripts", () => captureClaudeLocalTranscripts()));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.recordCommitSnapshot", () => recordCommitSnapshot()));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.recordAiLinesSnapshot", () => recordAiLinesSnapshot()));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.recordPushSnapshot", () => recordPushSnapshot()));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.installGitHooks", () => installGitHooksForWorkspace()));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.recordFeedback", recordFeedback));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.adoptionSnapshot", adoptionSnapshot));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.showCurrentTask", () => {
    vscode.window.showInformationMessage(currentTaskId ? `TinyAI task: ${currentTaskId}` : "No TinyAI task is active.");
  }));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => recordSpecAccess(doc.uri)));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
    if (!currentTaskId || doc.uri.scheme !== "file") return;
    scheduleFlush();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((change) => {
    if (change.document.uri.scheme !== "file") return;
    if (change.contentChanges.length > 0) {
      const payload = rememberEditorChange(change);
      if (currentTaskId) {
        event(
          "code_change",
          { ...payload, attribution_scope: "manual_task_editor_delta" },
          "derived",
          stableEventId(`copilot:vscode_text_change:${workspacePath()}:${payload.file_path}:${Date.now()}:${payload.change_count}`)
        );
      }
      scheduleFlush();
    }
  }));
  registerChatSurface(context);
  void migrateLegacyCollectorUrl().then(() => {
    panelProvider?.refresh();
  });
  void remindMissingUserName(context);
  void heartbeat();
  if (config().autoInstallGitHooks) {
    void installGitHooksForWorkspace({ silent: true, emitHeartbeat: false });
  }
  if (config().autoCaptureCopilotLocalTranscripts) {
    void captureCopilotLocalTranscripts({ silent: true });
    const timer = setInterval(() => void captureCopilotLocalTranscripts({ silent: true }), 15e3);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }
  if (config().autoCaptureClaudeLocalTranscripts) {
    void captureClaudeLocalTranscripts({ silent: true });
    const timer = setInterval(() => void captureClaudeLocalTranscripts({ silent: true }), 15e3);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }
  updateStatus();
}
function deactivate() {
  emitConversationSnapshot("derived");
  return flush();
}
export {
  activate,
  deactivate
};
