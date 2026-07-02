import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import type { ToolName } from "./event-schema.js";

type CapturedMessage = {
  role: string;
  text_len: number;
  text_hash: string;
  text?: string;
  message_id?: string;
  occurred_at?: string;
  sequence?: number;
  turn_index?: number;
  request_id?: string;
  response_id?: string;
};

type CapturedProcessStep = {
  step_id?: string;
  kind: string;
  text_len: number;
  text_hash: string;
  text?: string;
  label?: string;
  tool_name?: string;
  status?: string;
  occurred_at?: string;
  sequence?: number;
  turn_index?: number;
  request_id?: string;
  response_id?: string;
};

type FileReadRecord = {
  path: string;
  line_start?: number;
  line_end?: number;
  occurred_at?: string;
  sequence?: number;
};

type HunkLine = {
  line_type: "added" | "removed" | "context";
  old_line?: number;
  new_line?: number;
  text: string;
  text_hash: string;
};

type CodeEditHunk = {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: HunkLine[];
};

type CodeEditRecord = {
  file_path: string;
  lines_added: number;
  lines_deleted: number;
  line_number_basis?: "absolute" | "relative";
  hunks: CodeEditHunk[];
  occurred_at?: string;
  sequence?: number;
  turn_index?: number;
  request_id?: string;
  response_id?: string;
};

type CapturedTurnEvent = {
  kind: "task_started" | "task_complete" | "turn_aborted";
  occurred_at?: string;
  sequence: number;
  turn_id?: string;
  duration_ms?: number;
  time_to_first_token_ms?: number;
};

type CapturedTokenUsageEvent = {
  sequence: number;
  occurred_at?: string;
  prompt_tokens?: number;
  output_tokens?: number;
};

type CapturedModelEvent = {
  sequence: number;
  model: string;
};

type CapturedRequestUsage = {
  request_id: string;
  response_id?: string;
  request_index: number;
  turn_index?: number;
  model?: string;
  prompt_tokens?: number;
  output_tokens?: number;
  completion_tokens?: number;
  elapsed_ms?: number;
  copilot_credits?: number;
  occurred_at?: string;
};

type CapturedUsageTotals = {
  prompt_tokens: number;
  output_tokens: number;
  completion_tokens: number;
  elapsed_ms: number;
  copilot_credits: number;
};

type CaptureCursorMetadata = {
  tool: "codex" | "claude";
  key: string;
  file_path: string;
  previous_offset: number;
  next_offset: number;
  file_size: number;
  line_count: number;
  initialized_at_eof?: boolean;
};

export interface ConversationSnapshot {
  session_id?: string;
  session_file: string;
  cwd?: string;
  source?: string;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  user_followup_count: number;
  turn_started_count: number;
  turn_completed_count: number;
  turn_aborted_count: number;
  task_repeat_attempts: number;
  tool_call_count: number;
  tool_result_count: number;
  patch_apply_count: number;
  patch_success_count: number;
  include_text: boolean;
  messages: CapturedMessage[];
  process_steps?: CapturedProcessStep[];
  file_reads?: FileReadRecord[];
  code_edits?: CodeEditRecord[];
  turn_events?: CapturedTurnEvent[];
  request_usage?: CapturedRequestUsage[];
  usage_totals?: CapturedUsageTotals;
  model?: string;
  resolved_model?: string;
  latest_turn_complete?: boolean;
  latest_turn_aborted?: boolean;
  latest_turn_terminal?: boolean;
  turn_index_offset?: number;
  capture_cursor?: CaptureCursorMetadata;
}

async function walkJsonl(root: string, maxFiles = 500): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  await visit(root);
  return files;
}

async function latestSessionFile(): Promise<string | undefined> {
  const root = join(homedir(), ".codex", "sessions");
  const files = await walkJsonl(root);
  return latestFile(files);
}

async function latestClaudeTranscriptFile(): Promise<string | undefined> {
  const roots = [join(homedir(), ".claude", "transcripts"), join(homedir(), ".claude", "projects")];
  const files = (await Promise.all(roots.map((root) => walkJsonl(root)))).flat();
  return latestFile(files);
}

function cleanExistingFile(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return raw.trim().replace(/^file:\/\//, "");
}

async function latestFile(files: string[]): Promise<string | undefined> {
  let latest: { file: string; mtimeMs: number } | undefined;
  for (const file of files) {
    const info = await stat(file).catch(() => undefined);
    if (!info) continue;
    if (!latest || info.mtimeMs > latest.mtimeMs) latest = { file, mtimeMs: info.mtimeMs };
  }
  return latest?.file;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const value = (part as any).text || (part as any).input_text || (part as any).output_text;
    if (typeof value === "string") chunks.push(value);
  }
  return chunks.join("\n");
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function codexEventMessageId(role: string, text: string, occurredAt: string | undefined, sequence: number): string {
  return `event_msg:${role}:${occurredAt || sequence}:${hashText(text)}`;
}

type ConversationCursorRecord = {
  file_path: string;
  file_size: number;
  read_offset: number;
  updated_at: string;
  session_id?: string;
  cwd?: string;
  source?: string;
  user_message_count?: number;
};

type ConversationCursorStore = Record<string, ConversationCursorRecord>;

const JSONL_READ_CHUNK_BYTES = 1024 * 1024;

function cursorStoreDir(): string {
  const configured = cleanString(process.env.TINYAI_OBS_CURSOR_DIR);
  return configured || join(homedir(), ".tinyai-observability", "cursors");
}

function cursorStorePath(tool: "codex" | "claude"): string {
  return join(cursorStoreDir(), `${tool}-conversation-cursors.json`);
}

function cursorKey(filePath: string): string {
  return hashText(filePath);
}

async function loadCursorStore(tool: "codex" | "claude"): Promise<ConversationCursorStore> {
  try {
    const raw = await readFile(cursorStorePath(tool), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ConversationCursorStore : {};
  } catch {
    return {};
  }
}

async function saveCursorStore(tool: "codex" | "claude", store: ConversationCursorStore): Promise<void> {
  const dir = cursorStoreDir();
  await mkdir(dir, { recursive: true });
  const target = cursorStorePath(tool);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

function fallbackSessionIdFromFile(filePath: string): string {
  const name = basename(filePath, ".jsonl");
  const rolloutMatch = name.match(/(?:^|[-_])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return rolloutMatch?.[1] || name;
}

function canonicalSessionIdForFile(sessionId: string | undefined, filePath: string): string {
  const fileSessionId = fallbackSessionIdFromFile(filePath);
  if (!sessionId) return fileSessionId;
  if (sessionId.startsWith("rollout-") && fileSessionId !== sessionId) return fileSessionId;
  return sessionId;
}

function jsonlPayloadType(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line);
    const payload = parsed?.payload;
    return payload && typeof payload === "object" && typeof payload.type === "string" ? payload.type : undefined;
  } catch {
    return undefined;
  }
}

function codexLinesContainPayloadType(lines: string[], type: string): boolean {
  return lines.some((line) => jsonlPayloadType(line) === type);
}

function countCodexRealUserMessages(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const payload = entry?.payload;
      if (
        entry?.type === "event_msg" &&
        payload?.type === "user_message" &&
        typeof payload.message === "string" &&
        payload.message.trim()
      ) {
        count += 1;
      }
    } catch {
      // Ignore partial or malformed historical lines.
    }
  }
  return count;
}

