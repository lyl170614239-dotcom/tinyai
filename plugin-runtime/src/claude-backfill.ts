import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { captureLatestClaudeTurnSnapshots, type ClaudeTurnSnapshot } from "./claude-turn.js";
import { CollectorClient, uploadResultAllowsCursorCommit, type CollectorClientOptions } from "./client.js";
import { makeEvent, stableEventId, type ObservabilityEvent } from "./event-schema.js";

export type ClaudeTurnCursorRecord = {
  file_path: string;
  read_offset: number;
  file_size: number;
  session_id?: string;
  updated_at: string;
};

export type ClaudeBackfillResult = {
  scanned_files: number;
  candidate_files: number;
  uploaded_events: number;
  committed_files: number;
  queued: boolean;
  skipped_incomplete: number;
  initialized_at_eof: number;
};

export type ClaudeBackfillOptions = {
  workspacePath: string;
  includeText?: boolean;
  recentMinutes?: number;
  maxFiles?: number;
  sessionFile?: string;
  sessionId?: string;
  cursorDir?: string;
  initializeUnseenFilesAtEof?: boolean;
  collectorOptions?: CollectorClientOptions;
  client?: Pick<CollectorClient, "upload">;
};

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function cursorStorePath(cursorDir?: string): string {
  return join(cursorDir || process.env.TINYAI_OBS_CURSOR_DIR || join(homedir(), ".tinyai-observability", "cursors"), "claude-turn-cursors.json");
}

