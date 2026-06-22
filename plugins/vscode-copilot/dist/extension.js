// src/extension.ts
import * as vscode from "vscode";
import { createHash as createHash3, randomUUID as randomUUID2 } from "node:crypto";
import { readdir as readdir2, readFile as readFile4, stat } from "node:fs/promises";
import { basename, dirname as dirname3, join as join4 } from "node:path";

// ../../plugin-runtime/dist/event-schema.js
import { createHash, randomUUID } from "node:crypto";
import { cwd } from "node:process";
var processTaskId = process.env.TINYAI_OBS_TASK_ID || randomUUID();
function hashWorkspace(workspacePath2 = cwd()) {
  return createHash("sha256").update(workspacePath2).digest("hex").slice(0, 32);
}
function stableEventId(seed) {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}
function taskIdFromEnv() {
  return processTaskId;
}
function clientId(tool) {
  const seed = `${tool}:${process.env.USER || process.env.USERNAME || "unknown"}:${process.env.HOSTNAME || "local"}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}
function makeEvent(input) {
  return {
    event_id: input.eventId || randomUUID(),
    task_id: input.taskId || taskIdFromEnv(),
    session_id: input.sessionId || process.env.TINYAI_OBS_SESSION_ID,
    tool: input.tool,
    event_type: input.eventType,
    occurred_at: (/* @__PURE__ */ new Date()).toISOString(),
    workspace_path_hash: hashWorkspace(input.workspacePath),
    payload: input.payload || {},
    source_confidence: input.sourceConfidence || "direct"
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
      output[key] = BLOCKED_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redact(item, options);
    }
    return output;
  }
  return value;
}

// ../../plugin-runtime/dist/queue.js
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
function defaultQueuePath() {
  return process.env.TINYAI_OBS_QUEUE || join(homedir(), ".tinyai-observability", "queue.jsonl");
}
async function enqueueBatch(batch, queuePath = defaultQueuePath()) {
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(queuePath, `${JSON.stringify(batch)}
`, { flag: "a" });
}
async function readQueuedBatches(queuePath = defaultQueuePath()) {
  try {
    const raw = await readFile(queuePath, "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
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
var CollectorClient = class {
  baseUrl;
  token;
  pluginName;
  pluginVersion;
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.TINYAI_OBS_COLLECTOR_URL || "http://localhost:18080";
    this.token = options.token || process.env.TINYAI_OBS_TOKEN || "dev-token";
    this.pluginName = options.pluginName || "tinyai-observability";
    this.pluginVersion = options.pluginVersion || process.env.TINYAI_OBS_PLUGIN_VERSION || "0.1.0";
  }
  makeBatch(tool, events) {
    return {
      client_id: clientId(tool),
      plugin_name: this.pluginName,
      plugin_version: this.pluginVersion,
      events: events.map((event2) => ({
        ...event2,
        payload: redact(event2.payload, {
          allowFullConversationText: event2.event_type === "conversation_snapshot" && event2.payload?.include_text === true
        })
      }))
    };
  }
  async upload(tool, events) {
    const batch = this.makeBatch(tool, events);
    try {
      await this.postBatch(batch);
    } catch {
      await enqueueBatch(batch);
    }
  }
  async flushQueue() {
    const queued = await readQueuedBatches();
    const remaining = [];
    let sent = 0;
    for (const batch of queued) {
      try {
        await this.postBatch(batch);
        sent += batch.events.length;
      } catch {
        remaining.push(batch);
      }
    }
    await replaceQueue(remaining);
    return { sent, remaining: remaining.length };
  }
  async postBatch(batch) {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/v1/events/batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`
      },
      body: JSON.stringify(batch)
    });
    if (!response.ok) {
      throw new Error(`collector upload failed: ${response.status} ${await response.text()}`);
    }
  }
};

