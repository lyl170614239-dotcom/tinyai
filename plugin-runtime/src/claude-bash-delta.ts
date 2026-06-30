import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { collectClaudePotentialFilePaths } from "./claude-workspace-fallback.js";

const execFileAsync = promisify(execFile);

type SnapshotFile = {
  file_path: string;
  exists: boolean;
  kind?: "file" | "directory" | "missing" | "other";
  size_bytes: number;
  sha256?: string;
  content_base64?: string;
  binary?: boolean;
};

export type ClaudeBashSnapshot = {
  schema_version: "claude.bash_snapshot.v1";
  workspace_path: string;
  command: string;
  command_hash: string;
  tool_call_id?: string;
  captured_at: string;
  file_paths: string[];
  files: SnapshotFile[];
};

type ClaudeBashDeltaOptions = {
  command: string;
  sessionId?: string;
  requestId?: string;
  responseId?: string;
  turnIndex?: number;
  toolCallId?: string;
  occurredAt?: string;
};

type DiffLine = {
  line_type: "added" | "removed" | "context";
  old_line?: number;
  new_line?: number;
  text: string;
  text_hash: string;
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandHash(command: string): string {
  return sha256(command).slice(0, 32);
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8000)).includes(0);
}

function normalizeRelativePath(workspacePath: string, rawPath: string): string | undefined {
  let candidate = rawPath.trim().replace(/^file:\/\//, "").replace(/^['"`]|['"`]$/g, "");
  if (!candidate || /^(https?:|mailto:|data:)/i.test(candidate)) return undefined;
  if (candidate.includes("\0") || candidate.includes("node_modules/") || candidate.includes(".git/")) return undefined;
  if (candidate.startsWith("~/")) return undefined;
  const absolute = isAbsolute(candidate) ? candidate : resolve(workspacePath, candidate.replace(/^\.?\//, ""));
  const rel = relative(workspacePath, absolute).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) return undefined;
  return rel;
}

async function git(workspacePath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], { cwd: workspacePath, timeout: 20000 });
  return String(stdout || "").trimEnd();
}

function decodeStatusPath(raw: string): string {
  const path = raw.includes(" -> ") ? raw.split(" -> ").pop() || raw : raw;
  return path.replace(/^"|"$/g, "");
}

async function dirtyFiles(workspacePath: string): Promise<string[]> {
  try {
    const raw = await git(workspacePath, ["status", "--porcelain", "--untracked-files=all"]);
    return [...new Set(raw.split(/\r?\n/).filter(Boolean).map((line) => decodeStatusPath(line.slice(3).trim()).replace(/\\/g, "/")))];
  } catch {
    return [];
  }
}