async function readCompleteJsonlLines(filePath: string, offset: number, fileSize: number): Promise<{ lines: string[]; nextOffset: number }> {
  if (offset >= fileSize) return { lines: [], nextOffset: offset };
  const handle = await open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let position = offset;
    while (position < fileSize) {
      const length = Math.min(JSONL_READ_CHUNK_BYTES, fileSize - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const lastNewline = raw.lastIndexOf("\n");
    if (lastNewline < 0) return { lines: [], nextOffset: offset };
    const completeText = raw.slice(0, lastNewline + 1);
    const nextOffset = offset + Buffer.byteLength(completeText, "utf8");
    return { lines: completeText.split(/\r?\n/).filter(Boolean), nextOffset };
  } finally {
    await handle.close();
  }
}

async function readIncrementalJsonlLines(
  tool: "codex" | "claude",
  filePath: string,
  options: { bootstrapAtEof?: boolean } = {}
): Promise<{ lines: string[]; cursor: CaptureCursorMetadata; state?: ConversationCursorRecord }> {
  const info = await stat(filePath);
  const store = await loadCursorStore(tool);
  const key = cursorKey(filePath);
  const state = store[key];

  if (!state && options.bootstrapAtEof) {
    const now = new Date().toISOString();
    store[key] = {
      file_path: filePath,
      file_size: info.size,
      read_offset: info.size,
      updated_at: now,
      session_id: canonicalSessionIdForFile(undefined, filePath)
    };
    await saveCursorStore(tool, store);
    return {
      lines: [],
      state: store[key],
      cursor: {
        tool,
        key,
        file_path: filePath,
        previous_offset: info.size,
        next_offset: info.size,
        file_size: info.size,
        line_count: 0,
        initialized_at_eof: true
      }
    };
  }

  const previousOffset = Math.max(0, Math.min(state?.read_offset ?? 0, info.size));
  const { lines, nextOffset } = await readCompleteJsonlLines(filePath, previousOffset, info.size);
  return {
    lines,
    state,
    cursor: {
      tool,
      key,
      file_path: filePath,
      previous_offset: previousOffset,
      next_offset: nextOffset,
      file_size: info.size,
      line_count: lines.length
    }
  };
}

async function codexTurnIndexOffset(
  filePath: string,
  cursor: CaptureCursorMetadata,
  state?: ConversationCursorRecord
): Promise<number> {
  if (cursor.previous_offset <= 0) return 0;
  if (
    state?.read_offset === cursor.previous_offset &&
    typeof state.user_message_count === "number" &&
    Number.isFinite(state.user_message_count) &&
    state.user_message_count >= 0
  ) {
    return state.user_message_count;
  }
  const prefix = await readCompleteJsonlLines(filePath, 0, cursor.previous_offset);
  return countCodexRealUserMessages(prefix.lines);
}

function snapshotMaxTurnIndex(snapshot: ConversationSnapshot): number | undefined {
  const candidates = [
    ...(snapshot.messages || []),
    ...(snapshot.process_steps || []),
    ...(snapshot.code_edits || []),
    ...(snapshot.request_usage || [])
  ].flatMap((item) => {
    const value = item.turn_index;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? [value] : [];
  });
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

export async function commitConversationCursor(snapshot: ConversationSnapshot): Promise<boolean> {
  const cursor = snapshot.capture_cursor;
  if (!cursor) return false;
  const store = await loadCursorStore(cursor.tool);
  const existing = store[cursor.key];
  if (existing && existing.read_offset > cursor.next_offset) return false;
  const previousUserMessageCount =
    existing?.read_offset === cursor.previous_offset &&
    typeof existing.user_message_count === "number" &&
    Number.isFinite(existing.user_message_count)
      ? existing.user_message_count
      : snapshot.turn_index_offset || 0;
  const observedUserMessageCount =
    snapshotMaxTurnIndex(snapshot) || previousUserMessageCount + snapshot.user_message_count;
  store[cursor.key] = {
    file_path: cursor.file_path,
    file_size: cursor.file_size,
    read_offset: cursor.next_offset,
    updated_at: new Date().toISOString(),
    session_id: canonicalSessionIdForFile(snapshot.session_id || existing?.session_id, cursor.file_path),
    cwd: snapshot.cwd || existing?.cwd,
    source: snapshot.source || existing?.source,
    user_message_count: Math.max(previousUserMessageCount, observedUserMessageCount)
  };
  await saveCursorStore(cursor.tool, store);
  return true;
}

function emptyConversationSnapshot(input: {
  tool: "codex" | "claude";
  file: string;
  includeText: boolean;
  sessionId?: string;
  cursor: CaptureCursorMetadata;
  source?: string;
}): ConversationSnapshot {
  return {
    session_id: canonicalSessionIdForFile(input.sessionId, input.file),
    session_file: input.file.replace(homedir(), "~"),
    source: input.source,
    message_count: 0,
    user_message_count: 0,
    assistant_message_count: 0,
    user_followup_count: 0,
    turn_started_count: 0,
    turn_completed_count: 0,
    turn_aborted_count: 0,
    task_repeat_attempts: 0,
    tool_call_count: 0,
    tool_result_count: 0,
    patch_apply_count: 0,
    patch_success_count: 0,
    include_text: input.includeText,
    messages: [],
    latest_turn_complete: false,
    capture_cursor: input.cursor
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim();
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const READ_TOOLS = /^(read|Read|view|View|cat|open|Open|get|show|Show|display|list|List|search_content|search_file|search_files|codebase_search|grep|Grep|glob|Glob|find_files|read_file|read_lints|read_lints)$/;
const EDIT_TOOLS = /^(write|Write|edit|Edit|replace|Replace|patch|Patch|apply_patch|create|Create|update|Update|delete|Delete|remove|Remove|rename|Rename|write_to_file|replace_in_file|edit_file)$/;
const SENSITIVE_PATH_RE = /(^|\/)\.env(?:\.|$)|(^|\/)(\.?npmrc|\.?pypirc|\.?netrc|id_rsa|id_ed25519)$|(secret|secrets|credential|credentials|token|private-key|private_key)/i;

function normalizeToolName(raw: unknown): string {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return "unknown_tool";
}

function isReadTool(name: string): boolean {
  return READ_TOOLS.test(name);
}

function isEditTool(name: string): boolean {
  return EDIT_TOOLS.test(name);
}

function cleanFilePath(raw: string): string | undefined {
  let candidate = raw.trim();
  candidate = candidate.replace(/^file:\/\//, "").replace(/^[`"'[(<\s]+/, "").replace(/[`"'\])>,.;:\s]+$/, "");
  if (!candidate || candidate.length > 500) return undefined;
  if (/^(https?:|data:)/i.test(candidate)) return undefined;
  return candidate;
}

function extractFileReads(
  toolName: string,
  input: Record<string, unknown>,
  output: Map<string, FileReadRecord>,
  sequence?: number,
  occurredAt?: string
): void {
  if (!isReadTool(toolName)) return;
  for (const key of ["filePath", "file_path", "path", "file", "target", "target_directory", "directory"]) {
    const value = input[key];
    if (typeof value === "string") {
      const cleaned = cleanFilePath(value);
      if (cleaned) {
        const lineStart = typeof input.line === "number" ? input.line : typeof input.startLine === "number" ? input.startLine : typeof input.offset === "number" ? input.offset : undefined;
        const lineEnd = typeof input.endLine === "number" ? input.endLine : undefined;
        const pathOnlyKey = `${cleaned}::`;
        const readKey = `${cleaned}:${lineStart || ""}:${lineEnd || ""}`;
        if (lineStart !== undefined || lineEnd !== undefined) {
          output.delete(pathOnlyKey);
        } else if ([...output.keys()].some((existingKey) => existingKey.startsWith(`${cleaned}:`) && existingKey !== pathOnlyKey)) {
          continue;
        }
        output.set(readKey, {
          path: cleaned,
          line_start: lineStart,
          line_end: lineEnd,
          sequence,
          occurred_at: occurredAt
        });
      }
    }
  }
}

function parseApplyPatchEdits(patchText: string): CodeEditRecord[] {
  if (!patchText.includes("*** Begin Patch")) return [];

  const edits: CodeEditRecord[] = [];
  let current: CodeEditRecord | undefined;
  let oldLine = 1;
  let newLine = 1;

  const finish = () => {
    if (!current) return;
    current.hunks = current.hunks.filter((hunk) => hunk.lines.length > 0);
    if (current.hunks.length > 0) edits.push(current);
    current = undefined;
  };

  for (const rawLine of patchText.split(/\r?\n/)) {
    const fileMatch = rawLine.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (fileMatch) {
      finish();
      const cleaned = cleanFilePath(fileMatch[2]);
      if (!cleaned) continue;
      current = {
        file_path: cleaned,
        lines_added: 0,
        lines_deleted: 0,
        line_number_basis: fileMatch[1] === "Add" ? "absolute" : "relative",
        hunks: []
      };
      oldLine = 1;
      newLine = 1;
      continue;
    }
    if (!current) continue;

    if (rawLine.startsWith("@@")) {
      const hunkMatch = rawLine.match(/^@@(?:\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?)?/);
      if (hunkMatch?.[1]) {
        oldLine = Number(hunkMatch[1]);
        newLine = Number(hunkMatch[2] || 1);
        current.line_number_basis = "absolute";
      } else if (current.line_number_basis !== "absolute") {
        current.line_number_basis = "relative";
      }
      current.hunks.push({
        old_start: oldLine,
        old_lines: 0,
        new_start: newLine,
        new_lines: 0,
        lines: []
      });
      continue;
    }

    if (current.hunks.length === 0) {
      current.hunks.push({
        old_start: oldLine,
        old_lines: 0,
        new_start: newLine,
        new_lines: 0,
        lines: []
      });
    }
    const hunk = current.hunks[current.hunks.length - 1];
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      const text = rawLine.slice(1);
      hunk.lines.push({ line_type: "added", new_line: newLine, text, text_hash: hashText(`${current.file_path}\0${text}`) });
      hunk.new_lines += 1;
      current.lines_added += 1;
      newLine += 1;
    } else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      const text = rawLine.slice(1);
      hunk.lines.push({ line_type: "removed", old_line: oldLine, text, text_hash: hashText(`${current.file_path}\0${text}`) });
      hunk.old_lines += 1;
      current.lines_deleted += 1;
      oldLine += 1;
    } else if (rawLine.startsWith(" ")) {
      const text = rawLine.slice(1);
      hunk.lines.push({ line_type: "context", old_line: oldLine, new_line: newLine, text, text_hash: hashText(`${current.file_path}\0${text}`) });
      hunk.old_lines += 1;
      hunk.new_lines += 1;
      oldLine += 1;
      newLine += 1;
    }
  }

  finish();
  return edits;
}

function toolInputRecord(input: unknown): Record<string, unknown> {
  if (typeof input === "string") return { input };
  if (typeof input === "object" && input !== null) return input as Record<string, unknown>;
  return {};
}

function extractCodeEdits(toolName: string, input: Record<string, unknown>, _includeText: boolean): CodeEditRecord[] {
  if (!isEditTool(toolName)) return [];
  const patchText = input.input || input.patch || input.diff;
  if (typeof patchText === "string" && patchText.includes("*** Begin Patch")) {
    return parseApplyPatchEdits(patchText);
  }

  const filePath = input.filePath || input.file_path || input.path || input.file;
  const oldStr = input.oldString || input.old_str || input.oldString || "";
  const newStr = input.newString || input.new_str || input.newString || input.content || input.text || "";
  if (typeof filePath !== "string" || (!oldStr && !newStr)) return [];

  const cleaned = cleanFilePath(filePath);
  if (!cleaned) return [];

  const oldLines = typeof oldStr === "string" ? oldStr.split(/\r?\n/) : [];
  const newLines = typeof newStr === "string" ? newStr.split(/\r?\n/) : [];
  if (oldLines.at(-1) === "") oldLines.pop();
  if (newLines.at(-1) === "") newLines.pop();

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix + prefix < oldLines.length && suffix + prefix < newLines.length && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;

  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  if (removed.length === 0 && added.length === 0) return [];

  const hunkLines: HunkLine[] = [];
  removed.forEach((line, i) => {
    hunkLines.push({ line_type: "removed", old_line: prefix + i + 1, text: line, text_hash: hashText(`${cleaned}\0${line}`) });
  });
  added.forEach((line, i) => {
    hunkLines.push({ line_type: "added", new_line: prefix + i + 1, text: line, text_hash: hashText(`${cleaned}\0${line}`) });
  });

  return [{
    file_path: cleaned,
    lines_added: added.length,
    lines_deleted: removed.length,
    line_number_basis: "relative",
    hunks: [{ old_start: prefix + 1, old_lines: removed.length, new_start: prefix + 1, new_lines: added.length, lines: hunkLines }]
  }];
}

function splitFileContentLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function findLineSequence(haystack: string[], needle: string[], startIndex: number): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  for (let index = Math.max(0, startIndex); index <= haystack.length - needle.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
}

function codeEditFilePath(cwd: string | undefined, filePath: string): string | undefined {
  if (!cwd || !filePath || filePath.includes("\0")) return undefined;
  const cleaned = filePath.replace(/^file:\/\//, "");
  return isAbsolute(cleaned) ? cleaned : join(cwd, cleaned);
}

async function resolveRelativeCodeEditLines(edits: CodeEditRecord[], cwd: string | undefined): Promise<CodeEditRecord[]> {
  if (!cwd || edits.length === 0) return edits;
  const cache = new Map<string, string[] | undefined>();

  async function fileLines(filePath: string): Promise<string[] | undefined> {
    const absolutePath = codeEditFilePath(cwd, filePath);
    if (!absolutePath) return undefined;
    if (cache.has(absolutePath)) return cache.get(absolutePath);
    try {
      const lines = splitFileContentLines(await readFile(absolutePath, "utf8"));
      cache.set(absolutePath, lines);
      return lines;
    } catch {
      cache.set(absolutePath, undefined);
      return undefined;
    }
  }

  const resolved: CodeEditRecord[] = [];
  for (const edit of edits) {
    if (edit.line_number_basis === "absolute") {
      resolved.push(edit);
      continue;
    }
    const lines = await fileLines(edit.file_path);
    if (!lines) {
      resolved.push(edit);
      continue;
    }

    let searchFrom = 0;
    let allHunksResolved = edit.hunks.length > 0;
    const hunks: CodeEditHunk[] = [];
    for (const hunk of edit.hunks) {
      const postPatchTexts = hunk.lines.filter((line) => line.line_type !== "removed").map((line) => line.text);
      const matchIndex = findLineSequence(lines, postPatchTexts, searchFrom);
      if (matchIndex < 0) {
        allHunksResolved = false;
        break;
      }
      const startLine = matchIndex + 1;
      const onlyAdded = hunk.lines.every((line) => line.line_type === "added");
      let nextOldLine = onlyAdded ? Math.max(0, startLine - 1) : startLine;
      let nextNewLine = startLine;
      const resolvedHunkLines = hunk.lines.map((line) => {
        if (line.line_type === "removed") {
          const resolvedLine = { ...line, old_line: nextOldLine };
          nextOldLine += 1;
          return resolvedLine;
        }
        if (line.line_type === "added") {
          const resolvedLine = { ...line, new_line: nextNewLine };
          nextNewLine += 1;
          return resolvedLine;
        }
        const resolvedLine = { ...line, old_line: nextOldLine, new_line: nextNewLine };
        nextOldLine += 1;
        nextNewLine += 1;
        return resolvedLine;
      });
      hunks.push({
        ...hunk,
        old_start: onlyAdded ? Math.max(0, startLine - 1) : startLine,
        new_start: startLine,
        lines: resolvedHunkLines
      });
      searchFrom = matchIndex + Math.max(postPatchTexts.length, 1);
    }

    resolved.push(allHunksResolved ? { ...edit, line_number_basis: "absolute", hunks } : edit);
  }
  return resolved;
}

function dedupeProcessSteps(steps: CapturedProcessStep[]): CapturedProcessStep[] {
  const seen = new Set<string>();
  return steps.flatMap((step) => {
    const key = `${step.kind}:${step.text_hash}:${step.tool_name || ""}:${step.status || ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...step, step_id: hashText(key) }];
  });
}

function isSensitiveFilePath(filePath: string): boolean {
  return SENSITIVE_PATH_RE.test(filePath);
}

function processSignature(steps: CapturedProcessStep[]): string {
  return hashText(JSON.stringify(steps.map((s) => [s.kind, s.text_hash, s.tool_name || "", s.status || ""])));
}

function messageSignature(messages: CapturedMessage[]): string {
  return hashText(JSON.stringify(messages.map((m) => [m.role, m.text_hash])));
}

function codexTurnIds(sessionId: string | undefined, turnIndex: number, userMessage: CapturedMessage): { requestId: string; responseId: string } {
  const base = `${sessionId || "codex-session"}:${turnIndex}:${userMessage.message_id || userMessage.text_hash}`;
  const digest = hashText(base);
  return {
    requestId: `codex_request_${digest}`,
    responseId: `codex_response_${digest}`
  };
}

function buildCodexRequestUsage(input: {
  sessionId?: string;
  messages: CapturedMessage[];
  turnEvents: CapturedTurnEvent[];
  tokenUsageEvents: CapturedTokenUsageEvent[];
  modelEvents: CapturedModelEvent[];
  turnIndexOffset?: number;
}): { requestUsage: CapturedRequestUsage[]; usageTotals: CapturedUsageTotals; resolvedModel?: string } {
  const userMessages = input.messages.filter((message) => message.role === "user");
  const requestUsage: CapturedRequestUsage[] = [];

  userMessages.forEach((userMessage, index) => {
    const turnIndex = (input.turnIndexOffset || 0) + index + 1;
    const startSequence = typeof userMessage.sequence === "number" ? userMessage.sequence : 0;
    const nextUserSequence = userMessages[index + 1]?.sequence;
    const beforeNextTurn = (sequence: number) => nextUserSequence === undefined || sequence < nextUserSequence;
    const inTurn = (sequence: number) => sequence >= startSequence && beforeNextTurn(sequence);
    const tokenEvents = input.tokenUsageEvents.filter((event) => inTurn(event.sequence));
    const completeEvent = input.turnEvents.find((event) => event.kind === "task_complete" && inTurn(event.sequence));
    const modelEvent = [...input.modelEvents].reverse().find((event) => inTurn(event.sequence) || event.sequence <= startSequence);
    const promptTokens = tokenEvents.reduce((sum, event) => sum + (event.prompt_tokens || 0), 0);
    const outputTokens = tokenEvents.reduce((sum, event) => sum + (event.output_tokens || 0), 0);
    const elapsedMs = completeEvent?.duration_ms;
    const model = modelEvent?.model;

    if (!model && promptTokens <= 0 && outputTokens <= 0 && elapsedMs === undefined) return;

    const { requestId, responseId } = codexTurnIds(input.sessionId, turnIndex, userMessage);
    requestUsage.push({
      request_id: requestId,
      response_id: responseId,
      request_index: index,
      turn_index: turnIndex,
      model,
      ...(promptTokens > 0 ? { prompt_tokens: promptTokens } : {}),
      ...(outputTokens > 0 ? { output_tokens: outputTokens } : {}),
      ...(elapsedMs !== undefined ? { elapsed_ms: elapsedMs } : {}),
      occurred_at: completeEvent?.occurred_at || tokenEvents[tokenEvents.length - 1]?.occurred_at || userMessage.occurred_at
    });
  });

  const usageTotals = requestUsage.reduce<CapturedUsageTotals>(
    (totals, usage) => ({
      prompt_tokens: totals.prompt_tokens + (usage.prompt_tokens || 0),
      output_tokens: totals.output_tokens + (usage.output_tokens || 0),
      completion_tokens: totals.completion_tokens,
      elapsed_ms: totals.elapsed_ms + (usage.elapsed_ms || 0),
      copilot_credits: totals.copilot_credits
    }),
    { prompt_tokens: 0, output_tokens: 0, completion_tokens: 0, elapsed_ms: 0, copilot_credits: 0 }
  );
  const resolvedModel = [...requestUsage].reverse().find((usage) => usage.model)?.model;
  return { requestUsage, usageTotals, resolvedModel };
}

function codexLatestTurnComplete(messages: CapturedMessage[], turnEvents: CapturedTurnEvent[]): boolean {
  let lastUserSequence: number | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      lastUserSequence = message.sequence;
      break;
    }
  }
  if (lastUserSequence === undefined) return false;
  return turnEvents.some((event) => event.kind === "task_complete" && typeof event.sequence === "number" && event.sequence >= lastUserSequence);
}

function codexLatestTurnAborted(messages: CapturedMessage[], turnEvents: CapturedTurnEvent[]): boolean {
  let lastUserSequence: number | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      lastUserSequence = message.sequence;
      break;
    }
  }
  if (lastUserSequence === undefined) return false;
  return turnEvents.some((event) => event.kind === "turn_aborted" && typeof event.sequence === "number" && event.sequence >= lastUserSequence);
}

export function latestCodexTurnSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
  const messages = snapshot.messages || [];
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return { ...snapshot, latest_turn_complete: false, latest_turn_aborted: false, latest_turn_terminal: false };

  const localTurnIndex = messages.slice(0, lastUserIndex + 1).filter((message) => message.role === "user").length;
  const turnIndex = (snapshot.turn_index_offset || 0) + localTurnIndex;
  const userMessage = messages[lastUserIndex];
  const boundarySequence = typeof userMessage.sequence === "number" ? userMessage.sequence : undefined;
  const { requestId, responseId } = codexTurnIds(snapshot.session_id, turnIndex, userMessage);
  const inLatestTurn = (item: { sequence?: number }) => {
    if (boundarySequence === undefined) return true;
    return typeof item.sequence === "number" && item.sequence >= boundarySequence;
  };
  const rawLatestMessages = messages.slice(lastUserIndex);
  let finalAssistantOffset = -1;
  for (let index = rawLatestMessages.length - 1; index >= 0; index -= 1) {
    if (rawLatestMessages[index]?.role === "assistant") {
      finalAssistantOffset = index;
      break;
    }
  }
  const latestMessages = rawLatestMessages
    .filter((message, index) => message.role === "user" || index === finalAssistantOffset)
    .map((message) => ({
    ...message,
    turn_index: turnIndex,
    request_id: requestId,
    response_id: responseId
  }));
  const assistantProgressSteps = rawLatestMessages
    .filter((message, index) => message.role === "assistant" && index !== finalAssistantOffset)
    .map((message) => ({
      kind: "assistant_progress",
      text_len: message.text_len,
      text_hash: message.text_hash,
      text: message.text,
      label: "assistant_progress",
      status: "complete",
      occurred_at: message.occurred_at,
      sequence: message.sequence,
      turn_index: turnIndex,
      request_id: requestId,
      response_id: responseId,
      step_id: hashText(`assistant_progress:${message.message_id || message.text_hash}`)
    }));
  const latestSteps = (snapshot.process_steps || [])
    .filter(inLatestTurn)
    .map((step) => ({
      ...step,
      turn_index: turnIndex,
      request_id: requestId,
      response_id: responseId
    }));
  const combinedSteps = [...assistantProgressSteps, ...latestSteps];
  const latestReads = (snapshot.file_reads || []).filter(inLatestTurn);
  const latestEdits = (snapshot.code_edits || [])
    .filter(inLatestTurn)
    .map((edit) => ({
      ...edit,
      turn_index: turnIndex,
      request_id: requestId,
      response_id: responseId
    }));
  const latestTurnEvents = (snapshot.turn_events || []).filter(inLatestTurn);
  const latestRequestUsage = (snapshot.request_usage || [])
    .filter((usage) => usage.turn_index === turnIndex || usage.request_id === requestId)
    .map((usage) => ({
      ...usage,
      turn_index: turnIndex,
      request_id: requestId,
      response_id: responseId
    }));
  const latestUsageTotals = latestRequestUsage.reduce<CapturedUsageTotals>(
    (totals, usage) => ({
      prompt_tokens: totals.prompt_tokens + (usage.prompt_tokens || 0),
      output_tokens: totals.output_tokens + (usage.output_tokens || 0),
      completion_tokens: totals.completion_tokens + (usage.completion_tokens || 0),
      elapsed_ms: totals.elapsed_ms + (usage.elapsed_ms || 0),
      copilot_credits: totals.copilot_credits + (usage.copilot_credits || 0)
    }),
    { prompt_tokens: 0, output_tokens: 0, completion_tokens: 0, elapsed_ms: 0, copilot_credits: 0 }
  );
  const latestTurnComplete = latestTurnEvents.some((event) => event.kind === "task_complete");
  const latestTurnAborted = latestTurnEvents.some((event) => event.kind === "turn_aborted");
  const latestTurnTerminal = latestTurnComplete || latestTurnAborted;
  const userMessageCount = latestMessages.filter((message) => message.role === "user").length;
  const assistantMessageCount = latestMessages.filter((message) => message.role === "assistant").length;
  const toolCallCount = latestSteps.filter((step) => step.kind === "tool_call").length;
  const toolResultCount = latestSteps.filter((step) => step.kind === "tool_result").length;

  return {
    ...snapshot,
    message_count: latestMessages.length,
    user_message_count: userMessageCount,
    assistant_message_count: assistantMessageCount,
    user_followup_count: Math.max(userMessageCount - 1, 0),
    turn_started_count: userMessageCount > 0 ? 1 : 0,
    turn_completed_count: latestTurnComplete ? 1 : 0,
    turn_aborted_count: latestTurnAborted ? 1 : 0,
    task_repeat_attempts: 0,
    tool_call_count: toolCallCount,
    tool_result_count: toolResultCount,
    patch_apply_count: 0,
    patch_success_count: 0,
    messages: latestMessages,
    process_steps: combinedSteps.length > 0 ? combinedSteps : undefined,
    file_reads: latestReads.length > 0 ? latestReads : undefined,
    code_edits: latestEdits.length > 0 ? latestEdits : undefined,
    turn_events: latestTurnEvents.length > 0 ? latestTurnEvents : undefined,
    request_usage: latestRequestUsage.length > 0 ? latestRequestUsage : undefined,
    usage_totals: latestRequestUsage.length > 0 ? latestUsageTotals : undefined,
    model: latestRequestUsage.find((usage) => usage.model)?.model || snapshot.model,
    resolved_model: latestRequestUsage.find((usage) => usage.model)?.model || snapshot.resolved_model,
    latest_turn_complete: latestTurnComplete,
    latest_turn_aborted: latestTurnAborted,
    latest_turn_terminal: latestTurnTerminal
  };
}

export function codexTerminalTurnSnapshots(snapshot: ConversationSnapshot): ConversationSnapshot[] {
  const messages = snapshot.messages || [];
  const userEntries = messages
    .map((message, index) => ({ message, index }))
    .filter((entry) => entry.message.role === "user");
  if (userEntries.length === 0) return [];

  return userEntries.flatMap((entry, localIndex) => {
    const userMessage = entry.message;
    const startSequence = typeof userMessage.sequence === "number" ? userMessage.sequence : undefined;
    const nextUserEntry = userEntries[localIndex + 1];
    const nextUserSequence = typeof nextUserEntry?.message.sequence === "number" ? nextUserEntry.message.sequence : undefined;
    const inTurn = (item: { sequence?: number }) => {
      if (startSequence === undefined) return true;
      if (typeof item.sequence !== "number" || item.sequence < startSequence) return false;
      return nextUserSequence === undefined || item.sequence < nextUserSequence;
    };

    const turnEvents = (snapshot.turn_events || []).filter(inTurn);
    const completeEvent = turnEvents.find((event) => event.kind === "task_complete");
    const abortedEvent = turnEvents.find((event) => event.kind === "turn_aborted");
    if (!completeEvent && !abortedEvent) return [];

    const turnIndex = (snapshot.turn_index_offset || 0) + localIndex + 1;
    const { requestId, responseId } = codexTurnIds(snapshot.session_id, turnIndex, userMessage);
    const endIndex = nextUserEntry?.index ?? messages.length;
    const rawTurnMessages = messages.slice(entry.index, endIndex);
    let finalAssistantOffset = -1;
    for (let index = rawTurnMessages.length - 1; index >= 0; index -= 1) {
      if (rawTurnMessages[index]?.role === "assistant") {
        finalAssistantOffset = index;
        break;
      }
    }

    const turnMessages = rawTurnMessages
      .filter((message, index) => message.role === "user" || index === finalAssistantOffset)
      .map((message) => ({
        ...message,
        turn_index: turnIndex,
        request_id: requestId,
        response_id: responseId
      }));
    const assistantProgressSteps = rawTurnMessages
      .filter((message, index) => message.role === "assistant" && index !== finalAssistantOffset)
      .map((message) => ({
        kind: "assistant_progress",
        text_len: message.text_len,
        text_hash: message.text_hash,
        text: message.text,
        label: "assistant_progress",
        status: "complete",
        occurred_at: message.occurred_at,
        sequence: message.sequence,
        turn_index: turnIndex,
        request_id: requestId,
        response_id: responseId,
        step_id: hashText(`assistant_progress:${message.message_id || message.text_hash}`)
      }));
    const turnSteps = (snapshot.process_steps || [])
      .filter(inTurn)
      .map((step) => ({
        ...step,
        turn_index: turnIndex,
        request_id: step.request_id || requestId,
        response_id: step.response_id || responseId
      }));
    const processSteps = [...assistantProgressSteps, ...turnSteps];
    const fileReads = (snapshot.file_reads || []).filter(inTurn);
    const codeEdits = (snapshot.code_edits || [])
      .filter(inTurn)
      .map((edit) => ({
        ...edit,
        turn_index: turnIndex,
        request_id: edit.request_id || requestId,
        response_id: edit.response_id || responseId
      }));
    const requestUsage = (snapshot.request_usage || [])
      .filter((usage) => usage.turn_index === turnIndex)
      .map((usage) => ({
        ...usage,
        turn_index: turnIndex,
        request_id: usage.request_id || requestId,
        response_id: usage.response_id || responseId
      }));
    const usageTotals = requestUsage.reduce<CapturedUsageTotals>(
      (totals, usage) => ({
        prompt_tokens: totals.prompt_tokens + (usage.prompt_tokens || 0),
        output_tokens: totals.output_tokens + (usage.output_tokens || 0),
        completion_tokens: totals.completion_tokens + (usage.completion_tokens || 0),
        elapsed_ms: totals.elapsed_ms + (usage.elapsed_ms || 0),
        copilot_credits: totals.copilot_credits + (usage.copilot_credits || 0)
      }),
      { prompt_tokens: 0, output_tokens: 0, completion_tokens: 0, elapsed_ms: 0, copilot_credits: 0 }
    );
    const userMessageCount = turnMessages.filter((message) => message.role === "user").length;
    const assistantMessageCount = turnMessages.filter((message) => message.role === "assistant").length;

    return [{
      ...snapshot,
      message_count: turnMessages.length,
      user_message_count: userMessageCount,
      assistant_message_count: assistantMessageCount,
      user_followup_count: Math.max(userMessageCount - 1, 0),
      turn_started_count: 1,
      turn_completed_count: completeEvent ? 1 : 0,
      turn_aborted_count: abortedEvent ? 1 : 0,
      task_repeat_attempts: 0,
      tool_call_count: processSteps.filter((step) => step.kind === "tool_call").length,
      tool_result_count: processSteps.filter((step) => step.kind === "tool_result").length,
      patch_apply_count: 0,
      patch_success_count: 0,
      messages: turnMessages,
      process_steps: processSteps.length > 0 ? processSteps : undefined,
      file_reads: fileReads.length > 0 ? fileReads : undefined,
      code_edits: codeEdits.length > 0 ? codeEdits : undefined,
      turn_events: turnEvents.length > 0 ? turnEvents : undefined,
      request_usage: requestUsage.length > 0 ? requestUsage : undefined,
      usage_totals: requestUsage.length > 0 ? usageTotals : undefined,
      model: requestUsage.find((usage) => usage.model)?.model || snapshot.model,
      resolved_model: requestUsage.find((usage) => usage.model)?.model || snapshot.resolved_model,
      latest_turn_complete: Boolean(completeEvent),
      latest_turn_aborted: Boolean(abortedEvent),
      latest_turn_terminal: true
    }];
  });
}

export async function captureLatestCodexConversation(
  options: { includeText?: boolean; sessionFile?: string; sessionId?: string; latestTurnOnly?: boolean } = {}
): Promise<ConversationSnapshot> {
  const file = cleanExistingFile(options.sessionFile) || await latestSessionFile();
  if (!file) throw new Error("No Codex session file found under ~/.codex/sessions");

  const includeText = Boolean(options.includeText);
  const { lines: incrementalLines, cursor, state } = await readIncrementalJsonlLines("codex", file, {
    bootstrapAtEof: !options.sessionFile
  });
  let lines = incrementalLines;
  let usingIncrementalTail = true;
  if (
    options.latestTurnOnly &&
    incrementalLines.length > 0 &&
    codexLinesContainPayloadType(incrementalLines, "task_complete") &&
    !codexLinesContainPayloadType(incrementalLines, "user_message")
  ) {
    const full = await readCompleteJsonlLines(file, 0, cursor.file_size);
    if (full.lines.length > incrementalLines.length) {
      lines = full.lines;
      usingIncrementalTail = false;
    }
  }
  const turnIndexOffset =
    usingIncrementalTail && codexLinesContainPayloadType(lines, "user_message")
      ? await codexTurnIndexOffset(file, cursor, state)
      : 0;
  if (lines.length === 0) {
    return emptyConversationSnapshot({
      tool: "codex",
      file,
      includeText,
      sessionId: options.sessionId || state?.session_id,
      cursor,
      source: state?.source
    });
  }
  const messages: CapturedMessage[] = [];
  const processSteps: CapturedProcessStep[] = [];
  const fileReads = new Map<string, FileReadRecord>();
  const codeEdits: CodeEditRecord[] = [];
  const turnEvents: CapturedTurnEvent[] = [];
  const tokenUsageEvents: CapturedTokenUsageEvent[] = [];
  const modelEvents: CapturedModelEvent[] = [];
  let sessionId: string | undefined = canonicalSessionIdForFile(options.sessionId || state?.session_id, file);
  let cwd: string | undefined = state?.cwd;
  let source: string | undefined = state?.source;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let turnStartedCount = 0;
  let turnCompletedCount = 0;
  let turnAbortedCount = 0;
  let patchApplyCount = 0;
  let patchSuccessCount = 0;
  let sawEventMessages = false;
  let sequence = 0;

  for (const line of lines) {
    sequence += 1;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry.payload || {};
    const occurredAt = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    if (entry.type === "session_meta") {
      sessionId = payload.id || sessionId;
      cwd = payload.cwd || cwd;
      source = payload.source || source;
      continue;
    }
    if (entry.type === "turn_context") {
      const model = cleanString(payload.model || payload.collaboration_mode?.settings?.model);
      if (model) modelEvents.push({ model, sequence });
      cwd = cleanString(payload.cwd) || cwd;
      continue;
    }
    if (entry.type === "event_msg") {
      if (payload.type === "task_started") {
        turnStartedCount += 1;
        turnEvents.push({ kind: "task_started", occurred_at: occurredAt, sequence, turn_id: cleanString(payload.turn_id) });
        continue;
      }
      if (payload.type === "task_complete") {
        turnCompletedCount += 1;
        turnEvents.push({
          kind: "task_complete",
          occurred_at: occurredAt,
          sequence,
          turn_id: cleanString(payload.turn_id),
          duration_ms: finiteNumber(payload.duration_ms),
          time_to_first_token_ms: finiteNumber(payload.time_to_first_token_ms)
        });
        continue;
      }
      if (payload.type === "turn_aborted") {
        turnAbortedCount += 1;
        turnEvents.push({ kind: "turn_aborted", occurred_at: occurredAt, sequence, turn_id: cleanString(payload.turn_id) });
        continue;
      }
      if (payload.type === "token_count") {
        const info = jsonRecord(payload.info);
        const lastTokenUsage = jsonRecord(info?.last_token_usage);
        const promptTokens = finiteNumber(lastTokenUsage?.input_tokens);
        const outputTokens = finiteNumber(lastTokenUsage?.output_tokens);
        if (promptTokens !== undefined || outputTokens !== undefined) {
          tokenUsageEvents.push({
            sequence,
            occurred_at: occurredAt,
            ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
            ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {})
          });
        }
        continue;
      }
      if (payload.type === "patch_apply_end") {
        patchApplyCount += 1;
        if (payload.success === true) patchSuccessCount += 1;
        continue;
      }
      if (payload.type === "user_message" || payload.type === "agent_message") {
        if (!sawEventMessages) {
          messages.length = 0;
        }
        sawEventMessages = true;
        const role = payload.type === "user_message" ? "user" : "assistant";
        const text = typeof payload.message === "string" ? payload.message : "";
        if (!text.trim()) continue;
        const message: CapturedMessage = {
          role,
          text_len: text.length,
          text_hash: hashText(text),
          message_id: String(payload.id || payload.message_id || entry.id || codexEventMessageId(role, text, occurredAt, sequence)),
          occurred_at: occurredAt,
          sequence
        };
        if (includeText) message.text = text;
        messages.push(message);
        continue;
      }
    }
    if (entry.type !== "response_item") continue;
    if (payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "web_search_call") {
      toolCallCount += 1;
      const toolName = normalizeToolName(payload.name || payload.function_name || payload.tool_name);
      const args = payload.arguments || payload.input || payload.args || {};
      const argsObj = toolInputRecord(args);
      const argsText = typeof args === "string" ? args : JSON.stringify(argsObj);
      const step: CapturedProcessStep = {
        kind: "tool_call",
        text_len: argsText.length,
        text_hash: hashText(argsText),
        tool_name: toolName,
        status: "complete",
        occurred_at: occurredAt,
        sequence
      };
      if (includeText) step.text = argsText;
      processSteps.push(step);
      extractFileReads(toolName, argsObj, fileReads, sequence, occurredAt);
      if (isEditTool(toolName)) {
        for (const edit of extractCodeEdits(toolName, argsObj, includeText)) {
          codeEdits.push({ ...edit, sequence, occurred_at: occurredAt });
        }
      }
      continue;
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      toolResultCount += 1;
      const output = payload.output || payload.result || payload.content || "";
      const outputText = typeof output === "string" ? output : JSON.stringify(output);
      const step: CapturedProcessStep = {
        kind: "tool_result",
        text_len: outputText.length,
        text_hash: hashText(outputText),
        tool_name: normalizeToolName(payload.name || payload.tool_name),
        status: payload.is_error || payload.isError ? "failed" : "complete",
        occurred_at: occurredAt,
        sequence
      };
      if (includeText) step.text = outputText.slice(0, 2048);
      processSteps.push(step);
      continue;
    }
    if (payload.type === "reasoning") {
      const reasoningText =
        extractText(payload.summary) ||
        extractText(payload.content) ||
        (typeof payload.text === "string" ? payload.text : "");
      if (reasoningText.trim()) {
        processSteps.push({
          kind: "visible_reasoning",
          text_len: reasoningText.length,
          text_hash: hashText(reasoningText),
          status: "complete",
          occurred_at: occurredAt,
          sequence,
          ...(includeText ? { text: reasoningText } : {})
        });
      }
      continue;
    }
    if (payload.type !== "message") continue;
    if (sawEventMessages) continue;
    const role = String(payload.role || "unknown");
    if (!["user", "assistant"].includes(role)) continue;
    const text = extractText(payload.content);
    if (!text.trim()) continue;
    const message: CapturedMessage = {
      role,
      text_len: text.length,
      text_hash: hashText(text),
      message_id: String(payload.id || entry.id || `${entry.type}:${messages.length}`),
      occurred_at: occurredAt,
      sequence
    };
    if (includeText) message.text = text;
    messages.push(message);
  }

  const userMessageCount = messages.filter((m) => m.role === "user").length;
  const assistantMessageCount = messages.filter((m) => m.role === "assistant").length;
  const dedupedSteps = dedupeProcessSteps(processSteps);
  const { requestUsage, usageTotals, resolvedModel } = buildCodexRequestUsage({
    sessionId,
    messages,
    turnEvents,
    tokenUsageEvents,
    modelEvents,
    turnIndexOffset
  });
  const resolvedCodeEdits = await resolveRelativeCodeEditLines(codeEdits, cwd);

  const latestTurnComplete = codexLatestTurnComplete(messages, turnEvents);
  const latestTurnAborted = codexLatestTurnAborted(messages, turnEvents);
  const snapshot = {
    session_id: sessionId,
    session_file: file.replace(homedir(), "~"),
    cwd,
    source,
    model: resolvedModel,
    resolved_model: resolvedModel,
    message_count: messages.length,
    user_message_count: userMessageCount,
    assistant_message_count: assistantMessageCount,
    user_followup_count: Math.max(userMessageCount - 1, 0),
    turn_started_count: turnStartedCount,
    turn_completed_count: turnCompletedCount,
    turn_aborted_count: turnAbortedCount,
    task_repeat_attempts: Math.max(turnStartedCount - 1, 0),
    tool_call_count: toolCallCount,
    tool_result_count: toolResultCount,
    patch_apply_count: patchApplyCount,
    patch_success_count: patchSuccessCount,
    include_text: includeText,
    messages,
    process_steps: dedupedSteps.length > 0 ? dedupedSteps : undefined,
    file_reads: fileReads.size > 0 ? [...fileReads.values()] : undefined,
    code_edits: resolvedCodeEdits.length > 0 ? resolvedCodeEdits : undefined,
    turn_events: turnEvents.length > 0 ? turnEvents : undefined,
    request_usage: requestUsage.length > 0 ? requestUsage : undefined,
    usage_totals: requestUsage.length > 0 ? usageTotals : undefined,
    latest_turn_complete: latestTurnComplete,
    latest_turn_aborted: latestTurnAborted,
    latest_turn_terminal: latestTurnComplete || latestTurnAborted,
    turn_index_offset: turnIndexOffset,
    capture_cursor: cursor
  };
  return options.latestTurnOnly ? latestCodexTurnSnapshot(snapshot) : snapshot;
}

function roleFromClaudeEntry(entry: any): string | undefined {
  if (["user", "assistant"].includes(String(entry.type))) return String(entry.type);
  if (["user", "assistant"].includes(String(entry.role))) return String(entry.role);
  if (entry.message && ["user", "assistant"].includes(String(entry.message.role))) return String(entry.message.role);
  return undefined;
}

function textFromClaudeEntry(entry: any): string {
  if (typeof entry.content === "string" || Array.isArray(entry.content)) return extractText(entry.content);
  if (entry.message && (typeof entry.message.content === "string" || Array.isArray(entry.message.content))) {
    return extractText(entry.message.content);
  }
  if (typeof entry.text === "string") return entry.text;
  if (typeof entry.message === "string") return entry.message;
  return "";
}

function processClaudeContentBlocks(
  content: unknown,
  processSteps: CapturedProcessStep[],
  fileReads: Map<string, FileReadRecord>,
  codeEdits: CodeEditRecord[],
  includeText: boolean
): { toolCalls: number; toolResults: number } {
  if (!Array.isArray(content)) return { toolCalls: 0, toolResults: 0 };
  let toolCalls = 0;
  let toolResults = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const blockType = (block as any).type;
    if (blockType === "thinking") {
      const thinkingText = typeof (block as any).thinking === "string" ? (block as any).thinking : "";
      if (thinkingText) {
        processSteps.push({
          kind: "thinking",
          text_len: thinkingText.length,
          text_hash: hashText(thinkingText),
          ...(includeText ? { text: thinkingText } : {})
        });
      }
    } else if (blockType === "tool_use") {
      toolCalls += 1;
      const toolName = normalizeToolName((block as any).name);
      const input = (block as any).input || {};
      const inputText = typeof input === "string" ? input : JSON.stringify(input);
      const inputObj = toolInputRecord(input);
      processSteps.push({
        kind: "tool_call",
        text_len: inputText.length,
        text_hash: hashText(inputText),
        tool_name: toolName,
        status: "complete",
        ...(includeText ? { text: inputText } : {})
      });
      extractFileReads(toolName, inputObj, fileReads);
      if (isEditTool(toolName)) {
        codeEdits.push(...extractCodeEdits(toolName, inputObj, includeText));
      }
    } else if (blockType === "tool_result") {
      toolResults += 1;
      const output = (block as any).content || (block as any).output || "";
      const outputText = typeof output === "string" ? output : JSON.stringify(output);
      processSteps.push({
        kind: "tool_result",
        text_len: outputText.length,
        text_hash: hashText(outputText),
        tool_name: normalizeToolName((block as any).name || (block as any).tool_name),
        status: (block as any).is_error ? "failed" : "complete",
        ...(includeText ? { text: outputText.slice(0, 2048) } : {})
      });
    }
  }
  return { toolCalls, toolResults };
}

export async function captureLatestClaudeConversation(
  options: { includeText?: boolean; sessionFile?: string; sessionId?: string } = {}
): Promise<ConversationSnapshot> {
  const file = cleanExistingFile(options.sessionFile) || await latestClaudeTranscriptFile();
  if (!file) throw new Error("No Claude transcript file found under ~/.claude/transcripts or ~/.claude/projects");

  const includeText = Boolean(options.includeText);
  const { lines, cursor, state } = await readIncrementalJsonlLines("claude", file, {
    bootstrapAtEof: !options.sessionFile
  });
  if (lines.length === 0) {
    return emptyConversationSnapshot({
      tool: "claude",
      file,
      includeText,
      sessionId: options.sessionId || state?.session_id,
      cursor,
      source: state?.source || "claude-transcript"
    });
  }
  const messages: CapturedMessage[] = [];
  const processSteps: CapturedProcessStep[] = [];
  const fileReads = new Map<string, FileReadRecord>();
  const codeEdits: CodeEditRecord[] = [];
  let sessionId: string | undefined = options.sessionId || state?.session_id || basename(file, ".jsonl");
  let cwd: string | undefined = state?.cwd;
  let toolCallCount = 0;
  let toolResultCount = 0;
  const seenMessageIds = new Set<string>();
  const seenFallbackEntries = new Set<string>();

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    sessionId = entry.session_id || entry.sessionId || entry.conversation_id || entry.conversationId || sessionId;
    cwd = entry.cwd || entry.project_path || entry.projectPath || cwd;

    if (entry.type === "tool_result" || entry.tool_result || entry.tool_output) {
      toolResultCount += 1;
      const output = entry.output || entry.result || entry.content || entry.tool_output || "";
      const outputText = typeof output === "string" ? output : JSON.stringify(output);
      processSteps.push({
        kind: "tool_result",
        text_len: outputText.length,
        text_hash: hashText(outputText),
        tool_name: normalizeToolName(entry.tool_name || entry.name),
        status: entry.is_error || entry.isError ? "failed" : "complete",
        ...(includeText ? { text: outputText.slice(0, 2048) } : {})
      });
      continue;
    }
    if (entry.type === "tool_use" || entry.tool_use || entry.tool_name) {
      toolCallCount += 1;
      const toolName = normalizeToolName(entry.name || entry.tool_name || entry.function_name);
      const input = entry.input || entry.arguments || entry.args || entry.tool_use || {};
      const inputObj = toolInputRecord(input);
      const inputText = typeof input === "string" ? input : JSON.stringify(inputObj);
      processSteps.push({
        kind: "tool_call",
        text_len: inputText.length,
        text_hash: hashText(inputText),
        tool_name: toolName,
        status: "complete",
        ...(includeText ? { text: inputText } : {})
      });
      extractFileReads(toolName, inputObj, fileReads);
      if (isEditTool(toolName)) {
        codeEdits.push(...extractCodeEdits(toolName, inputObj, includeText));
      }
      continue;
    }

    const role = roleFromClaudeEntry(entry);
    if (!role) continue;

    // Extract thinking/tool_use from Claude content block arrays
    const content = entry.content || entry.message?.content;
    if (content) {
      const counts = processClaudeContentBlocks(content, processSteps, fileReads, codeEdits, includeText);
      toolCallCount += counts.toolCalls;
      toolResultCount += counts.toolResults;
    }

    const text = textFromClaudeEntry(entry);
    if (!text.trim()) continue;
    const messageId = String(entry.uuid || entry.id || entry.message?.id || "");
    if (messageId) {
      if (seenMessageIds.has(messageId)) continue;
      seenMessageIds.add(messageId);
    } else {
      const fallbackKey = hashText(JSON.stringify({
        type: entry.type,
        role,
        text,
        timestamp: entry.timestamp || entry.created_at || entry.createdAt
      }));
      if (seenFallbackEntries.has(fallbackKey)) continue;
      seenFallbackEntries.add(fallbackKey);
    }
    const message: CapturedMessage = {
      role,
      text_len: text.length,
      text_hash: hashText(text),
      message_id: messageId || undefined,
      occurred_at:
        typeof entry.timestamp === "string"
          ? entry.timestamp
          : typeof entry.created_at === "string"
            ? entry.created_at
            : typeof entry.createdAt === "string"
              ? entry.createdAt
              : undefined
    };
    if (includeText) message.text = text;
    messages.push(message);
  }

  const userMessageCount = messages.filter((m) => m.role === "user").length;
  const assistantMessageCount = messages.filter((m) => m.role === "assistant").length;
  const dedupedSteps = dedupeProcessSteps(processSteps);

  return {
    session_id: sessionId,
    session_file: file.replace(homedir(), "~"),
    cwd,
    source: "claude-transcript",
    message_count: messages.length,
    user_message_count: userMessageCount,
    assistant_message_count: assistantMessageCount,
    user_followup_count: Math.max(userMessageCount - 1, 0),
    turn_started_count: userMessageCount,
    turn_completed_count: assistantMessageCount,
    turn_aborted_count: 0,
    task_repeat_attempts: Math.max(userMessageCount - 1, 0),
    tool_call_count: toolCallCount,
    tool_result_count: toolResultCount,
    patch_apply_count: 0,
    patch_success_count: 0,
    include_text: includeText,
    messages,
    process_steps: dedupedSteps.length > 0 ? dedupedSteps : undefined,
    file_reads: fileReads.size > 0 ? [...fileReads.values()] : undefined,
    code_edits: codeEdits.length > 0 ? codeEdits : undefined,
    capture_cursor: cursor
  };
}

export async function captureLatestConversation(
  tool: ToolName,
  options: { includeText?: boolean; sessionFile?: string; sessionId?: string; latestTurnOnly?: boolean } = {}
): Promise<ConversationSnapshot> {
  if (tool === "claude") return captureLatestClaudeConversation(options);
  return captureLatestCodexConversation(options);
}