// ../../plugin-runtime/dist/git.js
import { execFile } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import { chmod, mkdir as mkdir2, readFile as readFile2, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
async function git(workspacePath2, args, timeout = 1e4) {
  const { stdout } = await execFileAsync("git", args, { cwd: workspacePath2, timeout });
  return stdout.trim();
}
async function resolvedGitDir(workspacePath2) {
  const gitDir = await git(workspacePath2, ["rev-parse", "--git-dir"]);
  return gitDir.startsWith("/") ? gitDir : join2(workspacePath2, gitDir);
}
async function aiActivityMarkerPath(workspacePath2) {
  return join2(await resolvedGitDir(workspacePath2), "tinyai-observability", "ai-activity.json");
}
async function aiLineEvidencePath(workspacePath2) {
  return join2(await resolvedGitDir(workspacePath2), "tinyai-observability", "ai-line-spans.jsonl");
}
function markerTtlMs() {
  const seconds = Number.parseInt(process.env.TINYAI_OBS_AI_MARKER_TTL_SECONDS || "21600", 10);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 21600) * 1e3;
}
function lineHash(filePath, content) {
  return createHash2("sha256").update(`${filePath}\0${content}`).digest("hex").slice(0, 32);
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
      currentFile = path === "/dev/null" ? "" : path.replace(/^b\//, "");
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
        line_hash: lineHash(currentFile, content)
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
    const raw = await readFile2(await aiActivityMarkerPath(workspacePath2), "utf8");
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
async function readAiLineEvidence(workspacePath2) {
  try {
    const raw = await readFile2(await aiLineEvidencePath(workspacePath2), "utf8");
    const now = Date.now();
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((item) => Date.parse(item.expires_at) >= now);
  } catch {
    return [];
  }
}
async function lineAttributionForCommit(workspacePath2, ref = "HEAD") {
  const commitLines = await diffAddedLines(workspacePath2, ["show", "--unified=0", "--no-color", "--format=", ref, "--", "."]);
  const evidence = await readAiLineEvidence(workspacePath2);
  const evidenceCounts = /* @__PURE__ */ new Map();
  for (const item of evidence) {
    const key = `${item.file_path}\0${item.line_hash}`;
    const bucket = evidenceCounts.get(key) || [];
    bucket.push(item);
    evidenceCounts.set(key, bucket);
  }
  const files = /* @__PURE__ */ new Map();
  let aiAdded = 0;
  for (const line of commitLines) {
    const file = files.get(line.file_path) || { file_path: line.file_path, ai_lines: [], human_lines: [] };
    const key = `${line.file_path}\0${line.line_hash}`;
    const bucket = evidenceCounts.get(key) || [];
    const matched = bucket.shift();
    if (matched) {
      aiAdded += 1;
      file.ai_lines.push({ new_line: line.new_line, line_hash: line.line_hash, evidence_source: matched.source });
    } else {
      file.human_lines.push({ new_line: line.new_line, line_hash: line.line_hash });
    }
    files.set(line.file_path, file);
  }
  return {
    total_added_lines: commitLines.length,
    ai_added_lines: aiAdded,
    human_added_lines: commitLines.length - aiAdded,
    files: [...files.values()]
  };
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
    const [added, deleted, ...pathParts] = row.split(/\s+/);
    const filePath = pathParts.join(" ");
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
    const lineAttribution = await lineAttributionForCommit(workspacePath2, ref);
    return {
      ...summary,
      commit_sha: await git(workspacePath2, ["rev-parse", ref]),
      branch: await currentBranch(workspacePath2),
      snapshot_kind: "commit",
      ...attr,
      ai_lines_added: attr.ai_assisted ? lineAttribution.ai_added_lines : 0,
      ai_lines_deleted: attr.ai_assisted ? summary.lines_deleted : 0,
      human_lines_added: attr.ai_assisted ? lineAttribution.human_added_lines : summary.lines_added,
      line_attribution: attr.ai_assisted ? lineAttribution : { ...lineAttribution, ai_added_lines: 0, human_added_lines: summary.lines_added },
      ai_attribution_method: "line_hash_diff_attribution"
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
      ai_attribution_method: "line_hash_diff_attribution",
      ai_attribution_evidence: "snapshot_failed",
      human_lines_added: 0,
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
  const hooksDir = join2(gitDir, "hooks");
  await mkdir2(hooksDir, { recursive: true });
  const hookScript = fileURLToPath(new URL("./hook.js", import.meta.url));
  const envLines = [
    `TINYAI_OBS_TOOL=${shellQuote(options.tool)}`,
    `TINYAI_OBS_PLUGIN_VERSION=${shellQuote(options.pluginVersion || process.env.TINYAI_OBS_PLUGIN_VERSION || "0.1.0")}`,
    "TINYAI_OBS_REQUIRE_AI_MARKER='1'",
    "TINYAI_OBS_SKIP_UNMARKED_COMMITS='1'"
  ];
  if (options.collectorUrl || process.env.TINYAI_OBS_COLLECTOR_URL)
    envLines.push(`TINYAI_OBS_COLLECTOR_URL=${shellQuote(options.collectorUrl || process.env.TINYAI_OBS_COLLECTOR_URL || "")}`);
  if (options.token || process.env.TINYAI_OBS_TOKEN)
    envLines.push(`TINYAI_OBS_TOKEN=${shellQuote(options.token || process.env.TINYAI_OBS_TOKEN || "")}`);
  const postCommit = `#!/bin/sh
# TinyAI Observability: record AI-attributed code entering commits.
${envLines.join(" ")} TINYAI_OBS_EVENT_TYPE=commit_snapshot node ${shellQuote(hookScript)} >/dev/null 2>&1 || true
`;
  const prePush = `#!/bin/sh
# TinyAI Observability: record AI-attributed branch diff before push.
${envLines.join(" ")} TINYAI_OBS_EVENT_TYPE=push_snapshot node ${shellQuote(hookScript)} >/dev/null 2>&1 || true
`;
  const postCommitPath = join2(hooksDir, "post-commit");
  const prePushPath = join2(hooksDir, "pre-push");
  await writeFile2(postCommitPath, postCommit, { mode: 493 });
  await writeFile2(prePushPath, prePush, { mode: 493 });
  await chmod(postCommitPath, 493);
  await chmod(prePushPath, 493);
  return { installed: [postCommitPath, prePushPath], git_dir: dirname2(hooksDir) };
}
function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ../../plugin-runtime/dist/spec-detector.js
import { readFile as readFile3, readdir } from "node:fs/promises";
import { join as join3, relative } from "node:path";
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
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles)
        return;
      const path = join3(dir, entry.name);
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
    join3(workspacePath2, "openspec", "specs", "workspaces"),
    join3(workspacePath2, "openspec", "specs", "official")
  ];
  const files = (await Promise.all(roots.map((root) => walk(root)))).flat();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const scored = [];
  for (const file of files) {
    const content = await readFile3(file, "utf8").catch(() => "");
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
var statusBar;
var panelProvider;
var extensionContext;
var pendingEvents = [];
var conversationMessages = [];
var COPILOT_TRANSCRIPT_STATE_KEY = "tinyaiObservability.copilotTranscriptHashes";
function workspacePath() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}
function config() {
  const cfg = vscode.workspace.getConfiguration("tinyaiObservability");
  return {
    collectorUrl: cfg.get("collectorUrl") || "http://localhost:18080",
    token: cfg.get("token") || "dev-token",
    captureConversationText: cfg.get("captureConversationText") ?? true,
    autoCaptureCopilotLocalTranscripts: cfg.get("autoCaptureCopilotLocalTranscripts") ?? true
  };
}
var PLUGIN_VERSION = "0.1.8";
function client() {
  const cfg = config();
  return new CollectorClient({ baseUrl: cfg.collectorUrl, token: cfg.token, pluginName: "tinyai-observability-vscode", pluginVersion: PLUGIN_VERSION });
}
function event(eventType, payload = {}, sourceConfidence = "direct", eventId) {
  if (!currentTaskId) return;
  eventForTask(currentTaskId, eventType, payload, sourceConfidence, eventId);
}
function eventForTask(taskId, eventType, payload = {}, sourceConfidence = "direct", eventId) {
  pendingEvents.push(makeEvent({ tool: "copilot", eventType, taskId, workspacePath: workspacePath(), payload, sourceConfidence, eventId }));
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
function hashText(text) {
  return createHash3("sha256").update(text).digest("hex").slice(0, 32);
}
function appendConversationMessage(role, text, source) {
  const message = conversationMessage(role, text, source);
  if (message) conversationMessages.push(message);
}
function conversationMessage(role, text, source) {
  const trimmed = text.trim();
  if (!trimmed) return void 0;
  const includeText = config().captureConversationText;
  const message = {
    role,
    text_len: trimmed.length,
    text_hash: hashText(trimmed),
    source
  };
  if (includeText) message.text = trimmed;
  return message;
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
function conversationSnapshotPayloadForMessages(messages, sessionId, sessionFile, source, extra = {}) {
  const userMessageCount = messages.filter((message) => message.role === "user").length;
  const assistantMessageCount = messages.filter((message) => message.role === "assistant").length;
  return {
    session_id: sessionId,
    session_file: sessionFile,
    cwd: workspacePath(),
    source,
    message_count: messages.length,
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
    capture_limitations: "Captured from VS Code local GitHub Copilot Chat transcript JSONL files under workspaceStorage. This is complete local user/assistant transcript text when VS Code writes those files, but it is classified as derived because it is read from persisted local transcripts rather than the Copilot Chat API.",
    messages,
    ...extra
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
async function listJsonlFiles(dir, transcriptKind) {
  try {
    const entries = await readdir2(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map(async (entry) => {
        const path = join4(dir, entry.name);
        const info = await stat(path);
        return { path, transcriptKind, mtimeMs: info.mtimeMs };
      })
    );
    return files;
  } catch {
    return [];
  }
}
function textFromUnknown(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.parts)) return record.parts.map(textFromUnknown).filter(Boolean).join("\n");
  return "";
}
function assistantTextFromResponseParts(value) {
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (!part || typeof part !== "object") return "";
    const record = part;
    if (record.kind === "thinking" || record.kind === "mcpServersStarting" || record.kind === "toolInvocationSerialized") return "";
    return typeof record.value === "string" ? record.value : "";
  }).filter(Boolean).join("\n").trim();
}
function userTextFromRenderedUserMessage(value) {
  const rendered = textFromUnknown(value);
  if (!rendered) return "";
  const match = /<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/i.exec(rendered);
  return (match?.[1] || "").trim();
}
function userTextFromChatSessionRequest(record) {
  const messageText = textFromUnknown(record.message);
  if (messageText) return messageText;
  const metadata = record.metadata && typeof record.metadata === "object" ? record.metadata : {};
  return userTextFromRenderedUserMessage(record.renderedUserMessage) || userTextFromRenderedUserMessage(metadata.renderedUserMessage);
}
function pushParsedMessage(messages, role, text, source) {
  const message = conversationMessage(role, text, source);
  if (message) messages.push(message);
}
function dedupeMessages(messages) {
  const seen = /* @__PURE__ */ new Set();
  return messages.filter((message) => {
    const key = `${message.role}:${message.text_hash}:${message.source || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function collectPotentialSpecPaths(value, output = /* @__PURE__ */ new Set()) {
  if (typeof value === "string") {
    const matches = value.match(/(?:file:\/\/)?(?:\/[^\s"'`<>\]\)]+\/)?openspec\/specs\/[^\s"'`<>\]\)]+/g) || [];
    for (const match of matches) {
      let candidate = match.replace(/^file:\/\//, "").replace(/[.,;:]+$/, "");
      const filePath = /^(.*?\.(?:md|ya?ml))/i.exec(candidate);
      if (filePath) candidate = filePath[1];
      candidate = candidate.replace(/\/n(?:@@|[-+#]|$).*/i, "");
      if (candidate.length < 500) output.add(candidate);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPotentialSpecPaths(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectPotentialSpecPaths(item, output);
  }
  return output;
}
function recordSpecAccessFromUnknown(value, specAccesses) {
  for (const candidate of collectPotentialSpecPaths(value)) {
    const classification = classifySpecPath(candidate);
    if (classification.spec_scope !== "unknown") specAccesses.set(classification.doc_path, classification);
  }
}
function parseChatSessionRequest(request, messages, source) {
  if (!request || typeof request !== "object") return;
  const record = request;
  const userText = userTextFromChatSessionRequest(record);
  if (userText) pushParsedMessage(messages, "user", userText, source);
  const assistantText = assistantTextFromResponseParts(record.response);
  if (assistantText) pushParsedMessage(messages, "assistant", assistantText, source);
}
function parseChatSessionPatch(entry, messages, source) {
  if (entry.kind === 0 && entry.v && typeof entry.v === "object") {
    const snapshot = entry.v;
    if (Array.isArray(snapshot.requests)) {
      for (const request of snapshot.requests) parseChatSessionRequest(request, messages, source);
    }
    return;
  }
  const keyPath = Array.isArray(entry.k) ? entry.k : [];
  if (keyPath.length === 1 && keyPath[0] === "requests" && Array.isArray(entry.v)) {
    for (const request of entry.v) parseChatSessionRequest(request, messages, source);
    return;
  }
  if (keyPath.length === 3 && keyPath[0] === "requests" && keyPath[2] === "response") {
    const assistantText = assistantTextFromResponseParts(entry.v);
    if (assistantText) pushParsedMessage(messages, "assistant", assistantText, source);
  }
}
async function parseCopilotTranscriptFile(sessionFile, transcriptKind) {
  let content;
  try {
    content = await readFile4(sessionFile, "utf8");
  } catch {
    return void 0;
  }
  const messages = [];
  let sessionId = basename(sessionFile, ".jsonl");
  let toolCallCount = 0;
  let toolResultCount = 0;
  let turnStartedCount = 0;
  let turnCompletedCount = 0;
  let turnAbortedCount = 0;
  let patchApplyCount = 0;
  let patchSuccessCount = 0;
  let startedAt;
  const patchToolCallIds = /* @__PURE__ */ new Set();
  const specAccesses = /* @__PURE__ */ new Map();
  const source = transcriptKind === "github-copilot-transcript" ? "copilot_local_transcript" : "copilot_chat_session";
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    recordSpecAccessFromUnknown(entry, specAccesses);
    const type = typeof entry.type === "string" ? entry.type : "";
    const data = entry.data && typeof entry.data === "object" ? entry.data : {};
    if (type === "session.start") {
      sessionId = String(data.sessionId || sessionId);
      if (typeof data.startTime === "string") startedAt = data.startTime;
    } else if (type === "user.message") {
      pushParsedMessage(messages, "user", textFromUnknown(data.content), source);
    } else if (type === "assistant.message") {
      pushParsedMessage(messages, "assistant", textFromUnknown(data.content), source);
      if (Array.isArray(data.toolRequests)) toolCallCount += data.toolRequests.length;
    } else if (type === "tool.execution_start") {
      toolCallCount += 1;
      const toolName = String(data.toolName || "").toLowerCase();
      const toolCallId = String(data.toolCallId || "");
      if (toolName.includes("patch") || toolName.includes("edit") || toolName.includes("replace")) {
        patchApplyCount += 1;
        if (toolCallId) patchToolCallIds.add(toolCallId);
      }
    } else if (type === "tool.execution_complete") {
      toolResultCount += 1;
      const toolCallId = String(data.toolCallId || "");
      if (data.success === true && patchToolCallIds.has(toolCallId)) patchSuccessCount += 1;
    } else if (type === "assistant.turn_start") {
      turnStartedCount += 1;
    } else if (type === "assistant.turn_end") {
      turnCompletedCount += 1;
    } else if (type.includes("abort") || type.includes("cancel")) {
      turnAbortedCount += 1;
    }
    if (typeof entry.kind === "number") {
      if (entry.kind === 0 && entry.v && typeof entry.v === "object") {
        const snapshot = entry.v;
        if (typeof snapshot.sessionId === "string" && snapshot.sessionId) sessionId = snapshot.sessionId;
        if (!startedAt) {
          if (typeof snapshot.creationDate === "string") startedAt = snapshot.creationDate;
          if (typeof snapshot.creationDate === "number") startedAt = new Date(snapshot.creationDate).toISOString();
        }
      }
      parseChatSessionPatch(entry, messages, source);
    }
  }
  const deduped = dedupeMessages(messages);
  if (deduped.length === 0) return void 0;
  return {
    sessionId,
    sessionFile,
    transcriptKind,
    contentHash: hashText(content),
    messages: deduped,
    toolCallCount,
    toolResultCount,
    turnStartedCount,
    turnCompletedCount,
    turnAbortedCount,
    patchApplyCount,
    patchSuccessCount,
    specAccesses: [...specAccesses.values()],
    startedAt
  };
}
async function captureCopilotLocalTranscripts(options = {}) {
  const context = extensionContext;
  const root = workspaceStorageRoot();
  if (!context || !root) {
    if (!options.silent) vscode.window.showWarningMessage("TinyAI Observability cannot locate VS Code workspaceStorage yet.");
    return;
  }
  const files = [
    ...await listJsonlFiles(join4(root, "GitHub.copilot-chat", "transcripts"), "github-copilot-transcript"),
    ...await listJsonlFiles(join4(root, "chatSessions"), "vscode-chat-session")
  ].sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, 30);
  const seen = { ...context.workspaceState.get(COPILOT_TRANSCRIPT_STATE_KEY) || {} };
  let uploaded = 0;
  let capturedMessages = 0;
  for (const file of files) {
    const parsed = await parseCopilotTranscriptFile(file.path, file.transcriptKind);
    if (!parsed || seen[file.path] === parsed.contentHash) continue;
    const taskId = `copilot-local-${parsed.sessionId}`.slice(0, 64);
    if (!seen[file.path]) {
      eventForTask(taskId, "task_start", { trigger: "copilot_local_transcript", session_file: parsed.sessionFile, transcript_kind: parsed.transcriptKind, started_at: parsed.startedAt }, "derived");
    }
    eventForTask(
      taskId,
      "conversation_snapshot",
      conversationSnapshotPayloadForMessages(parsed.messages, parsed.sessionId, parsed.sessionFile, "vscode-copilot-local-transcript", {
        snapshot_kind: "copilot_local_transcript",
        transcript_kind: parsed.transcriptKind,
        transcript_hash: parsed.contentHash,
        tool_call_count: parsed.toolCallCount,
        tool_result_count: parsed.toolResultCount,
        turn_started_count: parsed.turnStartedCount,
        turn_completed_count: parsed.turnCompletedCount,
        turn_aborted_count: parsed.turnAbortedCount,
        patch_apply_count: parsed.patchApplyCount,
        patch_success_count: parsed.patchSuccessCount
      }),
      "derived"
    );
    for (const access of parsed.specAccesses) {
      eventForTask(
        taskId,
        access.spec_scope === "official" ? "official_misread" : "spec_read",
        { ...access, source: "copilot_local_transcript", transcript_kind: parsed.transcriptKind },
        "derived"
      );
    }
    seen[file.path] = parsed.contentHash;
    uploaded += 1;
    capturedMessages += parsed.messages.length;
  }
  if (uploaded > 0) {
    await ensureTask("copilot_local_transcript");
    await markAiActivity(workspacePath(), { tool: "copilot", taskId: currentTaskId, source: "copilot_local_transcript" });
    await flush();
    await context.workspaceState.update(COPILOT_TRANSCRIPT_STATE_KEY, seen);
    updateStatus();
  }
  if (!options.silent) {
    vscode.window.showInformationMessage(
      uploaded > 0 ? `TinyAI captured ${capturedMessages} Copilot transcript messages from ${uploaded} local file(s).` : "TinyAI found no new local Copilot transcript messages."
    );
  }
}
async function flush() {
  if (!pendingEvents.length) return;
  const toUpload = pendingEvents.splice(0, pendingEvents.length);
  await client().upload("copilot", toUpload);
}
async function heartbeat() {
  eventForTask(
    "copilot-plugin-heartbeat",
    "plugin_heartbeat",
    {
      activation: "vscode",
      auto_capture_copilot_local_transcripts: config().autoCaptureCopilotLocalTranscripts,
      capture_conversation_text: config().captureConversationText
    },
    "direct"
  );
  await flush();
}
function updateStatus() {
  statusBar.text = currentTaskId ? "TinyAI Obs: On" : "TinyAI Obs: Idle";
  statusBar.tooltip = currentTaskId ? `Current task: ${currentTaskId}` : "Open TinyAI Observability actions.";
  statusBar.command = "tinyaiObservability.showMenu";
  panelProvider?.refresh();
}
async function configure() {
  const cfg = config();
  const collectorUrl = await vscode.window.showInputBox({ title: "TinyAI collector URL", value: cfg.collectorUrl });
  if (collectorUrl) await vscode.workspace.getConfiguration("tinyaiObservability").update("collectorUrl", collectorUrl, vscode.ConfigurationTarget.Global);
  const token = await vscode.window.showInputBox({ title: "TinyAI collector token", value: cfg.token, password: true });
  if (token) await vscode.workspace.getConfiguration("tinyaiObservability").update("token", token, vscode.ConfigurationTarget.Global);
}
async function openDashboard() {
  await vscode.env.openExternal(vscode.Uri.parse("http://localhost:18081"));
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
  if (!currentTaskId) {
    vscode.window.showInformationMessage("Start a TinyAI Observability task first.");
    return;
  }
  const kind = await vscode.window.showQuickPick(["user_correction", "regenerate", "interruption"], { title: "Feedback type" });
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
async function installGitHooksForWorkspace() {
  try {
    const cfg = config();
    const result = await installGitHooks(workspacePath(), {
      tool: "copilot",
      collectorUrl: cfg.collectorUrl,
      token: cfg.token,
      pluginVersion: PLUGIN_VERSION
    });
    eventForTask(
      "copilot-git-hooks",
      "plugin_heartbeat",
      {
        activation: "git_hooks_install",
        installed_hooks: result.installed,
        git_dir: result.git_dir,
        hook_events: ["commit_snapshot", "push_snapshot"]
      },
      "direct"
    );
    await flush();
    vscode.window.showInformationMessage("TinyAI installed Git hooks for commit/push AI code attribution.");
  } catch (error) {
    vscode.window.showErrorMessage(`TinyAI failed to install Git hooks: ${String(error)}`);
  }
}
async function showMenu() {
  const choice = await vscode.window.showQuickPick(
    [
      { label: "Capture Active Editor Conversation", detail: "Paste a Copilot transcript into an editor, then choose this.", command: "captureActiveEditorConversation" },
      { label: "Capture Clipboard Conversation", detail: "Import transcript text currently in the clipboard.", command: "captureClipboardConversation" },
      { label: "Capture Copilot Local Transcripts", detail: "Read local VS Code Copilot Chat transcript JSONL files and upload full user/assistant messages.", command: "captureCopilotLocalTranscripts" },
      { label: currentTaskId ? "End Task" : "Start Task", detail: currentTaskId ? "Upload final code/change snapshot." : "Begin a new task session.", command: currentTaskId ? "endTask" : "startTask" },
      { label: "Record Commit Snapshot", detail: "Upload HEAD commit diff for AI-written code attribution.", command: "commitSnapshot" },
      { label: "Record AI Lines Snapshot", detail: "Record current diff added lines as AI evidence before commit.", command: "aiLinesSnapshot" },
      { label: "Record Push/PR Snapshot", detail: "Upload branch diff against upstream for PR-level AI code attribution.", command: "pushSnapshot" },
      { label: "Install Git Hooks", detail: "Automatically record commit and push snapshots from Git hooks.", command: "installGitHooks" },
      { label: "Record Feedback", detail: "User correction, regeneration, interruption, or specs misunderstanding.", command: "recordFeedback" },
      { label: "Record Adoption Snapshot", detail: "Generated vs retained line counts.", command: "adoptionSnapshot" },
      { label: "Open Dashboard", detail: "Open the local TinyAI observability dashboard.", command: "openDashboard" },
      { label: "Flush Events", detail: "Upload pending events now.", command: "flush" }
    ],
    { title: "TinyAI Observability" }
  );
  if (!choice) return;
  if (choice.command === "captureActiveEditorConversation") await captureActiveEditorConversation();
  if (choice.command === "captureClipboardConversation") await captureClipboardConversation();
  if (choice.command === "captureCopilotLocalTranscripts") await captureCopilotLocalTranscripts();
  if (choice.command === "startTask") await startTask();
  if (choice.command === "endTask") await endTask();
  if (choice.command === "commitSnapshot") await recordCommitSnapshot();
  if (choice.command === "aiLinesSnapshot") await recordAiLinesSnapshot();
  if (choice.command === "pushSnapshot") await recordPushSnapshot();
  if (choice.command === "installGitHooks") await installGitHooksForWorkspace();
  if (choice.command === "recordFeedback") await recordFeedback();
  if (choice.command === "adoptionSnapshot") await adoptionSnapshot();
  if (choice.command === "openDashboard") await openDashboard();
  if (choice.command === "flush") await flush();
}
var ObservabilityPanelProvider = class {
  view;
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml();
    view.webview.onDidReceiveMessage(async (message) => {
      if (message?.command === "start") await startTask();
      if (message?.command === "sendPrompt") {
        const response = await runTinyAIProxyPrompt(String(message?.prompt || ""), "tinyai_panel");
        this.refresh(response);
        return;
      }
      if (message?.command === "captureEditor") await captureActiveEditorConversation();
      if (message?.command === "captureClipboard") await captureClipboardConversation();
      if (message?.command === "captureCopilotLocal") await captureCopilotLocalTranscripts();
      if (message?.command === "commitSnapshot") await recordCommitSnapshot();
      if (message?.command === "aiLinesSnapshot") await recordAiLinesSnapshot();
      if (message?.command === "pushSnapshot") await recordPushSnapshot();
      if (message?.command === "installGitHooks") await installGitHooksForWorkspace();
      if (message?.command === "feedback") await recordFeedback();
      if (message?.command === "adoption") await adoptionSnapshot();
      if (message?.command === "end") await endTask();
      if (message?.command === "flush") await flush();
      if (message?.command === "dashboard") await openDashboard();
      this.refresh();
    });
  }
  refresh(latestResponse) {
    if (this.view) this.view.webview.html = this.renderHtml(latestResponse);
  }
  renderHtml(latestResponse = "") {
    const taskText = currentTaskId ? `On: ${currentTaskId.slice(0, 8)}` : "Idle";
    const messageCount = conversationMessages.length;
    const recentMessages = conversationMessages.slice(-6).map((message) => {
      const text = typeof message.text === "string" ? message.text : `[${message.text_len} chars]`;
      return `<div class="msg ${escapeHtml(message.role)}"><div class="role">${escapeHtml(message.role)}</div><div>${escapeHtml(text)}</div></div>`;
    }).join("");
    return (
      /* html */
      `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); padding: 12px; }
    .status { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 12px; padding: 10px; }
    .label { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 4px; }
    .value { font-weight: 600; overflow-wrap: anywhere; }
    button { align-items: center; background: var(--vscode-button-background); border: 0; border-radius: 4px; color: var(--vscode-button-foreground); cursor: pointer; display: flex; font: inherit; justify-content: center; margin-bottom: 8px; min-height: 30px; padding: 7px 9px; width: 100%; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    textarea { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; box-sizing: border-box; color: var(--vscode-input-foreground); font: inherit; min-height: 92px; margin-bottom: 8px; padding: 8px; resize: vertical; width: 100%; }
    .msg { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 8px; max-height: 160px; overflow: auto; padding: 8px; white-space: pre-wrap; }
    .role { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 4px; text-transform: uppercase; }
    p { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; margin: 10px 0; }
  </style>
</head>
<body>
  <div class="status">
    <div class="label">Task</div>
    <div class="value">${escapeHtml(taskText)}</div>
  </div>
  <div class="status">
    <div class="label">Captured Messages</div>
    <div class="value">${messageCount}</div>
  </div>
  <textarea id="prompt" placeholder="Ask TinyAI using personal specs..."></textarea>
  <button data-command="sendPrompt">Send with TinyAI</button>
  ${latestResponse ? `<div class="msg assistant"><div class="role">Latest Response</div><div>${escapeHtml(latestResponse)}</div></div>` : ""}
  ${recentMessages ? `<p>Recent captured messages</p>${recentMessages}` : ""}
  <button data-command="start">${currentTaskId ? "Restart Task" : "Start Task"}</button>
  <button data-command="captureCopilotLocal">Capture Copilot Local Transcripts</button>
  <button data-command="captureEditor">Capture Active Editor Conversation</button>
  <button data-command="captureClipboard" class="secondary">Capture Clipboard Conversation</button>
  <button data-command="commitSnapshot">Record Commit Snapshot</button>
  <button data-command="aiLinesSnapshot">Record AI Lines Snapshot</button>
  <button data-command="pushSnapshot">Record Push/PR Snapshot</button>
  <button data-command="installGitHooks" class="secondary">Install Git Hooks</button>
  <button data-command="feedback" class="secondary">Record Feedback</button>
  <button data-command="adoption" class="secondary">Record Adoption Snapshot</button>
  <button data-command="end">${currentTaskId ? "End Task" : "End Task"}</button>
  <button data-command="dashboard" class="secondary">Open Dashboard</button>
  <button data-command="flush" class="secondary">Flush Events</button>
  <p>Normal Copilot Chat is auto-captured from local VS Code transcript files when available. Use the transcript button to force a scan; editor and clipboard import remain fallbacks.</p>
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll("button[data-command]").forEach((button) => {
      button.addEventListener("click", () => vscode.postMessage({ command: button.dataset.command, prompt: document.getElementById("prompt")?.value || "" }));
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
  event(classification.spec_scope === "official" ? "official_misread" : "spec_read", { ...classification }, classification.via_catalog ? "direct" : "derived");
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
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.recordCommitSnapshot", () => recordCommitSnapshot()));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.recordAiLinesSnapshot", () => recordAiLinesSnapshot()));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.recordPushSnapshot", () => recordPushSnapshot()));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.installGitHooks", installGitHooksForWorkspace));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.recordFeedback", recordFeedback));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.adoptionSnapshot", adoptionSnapshot));
  context.subscriptions.push(vscode.commands.registerCommand("tinyaiObservability.showCurrentTask", () => {
    vscode.window.showInformationMessage(currentTaskId ? `TinyAI task: ${currentTaskId}` : "No TinyAI task is active.");
  }));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => recordSpecAccess(doc.uri)));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
    if (!currentTaskId || doc.uri.scheme !== "file") return;
    event("code_change", { file_path_hash: vscode.workspace.asRelativePath(doc.uri, false), trigger: "save" }, "derived");
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((change) => {
    if (!currentTaskId || change.document.uri.scheme !== "file") return;
    if (change.contentChanges.length > 0) {
      event("code_change", { file_path_hash: vscode.workspace.asRelativePath(change.document.uri, false), trigger: "edit", change_count: change.contentChanges.length }, "derived");
    }
  }));
  registerChatSurface(context);
  void heartbeat();
  if (config().autoCaptureCopilotLocalTranscripts) {
    void captureCopilotLocalTranscripts({ silent: true });
    const timer = setInterval(() => void captureCopilotLocalTranscripts({ silent: true }), 15e3);
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