async function headFile(workspacePath: string, filePath: string): Promise<Buffer | undefined> {
  try {
    const objectType = await git(workspacePath, ["cat-file", "-t", `HEAD:${filePath}`]);
    if (objectType !== "blob") return undefined;
    const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", "show", `HEAD:${filePath}`], {
      cwd: workspacePath,
      encoding: "buffer",
      maxBuffer: 1024 * 1024 * 200,
      timeout: 30000
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch {
    return undefined;
  }
}

function candidatePaths(workspacePath: string, command: string, extraPaths: string[] = []): string[] {
  const output = new Set<string>();
  for (const rawPath of [...collectClaudePotentialFilePaths(command), ...extraPaths]) {
    const normalized = normalizeRelativePath(workspacePath, rawPath);
    if (normalized) output.add(normalized);
  }
  return [...output].slice(0, 200);
}

async function snapshotFile(workspacePath: string, filePath: string): Promise<SnapshotFile> {
  const absolute = join(workspacePath, filePath);
  try {
    const fileStat = await stat(absolute);
    if (fileStat.isDirectory()) return { file_path: filePath, exists: false, kind: "directory", size_bytes: 0 };
    if (!fileStat.isFile()) return { file_path: filePath, exists: false, kind: "other", size_bytes: 0 };
    const content = await readFile(absolute);
    return {
      file_path: filePath,
      exists: true,
      kind: "file",
      size_bytes: content.length,
      sha256: sha256(content),
      content_base64: content.toString("base64"),
      binary: isBinary(content)
    };
  } catch {
    return { file_path: filePath, exists: false, kind: "missing", size_bytes: 0 };
  }
}

export async function captureClaudeBashSnapshot(
  workspacePath: string,
  options: { command: string; toolCallId?: string; extraPaths?: string[] }
): Promise<ClaudeBashSnapshot> {
  const paths = candidatePaths(workspacePath, options.command, [...(options.extraPaths || []), ...(await dirtyFiles(workspacePath))]);
  const files = await Promise.all(paths.map((filePath) => snapshotFile(workspacePath, filePath)));
  return {
    schema_version: "claude.bash_snapshot.v1",
    workspace_path: workspacePath,
    command: options.command,
    command_hash: commandHash(options.command),
    tool_call_id: options.toolCallId,
    captured_at: new Date().toISOString(),
    file_paths: paths,
    files
  };
}

function snapshotContent(file: SnapshotFile | undefined): Buffer | undefined {
  if (!file?.exists || !file.content_base64) return undefined;
  return Buffer.from(file.content_base64, "base64");
}

function lineHash(filePath: string, text: string): string {
  return sha256(`${filePath}\0${text}`);
}

function parseUnifiedDiff(diff: string, filePath: string) {
  const hunks: Array<{ old_start: number; old_lines: number; new_start: number; new_lines: number; lines: DiffLine[] }> = [];
  let current: (typeof hunks)[number] | undefined;
  let oldLine = 0;
  let newLine = 0;
  let linesAdded = 0;
  let linesDeleted = 0;

  for (const line of diff.split(/\r?\n/)) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[3], 10);
      current = {
        old_start: oldLine,
        old_lines: Number.parseInt(hunk[2] || "1", 10),
        new_start: newLine,
        new_lines: Number.parseInt(hunk[4] || "1", 10),
        lines: []
      };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const text = line.slice(1);
      current.lines.push({ line_type: "added", new_line: newLine, text, text_hash: lineHash(filePath, text) });
      newLine += 1;
      linesAdded += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      const text = line.slice(1);
      current.lines.push({ line_type: "removed", old_line: oldLine, text, text_hash: lineHash(filePath, text) });
      oldLine += 1;
      linesDeleted += 1;
    } else if (line.startsWith(" ")) {
      const text = line.slice(1);
      current.lines.push({ line_type: "context", old_line: oldLine, new_line: newLine, text, text_hash: lineHash(filePath, text) });
      oldLine += 1;
      newLine += 1;
    }
  }
  return { hunks, linesAdded, linesDeleted };
}

