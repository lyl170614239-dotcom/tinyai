import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitDiffSummary {
  files_changed: number;
  lines_added: number;
  lines_deleted: number;
  file_paths: string[];
}

export interface DiffAddedLine {
  file_path: string;
  new_line: number;
  content: string;
  line_hash: string;
}

export interface LineAttribution {
  total_added_lines: number;
  ai_added_lines: number;
  human_added_lines: number;
  files: Array<{
    file_path: string;
    ai_lines: Array<{ new_line: number; line_hash: string; evidence_source?: string }>;
    human_lines: Array<{ new_line: number; line_hash: string }>;
  }>;
}

export interface AiLineEvidence {
  tool: string;
  task_id?: string;
  source?: string;
  file_path: string;
  new_line: number;
  line_hash: string;
  recorded_at: string;
  expires_at: string;
}

export interface GitCommitSnapshot extends GitDiffSummary {
  commit_sha?: string;
  branch?: string;
  snapshot_kind: "commit";
  ai_assisted: boolean;
  ai_lines_added: number;
  ai_lines_deleted: number;
  ai_attribution_method: string;
  ai_attribution_evidence: string;
  ai_marker_task_id?: string;
  ai_marker_age_seconds?: number;
  human_lines_added: number;
  line_attribution: LineAttribution;
}

export interface GitPushSnapshot extends GitDiffSummary {
  branch?: string;
  upstream_ref?: string;
  base_sha?: string;
  head_sha?: string;
  commit_count: number;
  snapshot_kind: "push";
  ai_assisted: boolean;
  ai_lines_added: number;
  ai_lines_deleted: number;
  ai_attribution_method: string;
  ai_attribution_evidence: string;
  ai_marker_task_id?: string;
  ai_marker_age_seconds?: number;
}

export interface AiActivityMarker {
  tool: string;
  task_id?: string;
  source?: string;
  marked_at: string;
  expires_at: string;
}

export interface AttributionOptions {
  requireAiMarker?: boolean;
  aiAssisted?: boolean;
  attributionEvidence?: string;
}

async function git(workspacePath: string, args: string[], timeout = 10000): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: workspacePath, timeout });
  return stdout.trim();
}

async function resolvedGitDir(workspacePath: string): Promise<string> {
  const gitDir = await git(workspacePath, ["rev-parse", "--git-dir"]);
  return gitDir.startsWith("/") ? gitDir : join(workspacePath, gitDir);
}

async function aiActivityMarkerPath(workspacePath: string): Promise<string> {
  return join(await resolvedGitDir(workspacePath), "tinyai-observability", "ai-activity.json");
}

async function aiLineEvidencePath(workspacePath: string): Promise<string> {
  return join(await resolvedGitDir(workspacePath), "tinyai-observability", "ai-line-spans.jsonl");
}

function markerTtlMs(): number {
  const seconds = Number.parseInt(process.env.TINYAI_OBS_AI_MARKER_TTL_SECONDS || "21600", 10);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 21600) * 1000;
}

function lineHash(filePath: string, content: string): string {
  return createHash("sha256").update(`${filePath}\0${content}`).digest("hex").slice(0, 32);
}

function parseUnifiedAddedLines(diff: string): DiffAddedLine[] {
  const added: DiffAddedLine[] = [];
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
    if (!currentFile || !line) continue;
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

async function diffAddedLines(workspacePath: string, args: string[]): Promise<DiffAddedLine[]> {
  try {
    return parseUnifiedAddedLines(await git(workspacePath, args, 20000));
  } catch {
    return [];
  }
}

export async function markAiActivity(
  workspacePath: string,
  options: { tool: string; taskId?: string; source?: string; ttlSeconds?: number }
): Promise<AiActivityMarker | undefined> {
  try {
    const path = await aiActivityMarkerPath(workspacePath);
    const now = new Date();
    const ttlMs = options.ttlSeconds && options.ttlSeconds > 0 ? options.ttlSeconds * 1000 : markerTtlMs();
    const marker: AiActivityMarker = {
      tool: options.tool,
      task_id: options.taskId,
      source: options.source,
      marked_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlMs).toISOString()
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(marker, null, 2));
    return marker;
  } catch {
    return undefined;
  }
}