async function loadClaudeTurnCursorStore(cursorDir?: string): Promise<Record<string, ClaudeTurnCursorRecord>> {
  try {
    const parsed = JSON.parse(await readFile(cursorStorePath(cursorDir), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, ClaudeTurnCursorRecord> : {};
  } catch {
    return {};
  }
}

async function saveClaudeTurnCursorStore(store: Record<string, ClaudeTurnCursorRecord>, cursorDir?: string): Promise<void> {
  const target = cursorStorePath(cursorDir);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

function claudeTurnCursorKey(filePath: string): string {
  return stableEventId(`claude-turn-cursor:${filePath}`);
}

export async function startOffsetForClaudeTurnFile(
  filePath: string,
  sessionId?: string,
  options: { initializeAtEof?: boolean; cursorDir?: string } = {}
): Promise<{ startOffset: number; initializedAtEof: boolean }> {
  const st = await stat(filePath);
  const store = await loadClaudeTurnCursorStore(options.cursorDir);
  const key = claudeTurnCursorKey(filePath);
  const existing = store[key];
  if (!existing) {
    if (options.initializeAtEof === false) {
      return { startOffset: 0, initializedAtEof: false };
    }
    store[key] = {
      file_path: filePath,
      read_offset: st.size,
      file_size: st.size,
      session_id: sessionId,
      updated_at: new Date().toISOString()
    };
    await saveClaudeTurnCursorStore(store, options.cursorDir);
    return { startOffset: st.size, initializedAtEof: true };
  }
  return { startOffset: Math.max(0, Math.min(existing.read_offset, st.size)), initializedAtEof: false };
}

export async function commitClaudeTurnCursor(filePath: string, nextOffset: number, sessionId?: string, cursorDir?: string): Promise<void> {
  const st = await stat(filePath);
  const store = await loadClaudeTurnCursorStore(cursorDir);
  const key = claudeTurnCursorKey(filePath);
  const existing = store[key];
  if (existing && existing.read_offset > nextOffset) return;
  store[key] = {
    file_path: filePath,
    read_offset: Math.max(0, Math.min(nextOffset, st.size)),
    file_size: st.size,
    session_id: sessionId || existing?.session_id,
    updated_at: new Date().toISOString()
  };
  await saveClaudeTurnCursorStore(store, cursorDir);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function snapshotNextOffset(snapshot: ClaudeTurnSnapshot): number | undefined {
  const sourceInfo = objectRecord((snapshot.source_files as Record<string, unknown> | undefined)?.claude_project_jsonl);
  const nextOffset = Number(sourceInfo?.next_offset);
  return Number.isFinite(nextOffset) && nextOffset >= 0 ? nextOffset : undefined;
}

function snapshotSourcePath(snapshot: ClaudeTurnSnapshot): string | undefined {
  const sourceInfo = objectRecord((snapshot.source_files as Record<string, unknown> | undefined)?.claude_project_jsonl);
  const rawPath = typeof sourceInfo?.path === "string" ? sourceInfo.path : undefined;
  if (!rawPath) return undefined;
  return rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : rawPath;
}

function claudeSnapshotCompletableCount(snapshots: ClaudeTurnSnapshot[]): number {
  return snapshots.filter((snapshot) => snapshot.turn.status !== "incomplete").length;
}

function claudeSnapshotMaxOffset(snapshots: ClaudeTurnSnapshot[]): number {
  return Math.max(0, ...snapshots.map((snapshot) => snapshotNextOffset(snapshot) || 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function captureClaudeTurnSnapshotsWithRetry(
  options: Parameters<typeof captureLatestClaudeTurnSnapshots>[0]
): Promise<ClaudeTurnSnapshot[]> {
  const delays = [0, 300, 1000];
  let best: ClaudeTurnSnapshot[] = [];
  let bestCount = -1;
  let bestOffset = -1;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    const snapshots = await captureLatestClaudeTurnSnapshots(options);
    const count = claudeSnapshotCompletableCount(snapshots);
    const offset = claudeSnapshotMaxOffset(snapshots);
    if (count > bestCount || (count === bestCount && offset > bestOffset)) {
      best = snapshots;
      bestCount = count;
      bestOffset = offset;
    }
  }
  return best;
}

async function walkRecentJsonl(root: string, cutoffMs: number, maxFiles: number): Promise<string[]> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const stack = [root];
  while (stack.length > 0 && files.length < maxFiles * 4) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "subagents") continue;
        stack.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const st = await stat(path);
        if (st.mtimeMs >= cutoffMs) files.push({ path, mtimeMs: st.mtimeMs });
      } catch {
        // Ignore files that disappear while Claude rotates them.
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles).map((file) => file.path);
}

export async function recentClaudeJsonlFiles(options: { sessionFile?: string; recentMinutes?: number; maxFiles?: number } = {}): Promise<string[]> {
  const recentMinutes = Number.isFinite(options.recentMinutes) && options.recentMinutes ? options.recentMinutes : 30;
  const maxFiles = Number.isFinite(options.maxFiles) && options.maxFiles ? options.maxFiles : 8;
  const cutoffMs = Date.now() - Math.max(1, recentMinutes) * 60_000;
  const ordered: string[] = [];
  if (options.sessionFile) ordered.push(options.sessionFile);
  for (const root of [join(homedir(), ".claude", "projects"), join(homedir(), ".claude", "transcripts")]) {
    ordered.push(...await walkRecentJsonl(root, cutoffMs, maxFiles));
  }
  return [...new Set(ordered)].slice(0, maxFiles);
}

export function claudeTurnEventsFromSnapshots(input: {
  snapshots: ClaudeTurnSnapshot[];
  workspacePath: string;
  taskId?: string;
  cursorStart?: { startOffset: number; initializedAtEof: boolean };
}): { events: ObservabilityEvent[]; commitOffset?: number; commitSessionId?: string; skippedIncomplete: number } {
  const events: ObservabilityEvent[] = [];
  let commitOffset: number | undefined;
  let commitSessionId: string | undefined;
  let skippedIncomplete = 0;
  for (const snapshot of input.snapshots) {
    if (snapshot.turn.status === "incomplete") {
      skippedIncomplete += 1;
      break;
    }
    const eventId = stableEventId(`claude:turn:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}`);
    events.push(
      makeEvent({
        tool: "claude",
        eventType: "turn_snapshot",
        taskId: input.taskId || snapshot.request_id,
        sessionId: snapshot.session_id,
        workspacePath: snapshot.cwd || input.workspacePath,
        payload: {
          ...snapshot,
          capture_cursor: input.cursorStart,
          capture_trigger: "claude_backfill"
        },
        sourceConfidence: "derived",
        eventId,
        model: snapshot.resolved_model || snapshot.model
      })
    );
    const nextOffset = snapshotNextOffset(snapshot);
    if (nextOffset !== undefined) {
      commitOffset = nextOffset;
      commitSessionId = snapshot.session_id;
    }
  }
  return { events, commitOffset, commitSessionId, skippedIncomplete };
}

export async function backfillRecentClaudeTurns(options: ClaudeBackfillOptions): Promise<ClaudeBackfillResult> {
  const enabled = boolEnv(process.env.TINYAI_OBS_CLAUDE_BACKFILL, true);
  if (!enabled) {
    return { scanned_files: 0, candidate_files: 0, uploaded_events: 0, committed_files: 0, queued: false, skipped_incomplete: 0, initialized_at_eof: 0 };
  }
  const files = await recentClaudeJsonlFiles({
    sessionFile: options.sessionFile,
    recentMinutes: options.recentMinutes,
    maxFiles: options.maxFiles
  });
  const client = options.client || new CollectorClient({ tool: "claude", workspacePath: options.workspacePath, ...options.collectorOptions });
  const initializeAtEof = options.initializeUnseenFilesAtEof !== false;
  let uploadedEvents = 0;
  let committedFiles = 0;
  let queued = false;
  let skippedIncomplete = 0;
  let initializedAtEof = 0;
  let scannedFiles = 0;
  for (const file of files) {
    const cursorStart = await startOffsetForClaudeTurnFile(file, options.sessionId, { initializeAtEof, cursorDir: options.cursorDir });
    if (cursorStart.initializedAtEof) {
      initializedAtEof += 1;
      continue;
    }
    const snapshots = await captureClaudeTurnSnapshotsWithRetry({
      includeText: options.includeText,
      sessionId: options.sessionId,
      workspacePath: options.workspacePath,
      sessionFile: file,
      latestOnly: false,
      startOffset: cursorStart.startOffset
    });
    scannedFiles += 1;
    const built = claudeTurnEventsFromSnapshots({
      snapshots,
      workspacePath: options.workspacePath,
      cursorStart
    });
    skippedIncomplete += built.skippedIncomplete;
    if (built.events.length === 0) continue;
    const result = await client.upload("claude", built.events);
    queued = queued || result.queued === true;
    uploadedEvents += built.events.length;
    const sourcePath = built.events.length > 0 ? snapshotSourcePath(snapshots[built.events.length - 1]) || file : file;
    if (built.commitOffset !== undefined && uploadResultAllowsCursorCommit(result)) {
      await commitClaudeTurnCursor(sourcePath, built.commitOffset, built.commitSessionId, options.cursorDir);
      committedFiles += 1;
    }
  }
  return {
    scanned_files: scannedFiles,
    candidate_files: files.length,
    uploaded_events: uploadedEvents,
    committed_files: committedFiles,
    queued,
    skipped_incomplete: skippedIncomplete,
    initialized_at_eof: initializedAtEof
  };
}
