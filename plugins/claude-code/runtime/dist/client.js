import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { DEFAULT_COLLECTOR_URL, loadTinyAiEnvFile, tinyAiCollectorFallbackUrlsForTool, tinyAiCollectorUrlForTool, tinyAiQueuePathForTool } from "./config.js";
import { clientId, resolveModel, resolveUserIdentity } from "./event-schema.js";
import { redact } from "./redactor.js";
import { deadLetterBatch, enqueueBatch, readQueuedEntries, replaceQueueEntries } from "./queue.js";
loadTinyAiEnvFile();
const TURN_BLOB_INLINE_LIMIT = Number(process.env.TINYAI_OBS_TURN_BLOB_INLINE_LIMIT || 64 * 1024);
const TURN_BLOB_CHUNK_BYTES = Number(process.env.TINYAI_OBS_TURN_BLOB_CHUNK_BYTES || 256 * 1024);
const TURN_TEXT_PREVIEW_CHARS = Number(process.env.TINYAI_OBS_TURN_TEXT_PREVIEW_CHARS || 2000);
const QUEUE_FLUSH_MAX_BATCHES = Math.max(1, Number(process.env.TINYAI_OBS_QUEUE_FLUSH_MAX_BATCHES || 100) || 100);
const queueFlushes = new Map();
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
function defaultPluginNameForTool(tool) {
    if (tool === "claude")
        return "tinyai-observability-claude";
    if (tool === "codex")
        return "tinyai-observability-codex";
    if (tool === "copilot")
        return "tinyai-observability-vscode";
    if (tool === "git")
        return "tinyai-observability-git-hook";
    return "tinyai-observability";
}
function isLocalCollectorUrl(value) {
    try {
        const url = new URL(value);
        const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    }
    catch {
        return false;
    }
}
function isPrivateIpv4(hostname) {
    const parts = hostname.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
        return false;
    const [first, second] = parts;
    return first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31) || (first === 169 && second === 254);
}
function isPrivateIpv6(hostname) {
    const normalized = hostname.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}