async function unifiedDiff(before: Buffer, after: Buffer, filePath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-bash-diff-"));
  const beforePath = join(dir, "before");
  const afterPath = join(dir, "after");
  try {
    await writeFile(beforePath, before);
    await writeFile(afterPath, after);
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--no-index", "--no-color", "--unified=3", "--", beforePath, afterPath], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 200,
        timeout: 30000
      });
      return String(stdout || "");
    } catch (error) {
      const err = error as { stdout?: unknown; code?: unknown };
      if (err.code === 1) return String(err.stdout || "");
      throw error;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function fileChange(workspacePath: string, filePath: string, before: SnapshotFile | undefined) {
  const after = await snapshotFile(workspacePath, filePath);
  if (before?.kind === "directory" || after.kind === "directory") return undefined;
  const beforeBuffer = before
    ? snapshotContent(before) ?? Buffer.alloc(0)
    : await headFile(workspacePath, filePath) ?? Buffer.alloc(0);
  const afterBuffer = snapshotContent(after) ?? Buffer.alloc(0);
  const beforeHash = sha256(beforeBuffer);
  const afterHash = sha256(afterBuffer);
  if (beforeHash === afterHash) return undefined;
  const binary = isBinary(beforeBuffer) || isBinary(afterBuffer);
  if (binary) {
    return {
      file_path: filePath,
      binary: true,
      before_hash: beforeHash,
      after_hash: afterHash,
      before_size_bytes: beforeBuffer.length,
      after_size_bytes: afterBuffer.length,
      lines_added: 0,
      lines_deleted: 0,
      hunks: []
    };
  }
  const diffRaw = await unifiedDiff(beforeBuffer, afterBuffer, filePath);
  const parsed = parseUnifiedDiff(diffRaw, filePath);
  return {
    file_path: filePath,
    before_hash: beforeHash,
    after_hash: afterHash,
    before_size_bytes: beforeBuffer.length,
    after_size_bytes: afterBuffer.length,
    lines_added: parsed.linesAdded,
    lines_deleted: parsed.linesDeleted,
    hunks: parsed.hunks
  };
}

export async function buildClaudeBashDeltaPayload(
  workspacePath: string,
  before: ClaudeBashSnapshot,
  options: ClaudeBashDeltaOptions
): Promise<Record<string, any> | undefined> {
  const beforeByPath = new Map(before.files.map((file) => [file.file_path, file]));
  const paths = candidatePaths(workspacePath, options.command, [...before.file_paths, ...(await dirtyFiles(workspacePath))]);
  const files = (await Promise.all(paths.map((filePath) => fileChange(workspacePath, filePath, beforeByPath.get(filePath))))).filter(Boolean) as any[];
  if (files.length === 0) return undefined;
  const linesAdded = files.reduce((sum, file) => sum + Number(file.lines_added || 0), 0);
  const linesDeleted = files.reduce((sum, file) => sum + Number(file.lines_deleted || 0), 0);
  const diffRaw = files
    .map((file) => {
      const lines = (file.hunks || []).flatMap((hunk: any) => (hunk.lines || []).map((line: any) => `${line.line_type === "added" ? "+" : line.line_type === "removed" ? "-" : " "}${line.text}`));
      return [`diff --git a/${file.file_path} b/${file.file_path}`, ...lines].join("\n");
    })
    .join("\n");
  return {
    snapshot_kind: "claude_turn_bash_delta",
    trigger: "claude_code_bash_post_tool_use",
    attribution_scope: "tool_call_delta",
    ai_assisted: true,
    attribution_evidence: "claude_bash_pre_post_file_delta",
    capture_strategy: "bash_pre_post_delta_v1",
    session_id: options.sessionId,
    request_id: options.requestId,
    response_id: options.responseId,
    turn_index: options.turnIndex,
    tool_call_id: options.toolCallId || before.tool_call_id,
    command_hash: commandHash(options.command),
    baseline_captured_at: before.captured_at,
    after_captured_at: options.occurredAt || new Date().toISOString(),
    files_changed: files.length,
    lines_added: linesAdded,
    lines_deleted: linesDeleted,
    file_paths: files.map((file) => file.file_path),
    files,
    diff_raw: diffRaw,
    include_text: true,
    line_detail_policy: "inline_or_blob",
    cwd: workspacePath,
    capture_note: "Command-level Bash file delta captured by comparing Claude PreToolUse and PostToolUse snapshots."
  };
}

export async function writeClaudeBashSnapshot(path: string, snapshot: ClaudeBashSnapshot): Promise<void> {
  await mkdirp(dirname(path));
  await writeFile(path, `${JSON.stringify(snapshot)}\n`, "utf8");
}

export async function readClaudeBashSnapshot(path: string): Promise<ClaudeBashSnapshot | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed?.schema_version === "claude.bash_snapshot.v1" ? parsed as ClaudeBashSnapshot : undefined;
  } catch {
    return undefined;
  }
}

async function mkdirp(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