export async function recordAiLineSnapshot(
  workspacePath: string,
  options: {
    tool: string;
    taskId?: string;
    source?: string;
    stagedOnly?: boolean;
    requireAiMarker?: boolean;
    ttlSeconds?: number;
  }
): Promise<{ recorded_lines: number; files_changed: number; skipped: boolean; reason?: string }> {
  const activeMarker = await readActiveAiMarker(workspacePath);
  if (options.requireAiMarker && !activeMarker) {
    return { recorded_lines: 0, files_changed: 0, skipped: true, reason: "no_active_ai_task_marker" };
  }

  const addedLines = [
    ...(await diffAddedLines(workspacePath, ["diff", "--cached", "--unified=0", "--no-color", "--", "."])),
    ...(options.stagedOnly ? [] : await diffAddedLines(workspacePath, ["diff", "--unified=0", "--no-color", "--", "."]))
  ];
  if (addedLines.length === 0) {
    return { recorded_lines: 0, files_changed: 0, skipped: false };
  }

  const now = new Date();
  const ttlMs = options.ttlSeconds && options.ttlSeconds > 0 ? options.ttlSeconds * 1000 : markerTtlMs();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const evidence: AiLineEvidence[] = addedLines.map((line) => ({
    tool: options.tool,
    task_id: options.taskId || activeMarker?.marker.task_id,
    source: options.source,
    file_path: line.file_path,
    new_line: line.new_line,
    line_hash: line.line_hash,
    recorded_at: now.toISOString(),
    expires_at: expiresAt
  }));
  const path = await aiLineEvidencePath(workspacePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, evidence.map((item) => JSON.stringify(item)).join("\n") + "\n", { flag: "a" });
  return {
    recorded_lines: evidence.length,
    files_changed: new Set(evidence.map((item) => item.file_path)).size,
    skipped: false
  };
}

async function readActiveAiMarker(workspacePath: string): Promise<{ marker: AiActivityMarker; age_seconds: number } | undefined> {
  try {
    const raw = await readFile(await aiActivityMarkerPath(workspacePath), "utf8");
    const marker = JSON.parse(raw) as AiActivityMarker;
    const markedAt = Date.parse(marker.marked_at);
    const expiresAt = Date.parse(marker.expires_at);
    const now = Date.now();
    if (!Number.isFinite(markedAt) || !Number.isFinite(expiresAt) || expiresAt < now) return undefined;
    return { marker, age_seconds: Math.max(0, Math.round((now - markedAt) / 1000)) };
  } catch {
    return undefined;
  }
}

async function readAiLineEvidence(workspacePath: string): Promise<AiLineEvidence[]> {
  try {
    const raw = await readFile(await aiLineEvidencePath(workspacePath), "utf8");
    const now = Date.now();
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AiLineEvidence)
      .filter((item) => Date.parse(item.expires_at) >= now);
  } catch {
    return [];
  }
}