function isPrivateNetworkCollectorUrl(value) {
    try {
        const url = new URL(value);
        const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        return isLocalCollectorUrl(value) || isPrivateIpv4(hostname) || isPrivateIpv6(hostname);
    }
    catch {
        return false;
    }
}
export function isCollectorUploadAllowedForUrl(baseUrl, token) {
    try {
        const url = new URL(baseUrl);
        if (isPrivateNetworkCollectorUrl(baseUrl))
            return true;
        return url.protocol === "https:" && Boolean(token.trim());
    }
    catch {
        return false;
    }
}
function assertCollectorSecurity(baseUrl, token) {
    let url;
    try {
        url = new URL(baseUrl);
    }
    catch {
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
    return createHash("sha256").update(value).digest("hex");
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
    if (serialized === undefined || byteLength(serialized) <= TURN_BLOB_INLINE_LIMIT)
        return undefined;
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
function blobifyTextValue(value, blobKey) {
    if (typeof value !== "string" || byteLength(value) <= TURN_BLOB_INLINE_LIMIT)
        return undefined;
    const blobified = blobifyValue(value, blobKey);
    if (!blobified)
        return undefined;
    return {
        ...blobified,
        hash: sha256(value),
        preview: value.slice(0, TURN_TEXT_PREVIEW_CHARS),
        textLen: value.length
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
    const rewritten = visit(payload, "");
    if (blobs.length > 0) {
        rewritten.raw_event_blobs = blobs;
    }
    return rewritten;
}
function classifyUploadError(error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase();
    if (/\b413\b|payload too large|request entity too large|content too large/.test(message))
        return "payload_too_large";
    if (/\b401\b|\b403\b|invalid collector token|requires a bearer token|upload blocked/.test(message))
        return "config_error";
    if (/\b400\b|schema|validation/.test(message))
        return "schema_error";
    if (/\b429\b|rate limit|too many requests/.test(message))
        return "rate_limited";
    if (/\b5\d\d\b|timeout|timed out|econn|enotfound|fetch failed|network/.test(message))
        return "retryable";
    return "unknown";
}
function isPermanentQueueError(category) {
    return category === "config_error" || category === "schema_error" || category === "payload_too_large";
}
function safeErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error || "collector upload failed");
    return message.slice(0, 500);
}
function retryEntry(entry, error, errorCategory) {
    return {
        ...entry,
        retry_count: (entry.retry_count || 0) + 1,
        last_attempt_at: new Date().toISOString(),
        last_error: safeErrorMessage(error),
        error_category: errorCategory,
        status: "queued"
    };
}
export function uploadResultAllowsCursorCommit(result) {
    if (result.queued)
        return false;
    if ((result.failed || 0) > 0)
        return false;
    if (!Array.isArray(result.events) || result.events.length === 0) {
        return (result.accepted || 0) + (result.duplicates || 0) > 0;
    }
    return result.events.every((event) => event.status === "accepted" || event.status === "duplicate");
}
export class CollectorClient {
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
            ...((options.fallbackUrls && options.fallbackUrls.length > 0) ? options.fallbackUrls : tinyAiCollectorFallbackUrlsForTool(options.tool, options.workspacePath)),
            ...splitCollectorUrls(process.env.TINYAI_OBS_COLLECTOR_URLS || "")
        ]);
        this.token = options.token || process.env.TINYAI_OBS_TOKEN || "";
        this.pluginName = options.pluginName || defaultPluginNameForTool(options.tool);
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
            events: events.map((event) => ({
                ...event,
                payload: event.event_type === "turn_snapshot" || event.event_type === "code_change" || event.event_type === "commit_snapshot" || event.event_type === "push_snapshot"
                    ? blobifyTurnPayload(event.payload)
                    : redact(event.payload, {
                        allowFullConversationText: (event.event_type === "conversation_snapshot" || event.event_type === "agent_process_snapshot") &&
                            event.payload?.include_text === true
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
        }
        catch (error) {
            const errorCategory = classifyUploadError(error);
            if (isPermanentQueueError(errorCategory)) {
                await deadLetterBatch(batch, queuePath, { errorCategory, lastError: safeErrorMessage(error) });
            }
            else {
                await enqueueBatch(batch, queuePath, { errorCategory, lastError: safeErrorMessage(error) });
            }
            return {
                accepted: 0,
                duplicates: 0,
                failed: isPermanentQueueError(errorCategory) ? events.length : 0,
                task_count: new Set(events.map((event) => event.task_id)).size,
                queued: !isPermanentQueueError(errorCategory),
                events: events.map((event) => ({
                    event_id: event.event_id,
                    event_type: event.event_type,
                    status: "failed",
                    reason: errorCategory
                }))
            };
        }
    }
    async flushQueue(tool = this.tool) {
        const queuePath = this.queuePathFor(tool);
        const existing = queueFlushes.get(queuePath);
        if (existing)
            return existing;
        const running = this.flushQueueOnce(queuePath);
        queueFlushes.set(queuePath, running);
        try {
            return await running;
        }
        finally {
            if (queueFlushes.get(queuePath) === running) {
                queueFlushes.delete(queuePath);
            }
        }
    }
    async flushQueueOnce(queuePath) {
        const queued = await readQueuedEntries(queuePath);
        const retryableRemaining = [];
        let sent = 0;
        const toFlush = queued.slice(0, QUEUE_FLUSH_MAX_BATCHES);
        const deferred = queued.slice(QUEUE_FLUSH_MAX_BATCHES);
        for (const entry of toFlush) {
            if (isPermanentQueueError(entry.error_category)) {
                await deadLetterBatch(entry.batch, queuePath, {
                    errorCategory: entry.error_category,
                    lastError: entry.last_error,
                    retryCount: entry.retry_count,
                    firstSeenAt: entry.first_seen_at
                });
                continue;
            }
            try {
                const result = await this.postBatch(entry.batch);
                sent += result.accepted + result.duplicates;
            }
            catch (error) {
                const errorCategory = classifyUploadError(error);
                if (isPermanentQueueError(errorCategory)) {
                    await deadLetterBatch(entry.batch, queuePath, {
                        errorCategory,
                        lastError: safeErrorMessage(error),
                        retryCount: (entry.retry_count || 0) + 1,
                        firstSeenAt: entry.first_seen_at
                    });
                }
                else {
                    retryableRemaining.push(retryEntry(entry, error, errorCategory));
                }
            }
        }
        await replaceQueueEntries([...retryableRemaining, ...deferred], queuePath);
        return { sent, remaining: retryableRemaining.length + deferred.length };
    }
    queuePathFor(tool) {
        return this.queuePath || tinyAiQueuePathForTool(tool || this.tool);
    }
    async postBatch(batch) {
        let lastError;
        for (const baseUrl of this.baseUrls) {
            try {
                return await this.postBatchToUrl(baseUrl, batch);
            }
            catch (error) {
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
            signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok) {
            throw new Error(`collector upload failed: ${response.status} ${await response.text()}`);
        }
        return await response.json();
    }
}
function splitCollectorUrls(value) {
    return value.split(/[,\s]+/).map((url) => url.trim()).filter(Boolean);
}
function uniqueCollectorUrls(urls) {
    const seen = new Set();
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