async function lineAttributionForCommit(workspacePath: string, ref = "HEAD"): Promise<LineAttribution> {
  const commitLines = await diffAddedLines(workspacePath, ["show", "--unified=0", "--no-color", "--format=", ref, "--", "."]);
  const evidence = await readAiLineEvidence(workspacePath);
  const evidenceCounts = new Map<string, AiLineEvidence[]>();
  for (const item of evidence) {
    const key = `${item.file_path}\0${item.line_hash}`;
    const bucket = evidenceCounts.get(key) || [];
    bucket.push(item);
    evidenceCounts.set(key, bucket);
  }

  const files = new Map<string, LineAttribution["files"][number]>();
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

async function attribution(workspacePath: string, options: AttributionOptions = {}) {
  const activeMarker = await readActiveAiMarker(workspacePath);
  const aiAssisted = options.aiAssisted ?? (options.requireAiMarker ? Boolean(activeMarker) : true);
  const evidence =
    options.attributionEvidence ||
    (activeMarker ? "active_ai_task_marker" : options.requireAiMarker ? "no_active_ai_task_marker" : "manual_snapshot");
  return {
    ai_assisted: aiAssisted,
    ai_attribution_evidence: evidence,
    ai_marker_task_id: activeMarker?.marker.task_id,
    ai_marker_age_seconds: activeMarker?.age_seconds
  };
}

function parseNumstat(stdout: string): GitDiffSummary {
  const rows = stdout.split("\n").filter(Boolean);
  let linesAdded = 0;
  let linesDeleted = 0;
  const filePaths: string[] = [];
  for (const row of rows) {
    const [added, deleted, ...pathParts] = row.split(/\s+/);
    const filePath = pathParts.join(" ");
    if (filePath) filePaths.push(filePath);
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

export async function diffSummary(workspacePath: string): Promise<GitDiffSummary> {
  try {
    return parseNumstat(await git(workspacePath, ["diff", "--numstat", "--", "."]));
  } catch {
    return { files_changed: 0, lines_added: 0, lines_deleted: 0, file_paths: [] };
  }
}

export async function currentBranch(workspacePath: string): Promise<string | undefined> {
  try {
    return await git(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return undefined;
  }
}

export async function currentHead(workspacePath: string): Promise<string | undefined> {
  try {
    return await git(workspacePath, ["rev-parse", "HEAD"]);
  } catch {
    return undefined;
  }
}

export async function commitSnapshot(workspacePath: string, ref = "HEAD", options: AttributionOptions = {}): Promise<GitCommitSnapshot> {
  try {
    const summary = parseNumstat(await git(workspacePath, ["show", "--numstat", "--format=", ref, "--", "."]));
    const attr = await attribution(workspacePath, options);
    const lineAttribution = await lineAttributionForCommit(workspacePath, ref);
    return {
      ...summary,
      commit_sha: await git(workspacePath, ["rev-parse", ref]),
      branch: await currentBranch(workspacePath),
      snapshot_kind: "commit",
      ...attr,
      ai_lines_added: attr.ai_assisted ? lineAttribution.ai_added_lines : 0,
      ai_lines_deleted: attr.ai_assisted ? summary.lines_deleted : 0,
      human_lines_added: attr.ai_assisted ? lineAttribution.human_added_lines : summary.lines_added,
      line_attribution: attr.ai_assisted
        ? lineAttribution
        : { ...lineAttribution, ai_added_lines: 0, human_added_lines: summary.lines_added },
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

async function upstreamRef(workspacePath: string): Promise<string | undefined> {
  try {
    return await git(workspacePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    return undefined;
  }
}

async function commitCount(workspacePath: string, range: string): Promise<number> {
  try {
    return Number.parseInt(await git(workspacePath, ["rev-list", "--count", range]), 10) || 0;
  } catch {
    return 0;
  }
}

export async function pushSnapshot(workspacePath: string, options: AttributionOptions = {}): Promise<GitPushSnapshot> {
  const branch = await currentBranch(workspacePath);
  const headSha = await currentHead(workspacePath);
  const attr = await attribution(workspacePath, options);
  const upstream = await upstreamRef(workspacePath);
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
    const baseSha = await git(workspacePath, ["merge-base", "HEAD", upstream]);
    const range = `${baseSha}..HEAD`;
    const summary = parseNumstat(await git(workspacePath, ["diff", "--numstat", range, "--", "."]));
    return {
      ...summary,
      branch,
      upstream_ref: upstream,
      base_sha: baseSha,
      head_sha: headSha,
      commit_count: await commitCount(workspacePath, range),
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

export async function installGitHooks(workspacePath: string, options: { tool: string; collectorUrl?: string; token?: string; pluginVersion?: string }):
  Promise<{ installed: string[]; git_dir?: string }> {
  const gitDir = await resolvedGitDir(workspacePath);
  const hooksDir = join(gitDir, "hooks");
  await mkdir(hooksDir, { recursive: true });

  const hookScript = fileURLToPath(new URL("./hook.js", import.meta.url));
  const envLines = [
    `TINYAI_OBS_TOOL=${shellQuote(options.tool)}`,
    `TINYAI_OBS_PLUGIN_VERSION=${shellQuote(options.pluginVersion || process.env.TINYAI_OBS_PLUGIN_VERSION || "0.1.0")}`,
    "TINYAI_OBS_REQUIRE_AI_MARKER='1'",
    "TINYAI_OBS_SKIP_UNMARKED_COMMITS='1'"
  ];
  if (options.collectorUrl || process.env.TINYAI_OBS_COLLECTOR_URL) envLines.push(`TINYAI_OBS_COLLECTOR_URL=${shellQuote(options.collectorUrl || process.env.TINYAI_OBS_COLLECTOR_URL || "")}`);
  if (options.token || process.env.TINYAI_OBS_TOKEN) envLines.push(`TINYAI_OBS_TOKEN=${shellQuote(options.token || process.env.TINYAI_OBS_TOKEN || "")}`);

  const postCommit = `#!/bin/sh
# TinyAI Observability: record AI-attributed code entering commits.
${envLines.join(" ")} TINYAI_OBS_EVENT_TYPE=commit_snapshot node ${shellQuote(hookScript)} >/dev/null 2>&1 || true
`;
  const prePush = `#!/bin/sh
# TinyAI Observability: record AI-attributed branch diff before push.
${envLines.join(" ")} TINYAI_OBS_EVENT_TYPE=push_snapshot node ${shellQuote(hookScript)} >/dev/null 2>&1 || true
`;

  const postCommitPath = join(hooksDir, "post-commit");
  const prePushPath = join(hooksDir, "pre-push");
  await writeFile(postCommitPath, postCommit, { mode: 0o755 });
  await writeFile(prePushPath, prePush, { mode: 0o755 });
  await chmod(postCommitPath, 0o755);
  await chmod(prePushPath, 0o755);

  return { installed: [postCommitPath, prePushPath], git_dir: dirname(hooksDir) };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
