import * as vscode from "vscode";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  CollectorClient,
  captureLatestClaudeTurnSnapshots,
  claudeWorkspaceDiffPathCandidates,
  clientId,
  classifySpecPath,
  commitSnapshot,
  currentDiffDetails,
  diffSummary,
  installGitHooks,
  markAiActivity,
  makeEvent,
  buildCopilotTurnSnapshotsFromReplayState,
  COPILOT_TURN_PARSER_VERSION,
  copilotReplayOffsets,
  copilotTurnEventId,
  copilotTurnSignature,
  pushSnapshot,
  recordAiLineSnapshot,
  redactText,
  replayCopilotChatSessionState,
  searchSpecs,
  stableEventId,
  hasClaudeExternalWriteSignal,
  type ObservabilityEvent,
  type BatchUploadResult,
  type ClaudeTurnSnapshot,
  type CopilotChatReplayState,
  type CopilotTurnSnapshot,
  DEFAULT_COLLECTOR_URL,
  DEFAULT_DASHBOARD_URL,
  loadTinyAiEnvFile,
  parseCopilotRequestUsage,
  type RequestUsage,
  tinyAiAutoInstallGitHooksEnabled,
  tinyAiCollectorFallbackUrlsForTool,
  tinyAiDashboardFallbackUrlsForTool,
  tinyAiToolEnvValue,
  type UsageTotals,
  type UserIdentity,
  type SpecClassification
} from "@tinyai/observability-runtime";

let currentTaskId: string | undefined;
let currentModel: string | undefined;
let statusBar: vscode.StatusBarItem;
let panelProvider: ObservabilityPanelProvider | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
const pendingEvents: ObservabilityEvent[] = [];
type SourceConfidence = "direct" | "derived" | "inferred";
type CapturedConversationMessage = {
  role: string;
  text_len: number;
  text_hash: string;
  text?: string;
  source?: string;
  source_key?: string;
  occurred_at?: string;
};
type CapturedProcessStep = {
  step_id?: string;
  kind: string;
  text_len: number;
  text_hash: string;
  text?: string;
  source?: string;
  label?: string;
  tool_name?: string;
  status?: string;
};
type FileReadRecord = {
  path: string;
  line_start?: number;
  line_end?: number;
  source: string;
  tool_name?: string;
};
type SpecAccessRecord = {
  spec_scope: "project";
  doc_path: string;
  access_type: "read" | "edit";
  access_source: "tool_call" | "terminal_command";
  matched_doc_count: number;
  matched_docs: string[];
  source_key: string;
  via_catalog: false;
  matched_by: string[];
  confidence: "derived";
  occurred_at?: string;
};
type SpecDocumentRecord = {
  spec_scope: "project";
  doc_path: string;
  file_name: string;
  size_bytes: number;
  line_count: number;
  content_hash: string;
  mtime_ms: number;
  exists: true;
};
type CodeEditRecord = {
  file_path: string;
  sensitive: boolean;
  lines_added: number;
  lines_deleted: number;
  line_number_basis?: "absolute" | "relative";
  hunks: Array<{
    old_start: number;
    old_lines: number;
    new_start: number;
    new_lines: number;
    lines: Array<{
      line_type: "added" | "removed";
      old_line?: number;
      new_line?: number;
      text: string;
      text_hash: string;
      redacted?: boolean;
    }>;
  }>;
  source: string;
  tool_name?: string;
};
type ParsedCopilotTranscript = {
  sessionId: string;
  sessionFile: string;
  transcriptKind: string;
  contentHash: string;
  messageSignature: string;
  processSignature: string;
  messages: CapturedConversationMessage[];
  processSteps: CapturedProcessStep[];
  toolCallCount: number;
  toolResultCount: number;
  turnStartedCount: number;
  turnCompletedCount: number;
  turnAbortedCount: number;
  patchApplyCount: number;
  patchSuccessCount: number;
  specAccesses: SpecClassification[];
  fileReads: FileReadRecord[];
  codeEdits: CodeEditRecord[];
  startedAt?: string;
  title?: string;
  resolvedModel?: string;
  requestUsage: RequestUsage[];
  usageTotals: UsageTotals;
  requestCount: number;
  usageSignature: string;
};
const conversationMessages: CapturedConversationMessage[] = [];
const COPILOT_TRANSCRIPT_STATE_KEY = "tinyaiObservability.copilotTurnSnapshots";
const COPILOT_SESSION_CURSOR_STATE_KEY = "tinyaiObservability.copilotSessionCursors";
const COPILOT_CAPTURE_CAPABILITY = "turn-snapshot-v5";
const CLAUDE_TRANSCRIPT_STATE_KEY = "tinyaiObservability.claudeTurnSnapshots";
const CLAUDE_SESSION_CURSOR_STATE_KEY = "tinyaiObservability.claudeSessionCursors";
const CLAUDE_CAPTURE_CAPABILITY = "claude-turn-snapshot-v1";
const TRANSCRIPT_FULL_READ_MAX_BYTES = Number(process.env.TINYAI_OBS_TRANSCRIPT_FULL_READ_MAX_BYTES || 8 * 1024 * 1024);
const TRANSCRIPT_READ_CHUNK_BYTES = 1024 * 1024;
let codeChangeFlushTimer: ReturnType<typeof setTimeout> | undefined;
const EDITOR_CHANGE_BUFFER_MS = 30 * 60_000;
const TURN_EDITOR_WINDOW_BEFORE_MS = 2_000;
const TURN_EDITOR_WINDOW_AFTER_MS = 10_000;
const EDITOR_DELTA_INLINE_LINE_LIMIT = 5_000;

type EditorChangePayload = ReturnType<typeof editorChangePayload>;
type BufferedEditorChange = {
  occurred_at: string;
  occurred_at_ms: number;
  payload: EditorChangePayload;
};
const recentEditorChanges: BufferedEditorChange[] = [];

type CopilotTurnCaptureState = {
  event_id: string;
  signature: string;
  status: "queued" | "uploaded" | "acknowledged" | "failed";
  collector_url_hash: string;
  first_seen_at: string;
  last_attempt_at?: string;
  acknowledged_at?: string;
  error_count?: number;
  last_error?: string;
};
type CopilotTurnCaptureStateStore = Record<string, string | CopilotTurnCaptureState>;
type CopilotSessionCursor = {
  chat_fingerprint?: string;
  transcript_fingerprint?: string;
  chat_read_offset?: number;
  transcript_read_offset?: number;
  checkpoint_path?: string;
  checkpoint_hash?: string;
  checkpoint_parser_version?: string;
  replay_mode?: "full" | "checkpoint";
  initialized_at_eof?: boolean;
  processed_at: string;
};
type CopilotSessionCursorStore = Record<string, CopilotSessionCursor>;
type CopilotCheckpointFile = {
  schema_version: "copilot.checkpoint.v1";
  parser_version: string;
  session_id: string;
  chat_read_offset: number;
  chat_size: number;
  chat_mtime_ms: number;
  chat_fingerprint?: string;
  replay_state: CopilotChatReplayState;
  updated_at: string;
};
const pendingTurnStateKeysByEventId = new Map<string, string>();
const LEGACY_DEFAULT_COLLECTOR_URLS = new Set([
  "http://192.168.215.94:18080",
  "http://192.168.215.94:18080/",
  "http://10.161.248.127:18080",
  "http://10.161.248.127:18080/"
]);
let lastCopilotCaptureDiagnostics: Record<string, unknown> | undefined;
const QUEUE_FLUSH_TOOLS: ObservabilityEvent["tool"][] = ["copilot", "claude", "codex", "git"];

function workspacePath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}

function configuredCollectorUrl(): string | undefined {
  const value = vscode.workspace.getConfiguration("tinyaiObservability").get<string>("collectorUrl")?.trim();
  if (!value || LEGACY_DEFAULT_COLLECTOR_URLS.has(value)) return undefined;
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
    token: tinyAiToolEnvValue("copilot", "TOKEN", workspacePath()) || cfg.get<string>("token") || "",
    userName: cfg.get<string>("userName")?.trim() || tinyAiToolEnvValue("copilot", "USER_NAME", workspacePath()) || "",
    userId: cfg.get<string>("userId")?.trim() || tinyAiToolEnvValue("copilot", "USER_ID", workspacePath()) || "",
    team: cfg.get<string>("team")?.trim() || tinyAiToolEnvValue("copilot", "TEAM", workspacePath()) || "",
    captureConversationText: cfg.get<boolean>("captureConversationText") ?? true,
    captureVisibleReasoningText: cfg.get<boolean>("captureVisibleReasoningText") ?? false,
    autoCaptureCopilotLocalTranscripts: cfg.get<boolean>("autoCaptureCopilotLocalTranscripts") ?? true,
    autoCaptureClaudeLocalTranscripts: cfg.get<boolean>("autoCaptureClaudeLocalTranscripts") ?? true,
    autoCaptureCopilotCodeChanges: cfg.get<boolean>("autoCaptureCopilotCodeChanges") ?? true,
    enableClaudeWorkspaceDiffFallback: cfg.get<boolean>("enableClaudeWorkspaceDiffFallback") ?? false,
    autoInstallGitHooks: (cfg.get<boolean>("autoInstallGitHooks") ?? true) && tinyAiAutoInstallGitHooksEnabled(workspacePath()),
    autoCaptureRecentMinutes: cfg.get<number>("autoCaptureRecentMinutes") ?? 30,
    queueFlushIntervalSeconds: cfg.get<number>("queueFlushIntervalSeconds") ?? 30
  };
}

async function migrateLegacyCollectorUrl() {
  const settings = vscode.workspace.getConfiguration("tinyaiObservability");
  const configured = settings.get<string>("collectorUrl")?.trim();
  if (configured && LEGACY_DEFAULT_COLLECTOR_URLS.has(configured)) {
    await settings.update("collectorUrl", DEFAULT_COLLECTOR_URL, vscode.ConfigurationTarget.Global);
  }
}

const PLUGIN_VERSION = "0.1.50";

function pluginNameForTool(tool: ObservabilityEvent["tool"]): string {
  if (tool === "codex") return "tinyai-observability-codex";
  if (tool === "git") return "tinyai-observability-git-hook";
  return "tinyai-observability-vscode";
}

function client(tool: ObservabilityEvent["tool"] = "copilot"): CollectorClient {
  const cfg = config();
  return new CollectorClient({
    tool,
    workspacePath: workspacePath(),
    baseUrl: cfg.collectorUrl,
    fallbackUrls: cfg.collectorFallbackUrls,
    token: cfg.token,
    pluginName: pluginNameForTool(tool),
    pluginVersion: PLUGIN_VERSION
  });
}

function gitConfigValue(key: string): string | undefined {
  try {
    const value = execFileSync("git", ["-C", workspacePath(), "config", "--get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function slugIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._@-]/g, "");
}

function userIdentity(): Partial<UserIdentity> {
  const cfg = config();
  const gitName = gitConfigValue("user.name");
  const displayName = cfg.userName || process.env.TINYAI_OBS_USER_NAME || process.env.TINYAI_OBS_USER_DISPLAY_NAME || gitName || "";
  const userId = cfg.userId || process.env.TINYAI_OBS_USER_ID || (displayName ? slugIdentity(displayName) : "");
  const host = hostname();
  return {
    username: displayName || process.env.USER || process.env.USERNAME || "unknown",
    user_id: userId || undefined,
    user_display_name: displayName || undefined,
    team: cfg.team || process.env.TINYAI_OBS_TEAM || undefined,
    machine_id: vscode.env.machineId ? hashText(vscode.env.machineId) : undefined,
    host_hash: hashText(host)
  };
}

function event(
  eventType: Parameters<typeof makeEvent>[0]["eventType"],
  payload: Record<string, unknown> = {},
  sourceConfidence: SourceConfidence = "direct",
  eventId?: string
) {
  if (!currentTaskId) return;
  return eventForTask(currentTaskId, eventType, payload, sourceConfidence, eventId);
}

function eventForTask(
  taskId: string,
  eventType: Parameters<typeof makeEvent>[0]["eventType"],
  payload: Record<string, unknown> = {},
  sourceConfidence: SourceConfidence = "direct",
  eventId?: string,
  model?: string,
  tool: ObservabilityEvent["tool"] = "copilot",
  eventWorkspacePath = workspacePath()
) {
  const payloadSessionId = payload.session_id || payload.sessionId;
  const sessionId = typeof payloadSessionId === "string" && payloadSessionId.trim() ? payloadSessionId.trim() : undefined;
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

async function ensureTask(trigger: string) {
  const created = !currentTaskId;
  if (!currentTaskId) {
    currentTaskId = randomUUID();
    conversationMessages.splice(0, conversationMessages.length);
  }
  await markAiActivity(workspacePath(), { tool: "copilot", taskId: currentTaskId, source: trigger });
  if (!created) return;
  event("task_start", { trigger });
  updateStatus();
  await flush();
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function fullHashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function currentCollectorHash(): string {
  return hashText(config().collectorUrl.replace(/\/$/, ""));
}

function fileFingerprint(file: { mtimeMs: number; size: number } | undefined, capability = COPILOT_CAPTURE_CAPABILITY): string | undefined {
  return file ? `${file.mtimeMs}:${file.size}:${capability}` : undefined;
}

function acknowledgedSignature(state: string | CopilotTurnCaptureState | undefined): string | undefined {
  if (!state) return undefined;
  if (typeof state === "string") return state;
  return state.status === "acknowledged" ? state.signature : undefined;
}

function queuedOrAcknowledgedSignature(state: string | CopilotTurnCaptureState | undefined): string | undefined {
  if (!state) return undefined;
  if (typeof state === "string") return state;
  return state.status === "queued" || state.status === "uploaded" || state.status === "acknowledged" ? state.signature : undefined;
}

function isoTimeFromUnknown(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  return undefined;
}

function isSensitiveCodePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    /(^|\/)\.env(?:\.|$)/.test(normalized) ||
    /(^|\/)(\.?npmrc|\.?pypirc|\.?netrc|id_rsa|id_ed25519)$/.test(normalized) ||
    /(secret|secrets|credential|credentials|token|private-key|private_key)/.test(normalized)
  );
}

function safeCodeLine(filePath: string, text: string) {
  if (isSensitiveCodePath(filePath)) return { text: "[REDACTED:SENSITIVE_FILE]", redacted: true };
  const redacted = redactText(text, { allowFullConversationText: true });
  return { text: redacted, redacted: redacted !== text };
}

function addedLinesFromEdit(filePath: string, startLine: number, text: string) {
  if (!text) return [];
  const rawLines = text.split(/\r?\n/);
  if (rawLines.at(-1) === "") rawLines.pop();
  return rawLines.slice(0, 80).map((line, index) => {
    const display = safeCodeLine(filePath, line);
    return {
      new_line: startLine + index,
      text: display.text,
      text_hash: hashText(`${filePath}\0${line}`),
      redacted: display.redacted || undefined
    };
  });
}

function displayPath(filePath: string) {
  const root = workspacePath();
  return filePath.startsWith(`${root}/`) ? filePath.slice(root.length + 1) : filePath.replace(/^file:\/\//, "");
}

function splitPatchLines(text: string) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function codeEditFromReplacement(
  filePathInput: unknown,
  oldStringInput: unknown,
  newStringInput: unknown,
  source: string,
  toolName?: string
): CodeEditRecord | undefined {
  if (typeof filePathInput !== "string" || typeof oldStringInput !== "string" || typeof newStringInput !== "string") return undefined;
  const filePath = displayPath(filePathInput);
  const oldLines = splitPatchLines(oldStringInput);
  const newLines = splitPatchLines(newStringInput);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix + prefix < oldLines.length &&
    suffix + prefix < newLines.length &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  if (removed.length === 0 && added.length === 0) return undefined;
  const hunkLines: CodeEditRecord["hunks"][number]["lines"] = [];
  removed.forEach((line, index) => {
    const display = safeCodeLine(filePath, line);
    hunkLines.push({
      line_type: "removed",
      old_line: prefix + index + 1,
      text: display.text,
      text_hash: hashText(`${filePath}\0${line}`),
      redacted: display.redacted || undefined
    });
  });
  added.forEach((line, index) => {
    const display = safeCodeLine(filePath, line);
    hunkLines.push({
      line_type: "added",
      new_line: prefix + index + 1,
      text: display.text,
      text_hash: hashText(`${filePath}\0${line}`),
      redacted: display.redacted || undefined
    });
  });
  return {
    file_path: filePath,
    sensitive: isSensitiveCodePath(filePath),
    lines_added: added.length,
    lines_deleted: removed.length,
    line_number_basis: "relative",
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

function codeEditsFromApplyPatch(patchInput: unknown, source: string, toolName?: string): CodeEditRecord[] {
  if (typeof patchInput !== "string" || !patchInput.includes("*** Begin Patch")) return [];
  const edits: CodeEditRecord[] = [];
  let current: CodeEditRecord | undefined;
  let oldLine = 1;
  let newLine = 1;

  function finish() {
    if (current && current.hunks.some((hunk) => hunk.lines.length > 0)) edits.push(current);
    current = undefined;
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
        line_number_basis: rawLine.startsWith("*** Add File: ") ? "absolute" : "relative",
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
      const hunkMatch = rawLine.match(/^@@(?:\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?)?/);
      if (hunkMatch?.[1]) {
        oldLine = Number(hunkMatch[1]);
        newLine = Number(hunkMatch[2] || 1);
        current.line_number_basis = "absolute";
      } else if (current.line_number_basis !== "absolute") {
        current.line_number_basis = "relative";
      }
      const hunk = { old_start: oldLine, old_lines: 0, new_start: newLine, new_lines: 0, lines: [] as CodeEditRecord["hunks"][number]["lines"] };
      current.hunks.push(hunk);
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
        text_hash: hashText(`${current.file_path}\0${text}`),
        redacted: display.redacted || undefined
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
        text_hash: hashText(`${current.file_path}\0${text}`),
        redacted: display.redacted || undefined
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

function collectCodeEditsFromUnknown(value: unknown, output: CodeEditRecord[], source: string, toolName?: string) {
  if (!value) return;
  if (typeof value === "string") {
    try {
      collectCodeEditsFromUnknown(JSON.parse(value), output, source, toolName);
    } catch {
      // Plain strings are not structured edit payloads.
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCodeEditsFromUnknown(item, output, source, toolName);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const currentToolName = readableValue(record.toolName || record.name || record.toolId || record.invocationMessage || toolName);
  const directEdit = codeEditFromReplacement(
    record.filePath ?? record.path ?? record.file,
    record.oldString ?? record.old_string,
    record.newString ?? record.new_string,
    source,
    currentToolName || toolName
  );
  if (directEdit) output.push(directEdit);
  const args = record.arguments ?? record.input ?? record;
  if (args && typeof args === "object") {
    const argRecord = args as Record<string, unknown>;
    for (const edit of codeEditsFromApplyPatch(argRecord.input ?? argRecord.patch, source, currentToolName || toolName)) output.push(edit);
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
  for (const item of Object.values(record)) collectCodeEditsFromUnknown(item, output, source, currentToolName || toolName);
}

function dedupeCodeEdits(edits: CodeEditRecord[]) {
  const seen = new Set<string>();
  return edits.filter((edit) => {
    const key = `${edit.file_path}:${edit.lines_added}:${edit.lines_deleted}:${JSON.stringify(edit.hunks)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function editorChangePayload(change: vscode.TextDocumentChangeEvent) {
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
      sensitive: isSensitiveCodePath(filePath) || undefined
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

function rememberEditorChange(change: vscode.TextDocumentChangeEvent): EditorChangePayload {
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

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
}

function turnEditorWindow(snapshot: {
  turn: { started_at?: string; completed_at?: string };
  user_message?: { occurred_at?: string };
  assistant_message?: { occurred_at?: string };
}): { startMs: number; endMs: number } | undefined {
  const completedAtMs = timestampMs(snapshot.turn.completed_at || snapshot.assistant_message?.occurred_at);
  if (!completedAtMs) return undefined;
  const startedAtMs =
    timestampMs(snapshot.turn.started_at) ??
    timestampMs(snapshot.user_message?.occurred_at) ??
    completedAtMs;
  return {
    startMs: startedAtMs - TURN_EDITOR_WINDOW_BEFORE_MS,
    endMs: completedAtMs + TURN_EDITOR_WINDOW_AFTER_MS
  };
}

function bufferedEditorChangesForTurn(snapshot: Parameters<typeof turnEditorWindow>[0]): BufferedEditorChange[] {
  const window = turnEditorWindow(snapshot);
  if (!window) return [];
  pruneEditorChangeBuffer();
  return recentEditorChanges.filter((entry) => entry.occurred_at_ms >= window.startMs && entry.occurred_at_ms <= window.endMs);
}

function editorDeltaFiles(entries: BufferedEditorChange[]) {
  const files = new Map<
    string,
    {
      file_path: string;
      sensitive?: boolean;
      lines_added: number;
      lines_deleted: number;
      change_count: number;
      changes: Array<Record<string, unknown>>;
      line_number_basis: "absolute";
      source: string;
      first_occurred_at: string;
      last_occurred_at: string;
    }
  >();
  for (const entry of entries) {
    const filePath = typeof entry.payload.file_path === "string" ? entry.payload.file_path : undefined;
    if (!filePath) continue;
    const existing =
      files.get(filePath) ||
      {
        file_path: filePath,
        sensitive: isSensitiveCodePath(filePath) || undefined,
        lines_added: 0,
        lines_deleted: 0,
        change_count: 0,
        changes: [],
        line_number_basis: "absolute",
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

function normalizeTurnDiffPath(raw: string, rootPath = workspacePath()): string | undefined {
  let candidate = cleanReadPath(raw) || raw.trim();
  if (!candidate || candidate.length > 1000 || candidate.includes("\0")) return undefined;
  candidate = candidate.replace(/^file:\/\//, "").replace(/\\/g, "/");
  const workspace = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
  if (candidate.startsWith(`${workspace}/`)) candidate = candidate.slice(workspace.length + 1);
  candidate = candidate.replace(/^\.?\//, "");
  if (candidate.startsWith("a/") || candidate.startsWith("b/")) candidate = candidate.slice(2);
  if (!candidate || /^(https?:|data:|[a-z]+:\/\/)/i.test(candidate)) return undefined;
  return candidate;
}

const PROJECT_SPEC_ROOT = "openspec/specs";
const PROJECT_SPEC_ABSOLUTE_ROOT = "/Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs";
const SPEC_READ_TOOLS = new Set(["read_file"]);
const SPEC_DIRECTORY_TOOLS = new Set(["list_dir", "list_directory"]);
const SPEC_EDIT_TOOLS = new Set(["replace_string_in_file", "create_file", "edit_file", "apply_patch"]);

function normalizeSpecDocPath(raw: string | undefined, cwd: string): string | undefined {
  if (!raw) return undefined;
  let candidate = cleanReadPath(raw) || raw.trim();
  if (!candidate || candidate.includes("\0")) return undefined;
  candidate = candidate.replace(/^file:\/\//, "").replace(/\\/g, "/").replace(/^['"`]|['"`]$/g, "");
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  if (candidate.startsWith(`${normalizedCwd}/`)) candidate = candidate.slice(normalizedCwd.length + 1);
  candidate = candidate.replace(/^\.?\//, "");
  const marker = `${PROJECT_SPEC_ROOT}/`;
  const markerIndex = candidate.indexOf(marker);
  if (markerIndex >= 0) candidate = candidate.slice(markerIndex);
  if (!candidate.startsWith(marker)) return undefined;
  if (!/\.[A-Za-z0-9]+$/.test(candidate)) return undefined;
  return candidate.replace(/[),.;:\s]+$/, "");
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toolArguments(tool: { arguments_raw?: unknown }): Record<string, unknown> {
  return jsonRecord(tool.arguments_raw);
}

function toolPathArgument(args: Record<string, unknown>): string | undefined {
  for (const key of ["filePath", "file_path", "path", "file", "uri"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function addSpecAccess(
  map: Map<string, SpecAccessRecord>,
  docPath: string | undefined,
  accessType: "read" | "edit",
  source: "tool_call" | "terminal_command",
  toolName?: string,
  occurredAt?: string,
  matchedDocs?: string[],
  sourceKey?: string
) {
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

function specPathsInCommand(command: string, cwd: string): string[] {
  const paths = new Set<string>();
  const pathPattern =
    /(?:file:\/\/)?(?:\/[^\s"'`<>\]\)]+\/)?openspec\/specs\/[^\s"'`<>\]\);|]+?\.[A-Za-z0-9]+/gi;
  for (const match of command.matchAll(pathPattern)) {
    const normalized = normalizeSpecDocPath(match[0], cwd);
    if (normalized) paths.add(normalized);
  }
  return [...paths];
}

function terminalCommandReadsSpecDirectory(command: string): boolean {
  if (!command.includes(PROJECT_SPEC_ROOT)) return false;
  return /\b(read_text|readBytes|readFileSync|readFile|open\s*\(|cat\s+|head\s+|tail\s+|sed\s+-n|find\s+|ls\s+|stat\s+|wc\s+|du\s+|os\.listdir|iterdir\s*\(|glob\s*\()\b/i.test(command);
}

function terminalCommandEditsSpecs(command: string): boolean {
  if (!command.includes(PROJECT_SPEC_ROOT)) return false;
  return /\b(write_text|writeFileSync|writeFile|appendFile|open\s*\([^)]*['"]w|tee\s+)|>\s*(?:['"])?[^\n]*openspec\/specs\//i.test(command);
}

type ProjectSpecFileEntry = {
  doc_path: string;
  absolute_path: string;
};

function projectSpecRootCandidates(cwd: string): string[] {
  return [...new Set([join(cwd, PROJECT_SPEC_ROOT), PROJECT_SPEC_ABSOLUTE_ROOT].map((item) => item.replace(/\\/g, "/").replace(/\/$/, "")))];
}

async function projectSpecFileEntries(cwd: string): Promise<ProjectSpecFileEntry[]> {
  async function visit(root: string, relativeDir: string): Promise<ProjectSpecFileEntry[]> {
    const absoluteDir = relativeDir ? join(root, relativeDir) : root;
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const results: ProjectSpecFileEntry[] = [];
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}`.replace(/\\/g, "/") : entry.name;
      if (entry.isDirectory()) {
        results.push(...(await visit(root, relativePath)));
      } else if (entry.isFile()) {
        results.push({
          doc_path: `${PROJECT_SPEC_ROOT}/${relativePath}`.replace(/\\/g, "/"),
          absolute_path: join(root, relativePath)
        });
      }
    }
    return results;
  }

  for (const root of projectSpecRootCandidates(cwd)) {
    const rootStat = await stat(root).catch(() => undefined);
    if (rootStat?.isDirectory()) return visit(root, "");
  }
  return [];
}

async function listProjectSpecFiles(cwd: string): Promise<string[]> {
  return (await projectSpecFileEntries(cwd)).map((entry) => entry.doc_path);
}

async function projectSpecDocuments(cwd: string): Promise<SpecDocumentRecord[]> {
  const docs = await projectSpecFileEntries(cwd);
  const records: SpecDocumentRecord[] = [];
  for (const doc of docs) {
    try {
      const [fileStat, content] = await Promise.all([stat(doc.absolute_path), readFile(doc.absolute_path)]);
      records.push({
        spec_scope: "project",
        doc_path: doc.doc_path,
        file_name: basename(doc.doc_path),
        size_bytes: fileStat.size,
        line_count: content.length === 0 ? 0 : content.toString("utf8").split(/\r\n|\r|\n/).length,
        content_hash: createHash("sha256").update(content).digest("hex"),
        mtime_ms: fileStat.mtimeMs,
        exists: true
      });
    } catch {
      // Ignore files that disappear while the directory is being scanned.
    }
  }
  return records.sort((a, b) => a.doc_path.localeCompare(b.doc_path));
}

async function specAccessesFromCopilotTurn(snapshot: {
  tool_calls?: Array<{
    tool_name?: string;
    arguments_raw?: unknown;
    tool_call_id?: string;
    completed_at?: string;
    started_at?: string;
  }>;
  turn: { completed_at?: string };
}, cwd: string): Promise<SpecAccessRecord[]> {
  const accesses = new Map<string, SpecAccessRecord>();
  for (const tool of snapshot.tool_calls || []) {
    const toolName = String(tool.tool_name || "");
    const args = toolArguments(tool);
    const occurredAt = tool.completed_at || tool.started_at || snapshot.turn.completed_at;
    const sourceKey = tool.tool_call_id || `${toolName}:${occurredAt || ""}`;
    if (SPEC_READ_TOOLS.has(toolName) || SPEC_EDIT_TOOLS.has(toolName)) {
      const accessType = SPEC_READ_TOOLS.has(toolName) ? "read" : "edit";
      addSpecAccess(accesses, normalizeSpecDocPath(toolPathArgument(args), cwd), accessType, "tool_call", toolName, occurredAt, undefined, sourceKey);
    }
    if (SPEC_DIRECTORY_TOOLS.has(toolName)) {
      const pathArg = toolPathArgument(args);
      const normalized = pathArg?.replace(/^file:\/\//, "").replace(/\\/g, "/").replace(/\/$/, "");
      const cwdRoot = join(cwd, PROJECT_SPEC_ROOT).replace(/\\/g, "/").replace(/\/$/, "");
      if (normalized === PROJECT_SPEC_ROOT || normalized === cwdRoot || normalized?.endsWith(`/${PROJECT_SPEC_ROOT}`)) {
        addSpecAccess(accesses, PROJECT_SPEC_ROOT, "read", "tool_call", toolName, occurredAt, await listProjectSpecFiles(cwd), sourceKey);
      }
    }
    if (toolName !== "run_in_terminal") continue;
    const command = typeof args.command === "string" ? args.command : "";
    if (!command) continue;
    const commandEdit = terminalCommandEditsSpecs(command);
    const commandRead = terminalCommandReadsSpecDirectory(command);
    const explicitDocs = specPathsInCommand(command, cwd);
    if (explicitDocs.length > 0) {
      const accessType = commandEdit ? "edit" : "read";
      const docPath = explicitDocs.length === 1 ? explicitDocs[0] : PROJECT_SPEC_ROOT;
      addSpecAccess(accesses, docPath, accessType, "terminal_command", toolName, occurredAt, explicitDocs, sourceKey);
    }
    if (commandRead && !commandEdit) {
      addSpecAccess(accesses, PROJECT_SPEC_ROOT, "read", "terminal_command", toolName, occurredAt, await listProjectSpecFiles(cwd), sourceKey);
    }
  }
  return [...accesses.values()];
}

function collectCodePathsFromString(text: string, output: Set<string>, rootPath = workspacePath()) {
  const pathPattern =
    /(?:file:\/\/)?(?:\/[^\s"'`<>\]\)]+\/)?[A-Za-z0-9._@+~/-]+\.(?:[cm]?[jt]sx?|json|ya?ml|md|py|java|kt|go|rs|rb|php|cs|cpp|c|h|hpp|sql|html|css|scss|less|vue|svelte|xml|toml|ini|env|sh|zsh|bash|gradle|properties|txt)(?::\d+(?:-\d+)?)?/gi;
  for (const match of text.matchAll(pathPattern)) {
    const rawPath = match[0];
    if (!rawPath.includes("/") && !rawPath.includes("\\") && !rawPath.startsWith(".") && !rawPath.startsWith("file://")) {
      continue;
    }
    const normalized = normalizeTurnDiffPath(rawPath, rootPath);
    if (normalized) output.add(normalized);
  }
}

function collectCodePathsFromUnknown(value: unknown, output: Set<string>, rootPath = workspacePath()) {
  if (typeof value === "string") {
    collectCodePathsFromString(value, output, rootPath);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCodePathsFromUnknown(item, output, rootPath);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["path", "file", "filePath", "filepath", "fsPath", "uri", "resource", "target"]) {
    const field = record[key];
    if (typeof field === "string") {
      const normalized = normalizeTurnDiffPath(field, rootPath);
      if (normalized) output.add(normalized);
    }
  }
  for (const item of Object.values(record)) collectCodePathsFromUnknown(item, output, rootPath);
}

function activeEditorRelativePath(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") return undefined;
  return normalizeTurnDiffPath(vscode.workspace.asRelativePath(editor.document.uri, false));
}

const COPILOT_EDIT_TOOL_RE =
  /(?:replace_string_in_file|multi_replace_string_in_file|create_file|insert_edit|write_file|edit_file|apply_patch)/i;
const COPILOT_TERMINAL_TOOL_RE = /(?:run_in_terminal|terminal|shell|bash|zsh|powershell|cmd)/i;
const COPILOT_TERMINAL_WRITE_RE =
  /(?:write_text|writefilesync|writefile|appendfile|open\s*\([^)]*['"]w|(?<![0-9])>>|(?<![0-9])>\s*[^&]|\btee\s+|\bsed\s+-i\b|\bperl\s+-pi\b|\btouch\s+|\bcp\s+|\bmv\s+|\brm\s+)/i;

function terminalTextFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(terminalTextFromUnknown).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(terminalTextFromUnknown).filter(Boolean).join("\n");
  }
  return "";
}

function copilotToolName(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return readableValue(record.tool_name || record.toolName || record.toolId || record.name || "");
}

function isCopilotWriteToolCall(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const toolName = copilotToolName(record);
  if (COPILOT_EDIT_TOOL_RE.test(toolName)) return true;
  if (!COPILOT_TERMINAL_TOOL_RE.test(toolName)) return false;
  return COPILOT_TERMINAL_WRITE_RE.test(terminalTextFromUnknown(record.arguments_raw ?? record.arguments ?? record.input ?? record.command ?? ""));
}

function copilotWriteToolCalls(snapshot: { tool_calls?: unknown }): unknown[] {
  const calls = Array.isArray(snapshot.tool_calls) ? snapshot.tool_calls : [];
  return calls.filter(isCopilotWriteToolCall);
}

function hasWorkspaceDiffBaselineForTurn(): boolean {
  // The local transcript poller sees Copilot/Claude turns after completion. Without a
  // turn-start diff baseline, current workspace diff can include older uncommitted work.
  return false;
}

function copilotTurnWorkspaceDiffPaths(
  snapshot: {
    tool_calls?: unknown;
    code_changes?: unknown;
  },
  toolFiles: Array<{ file_path: string }>,
  editorFiles: Array<{ file_path: string }>,
  editorEntries: BufferedEditorChange[],
  writeToolCalls: unknown[],
  rootPath = workspacePath()
): string[] {
  const paths = new Set<string>();
  for (const file of [...toolFiles, ...editorFiles]) {
    const normalized = normalizeTurnDiffPath(file.file_path, rootPath);
    if (normalized) paths.add(normalized);
  }
  for (const entry of editorEntries) {
    const normalized = typeof entry.payload.file_path === "string" ? normalizeTurnDiffPath(entry.payload.file_path, rootPath) : undefined;
    if (normalized) paths.add(normalized);
  }
  collectCodePathsFromUnknown(writeToolCalls, paths, rootPath);
  collectCodePathsFromUnknown(snapshot.code_changes, paths, rootPath);
  return [...paths].slice(0, 50);
}

function codeEditsFromCopilotTurn(snapshot: CopilotTurnSnapshot): CodeEditRecord[] {
  const edits: CodeEditRecord[] = [];
  collectCodeEditsFromUnknown(snapshot.tool_calls, edits, "copilot_turn_tool_calls");
  collectCodeEditsFromUnknown(snapshot.process_steps, edits, "copilot_turn_process_steps");
  collectCodeEditsFromUnknown(snapshot.sub_agents, edits, "copilot_turn_sub_agents");
  return dedupeCodeEdits(edits);
}

async function editorFilesWithCurrentWorkspaceDiff(files: ReturnType<typeof editorDeltaFiles>) {
  if (!files.length) return [];
  const pathByNormalized = new Map<string, (typeof files)[number]>();
  for (const file of files) {
    const normalized = normalizeTurnDiffPath(file.file_path);
    if (normalized) pathByNormalized.set(normalized, file);
  }
  if (pathByNormalized.size === 0) return [];
  const diff = await currentDiffDetails(workspacePath(), {
    includeText: false,
    includeUntracked: true,
    maxFiles: 100,
    maxLinesPerFile: 0,
    paths: [...pathByNormalized.keys()]
  });
  const changedPaths = new Set((diff.file_paths || []).map((path) => normalizeTurnDiffPath(path)).filter(Boolean));
  return [...pathByNormalized.entries()]
    .filter(([path]) => changedPaths.has(path))
    .map(([, file]) => file);
}

async function recordCopilotTurnEditorDelta(snapshot: CopilotTurnSnapshot, taskId: string, turnClientId: string) {
  if (!config().autoCaptureCopilotCodeChanges) return;
  const toolFiles = codeEditsFromCopilotTurn(snapshot);
  const editorEntries = bufferedEditorChangesForTurn(snapshot);
  const editorFiles = await editorFilesWithCurrentWorkspaceDiff(editorDeltaFiles(editorEntries));
  const files = editorFiles;
  if (files.length > 0) {
    const linesAdded = files.reduce((sum, file) => sum + Number(file.lines_added || 0), 0);
    const linesDeleted = files.reduce((sum, file) => sum + Number(file.lines_deleted || 0), 0);
    const signature = hashText(JSON.stringify(files));
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
        attribution_evidence: "vscode_editor_changes_with_current_workspace_diff",
        capture_strategy: "editor_delta_confirmed_by_workspace_diff",
        files_changed: files.length,
        lines_added: linesAdded,
        lines_deleted: linesDeleted,
        include_text: true,
        truncated: files.some((file) => Boolean((file as Record<string, unknown>).truncated)),
        file_paths: files.map((file) => file.file_path).slice(0, 100),
        files,
        capture_note:
          "Per-turn code delta captured from VS Code text document changes within the request/response time window, only for files that still have current workspace diff. Copilot tool-call patches are used only as attribution/path hints because users can undo or reject them."
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

async function recordCopilotTurnWorkspaceDiffFallback(
  snapshot: CopilotTurnSnapshot,
  taskId: string,
  turnClientId: string,
  toolFiles: Array<{ file_path: string }>,
  editorFiles: Array<{ file_path: string }>,
  editorEntries: BufferedEditorChange[]
) {
  const writeToolCalls = copilotWriteToolCalls(snapshot);
  if (!writeToolCalls.length) return;
  if (!hasWorkspaceDiffBaselineForTurn()) return;
  if (!toolFiles.length && !editorFiles.length && !editorEntries.length) return;
  const paths = copilotTurnWorkspaceDiffPaths(snapshot, toolFiles, editorFiles, editorEntries, writeToolCalls);
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
  const signature = hashText(JSON.stringify([diff.diff_hash, diff.file_paths, diff.lines_added, diff.lines_deleted]));
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
      capture_note:
        "Fallback code evidence captured after a Copilot turn with terminal/script/external-write signals. It is limited to files related to this turn, so terminal-written files can be captured even when VS Code editor delta is incomplete."
    },
    "derived",
    stableEventId(
      `copilot:turn_workspace_diff:${turnClientId}:${workspacePath()}:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}:${signature}`
    ),
    snapshot.model
  );
}

function codeEditsFromClaudeTurn(snapshot: ClaudeTurnSnapshot): CodeEditRecord[] {
  const edits: CodeEditRecord[] = (snapshot.code_changes || []).map((change) => {
    const basis: CodeEditRecord["line_number_basis"] =
      change.line_number_basis === "absolute" ? "absolute" : change.line_number_basis === "relative" ? "relative" : undefined;
    return {
      file_path: displayPath(String(change.file_path || "")),
      sensitive: isSensitiveCodePath(String(change.file_path || "")),
      lines_added: Number(change.lines_added || 0),
      lines_deleted: Number(change.lines_deleted || 0),
      hunks: Array.isArray(change.hunks) ? change.hunks as CodeEditRecord["hunks"] : [],
      line_number_basis: basis,
      source: "claude_turn_tool_patch",
      tool_name: change.tool_name
    };
  }).filter((change) => change.file_path && (change.lines_added > 0 || change.lines_deleted > 0 || change.hunks.length > 0));
  return dedupeCodeEdits(edits);
}

async function recordClaudeTurnEditorDelta(snapshot: ClaudeTurnSnapshot, taskId: string, turnClientId: string) {
  if (!config().autoCaptureCopilotCodeChanges) return;
  const cwd = snapshot.cwd || workspacePath();
  const toolFiles = codeEditsFromClaudeTurn(snapshot);
  const toolPaths = new Set(toolFiles.map((file) => normalizeTurnDiffPath(file.file_path, cwd) || file.file_path));
  const editorEntries = bufferedEditorChangesForTurn(snapshot);
  const editorFiles = editorDeltaFiles(editorEntries).filter((file) => {
    const normalized = normalizeTurnDiffPath(file.file_path, cwd) || file.file_path;
    return !toolPaths.has(normalized);
  });
  const files = [...editorFiles];
  if (files.length > 0) {
    const linesAdded = files.reduce((sum, file) => sum + Number(file.lines_added || 0), 0);
    const linesDeleted = files.reduce((sum, file) => sum + Number(file.lines_deleted || 0), 0);
    const signature = hashText(JSON.stringify(files));
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
        truncated: files.some((file) => Boolean((file as Record<string, unknown>).truncated)),
        file_paths: files.map((file) => file.file_path).slice(0, 100),
        files,
        cwd,
        capture_note:
          "Per-turn code delta captured from VS Code text document changes near a Claude turn. It is used when Claude JSONL does not include explicit edit/write tool arguments."
      },
      "derived",
      stableEventId(
        `claude:turn_editor_delta:${turnClientId}:${cwd}:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}:${signature}`
      ),
      snapshot.model,
      "claude",
      cwd
    );
  }
  if (config().enableClaudeWorkspaceDiffFallback) {
    await recordClaudeTurnWorkspaceDiffFallback(snapshot, taskId, turnClientId, toolFiles, editorFiles, editorEntries);
  }
}

async function recordClaudeTurnWorkspaceDiffFallback(
  snapshot: ClaudeTurnSnapshot,
  taskId: string,
  turnClientId: string,
  toolFiles: Array<{ file_path: string }>,
  editorFiles: Array<{ file_path: string }>,
  editorEntries: BufferedEditorChange[]
) {
  if (!hasClaudeExternalWriteSignal(snapshot)) return;
  if (!hasWorkspaceDiffBaselineForTurn()) return;
  const cwd = snapshot.cwd || workspacePath();
  const paths = new Set<string>();
  for (const path of claudeWorkspaceDiffPathCandidates(snapshot)) {
    const normalized = normalizeTurnDiffPath(path, cwd);
    if (normalized) paths.add(normalized);
  }
  for (const file of [...toolFiles, ...editorFiles]) {
    const normalized = normalizeTurnDiffPath(file.file_path, cwd);
    if (normalized) paths.add(normalized);
  }
  for (const entry of editorEntries) {
    const normalized = typeof entry.payload.file_path === "string" ? normalizeTurnDiffPath(entry.payload.file_path, cwd) : undefined;
    if (normalized) paths.add(normalized);
  }
  const pathList = [...paths].slice(0, 50);
  if (pathList.length === 0) return;
  const diff = await currentDiffDetails(cwd, {
    includeText: true,
    includeUntracked: true,
    maxFiles: 50,
    maxLinesPerFile: EDITOR_DELTA_INLINE_LINE_LIMIT + 1,
    paths: pathList
  });
  if (!diff.files.length || diff.lines_added + diff.lines_deleted === 0) return;
  const totalLines = diff.lines_added + diff.lines_deleted;
  const signature = hashText(JSON.stringify([diff.diff_hash, diff.file_paths, diff.lines_added, diff.lines_deleted]));
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
      cwd,
      related_path_candidates: paths,
      capture_note:
        "Fallback code evidence captured after a Claude turn with terminal/script/external-write signals. It is limited to files related to this turn and uses the Claude JSONL cwd as the git diff root."
    },
    "derived",
    stableEventId(
      `claude:turn_workspace_diff:${turnClientId}:${cwd}:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}:${signature}`
    ),
    snapshot.model,
    "claude",
    cwd
  );
}

function scheduleFlush(delayMs = 1200) {
  if (codeChangeFlushTimer) clearTimeout(codeChangeFlushTimer);
  codeChangeFlushTimer = setTimeout(() => {
    codeChangeFlushTimer = undefined;
    void flush();
  }, delayMs);
}

function appendConversationMessage(role: string, text: string, source: string) {
  const message = conversationMessage(role, text, source);
  if (message) conversationMessages.push(message);
}

function conversationMessage(
  role: string,
  text: string,
  source: string,
  sourceKey?: string,
  occurredAt?: string
): CapturedConversationMessage | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const includeText = config().captureConversationText;
  const message: CapturedConversationMessage = {
    role,
    text_len: trimmed.length,
    text_hash: hashText(trimmed),
    source,
    source_key: sourceKey,
    occurred_at: occurredAt
  };
  if (includeText) message.text = trimmed;
  return message;
}

function processStep(kind: string, text: string, source: string, extra: Partial<CapturedProcessStep> = {}): CapturedProcessStep | undefined {
  const trimmed = text.trim();
  if (!trimmed && !extra.label && !extra.tool_name && !extra.status) return undefined;
  const includeText = config().captureVisibleReasoningText;
  const normalizedText = trimmed || [extra.label, extra.tool_name, extra.status].filter(Boolean).join(" ");
  const step: CapturedProcessStep = {
    kind,
    text_len: normalizedText.length,
    text_hash: hashText(normalizedText),
    source,
    ...extra
  };
  if (includeText && normalizedText) step.text = normalizedText;
  return step;
}

function readableValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => readableValue(item)).filter(Boolean).join(" ") || fallback;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["name", "toolName", "displayName", "label", "title", "id", "kind", "command"]) {
      const text = readableValue(record[key]);
      if (text) return text;
    }
    const text = readableValue(record.value) || readableValue(record.message) || readableValue(record.input);
    if (text) return text;
  }
  return fallback;
}

function fileReadKey(record: FileReadRecord) {
  return `${record.path}:${record.line_start || ""}:${record.line_end || ""}`;
}

function cleanReadPath(raw: string): string | undefined {
  let candidate = raw.trim();
  const markdownLink = /\[[^\]]*\]\(([^)]+)\)/.exec(candidate);
  if (markdownLink) candidate = markdownLink[1];
  candidate = candidate
    .replace(/^\]\(/, "")
    .replace(/^file:\/\//, "")
    .replace(/#.*/, "")
    .replace(/^[`"'\[(<\s]+/, "")
    .replace(/[`"'\])>,.;:\s]+$/, "");
  const extensionMatch = /^(.*?\.(?:[cm]?[jt]sx?|json|ya?ml|md|py|java|kt|go|rs|rb|php|cs|cpp|c|h|hpp|sql|html|css|scss|less|vue|svelte|xml|toml|ini|env|sh|zsh|bash|dockerfile|gradle|properties|txt))(?:$|[#?:,)\]\s].*)/i.exec(candidate);
  if (extensionMatch) candidate = extensionMatch[1];
  if (!candidate || candidate.length > 500) return undefined;
  if (/^(https?:|data:|[a-z]+:\/\/)/i.test(candidate)) return undefined;
  if (!/[./\\]/.test(candidate)) return undefined;
  return candidate;
}

function addFileRead(
  output: Map<string, FileReadRecord>,
  rawPath: string,
  source: string,
  lineStart?: unknown,
  lineEnd?: unknown,
  toolName?: string
) {
  const path = cleanReadPath(rawPath);
  if (!path) return;
  const start = typeof lineStart === "number" ? lineStart : Number(lineStart);
  const end = typeof lineEnd === "number" ? lineEnd : Number(lineEnd);
  const record: FileReadRecord = {
    path,
    source,
    tool_name: toolName || undefined,
    line_start: Number.isFinite(start) && start > 0 ? start : undefined,
    line_end: Number.isFinite(end) && end > 0 ? end : undefined
  };
  const pathOnlyKey = `${record.path}::`;
  const hasRange = record.line_start !== undefined || record.line_end !== undefined;
  if (hasRange) {
    output.delete(pathOnlyKey);
  } else if ([...output.keys()].some((key) => key.startsWith(`${record.path}:`) && key !== pathOnlyKey)) {
    return;
  }
  output.set(fileReadKey(record), record);
}

function collectFileReadsFromString(text: string, output: Map<string, FileReadRecord>, source: string, toolName?: string) {
  const readPattern = /\b(?:Read|Reading|Opened|Viewed|读取|查看)\b\s+[`"']?([^\n,`"']+?)(?:[`"']?\s*,?\s*(?:lines?|行)\s+(\d+)\s*(?:to|-|到)\s*(\d+))?(?=$|\n|,|\s[-–—]|\s+complete\b)/gi;
  for (const match of text.matchAll(readPattern)) {
    addFileRead(output, match[1], source, match[2], match[3], toolName);
  }
}

function collectFileReadsFromUnknown(value: unknown, output: Map<string, FileReadRecord>, source: string, toolName?: string) {
  if (typeof value === "string") {
    collectFileReadsFromString(value, output, source, toolName);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFileReadsFromUnknown(item, output, source, toolName);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const currentToolName = readableValue(record.toolName || record.name || record.invocationMessage || toolName);
  const readLike = /read|open|view|cat|inspect|review|file/i.test(currentToolName);
  const lineStart = record.startLine ?? record.lineStart ?? record.start_line ?? record.line_start ?? record.start;
  const lineEnd = record.endLine ?? record.lineEnd ?? record.end_line ?? record.line_end ?? record.end;
  for (const key of ["path", "file", "filePath", "filepath", "fsPath", "uri", "resource", "target"]) {
    const field = record[key];
    if (typeof field === "string" && readLike) {
      addFileRead(output, field, source, lineStart, lineEnd, currentToolName);
    }
  }
  for (const item of Object.values(record)) collectFileReadsFromUnknown(item, output, source, currentToolName);
}

function appendTranscriptText(text: string, source: string) {
  const lines = text.split(/\r?\n/);
  let currentRole = "transcript";
  let buffer: string[] = [];
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

function looksLikeCommandText(text: string): boolean {
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
    capture_limitations:
      "Direct capture covers @tinyai, TinyAI LM tools, and user-imported transcripts. Regular GitHub Copilot Chat is captured from local VS Code workspaceStorage transcript JSONL files when present, and is classified as derived because it is read from persisted local transcript files rather than the Copilot Chat API.",
    messages: conversationMessages
  };
}

function conversationSnapshotPayloadForMessages(
  messages: CapturedConversationMessage[],
  sessionId: string | undefined,
  sessionFile: string,
  source: string,
  extra: Record<string, unknown> = {}
) {
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
    capture_limitations:
      "Captured from local VS Code Copilot Chat transcript JSONL files under workspaceStorage and globalStorage/emptyWindowChatSessions. This is complete local user/assistant transcript text when VS Code writes those files, but it is classified as derived because it is read from persisted local transcripts rather than the Copilot Chat API.",
    messages,
    ...extra
  };
}

function emitConversationSnapshot(sourceConfidence: SourceConfidence = "derived") {
  if (!currentTaskId || conversationMessages.length === 0) return;
  event("conversation_snapshot", conversationSnapshotPayload(), sourceConfidence);
}

function workspaceStorageRoot(): string | undefined {
  if (!extensionContext?.storageUri?.fsPath) return undefined;
  return dirname(extensionContext.storageUri.fsPath);
}

async function workspaceStorageRoots(): Promise<string[]> {
  const roots = new Set<string>();
  const currentRoot = workspaceStorageRoot();
  if (currentRoot) roots.add(currentRoot);

  const userDataRoots = [
    join(homedir(), "Library", "Application Support", "Code", "User", "workspaceStorage"),
    join(homedir(), "Library", "Application Support", "Code - Insiders", "User", "workspaceStorage"),
    join(homedir(), "Library", "Application Support", "Cursor", "User", "workspaceStorage"),
    join(homedir(), ".config", "Code", "User", "workspaceStorage"),
    join(homedir(), ".config", "Code - Insiders", "User", "workspaceStorage"),
    join(homedir(), ".config", "Cursor", "User", "workspaceStorage")
  ];
  if (process.env.APPDATA) {
    userDataRoots.push(
      join(process.env.APPDATA, "Code", "User", "workspaceStorage"),
      join(process.env.APPDATA, "Code - Insiders", "User", "workspaceStorage"),
      join(process.env.APPDATA, "Cursor", "User", "workspaceStorage")
    );
  }

  for (const candidate of userDataRoots) {
    try {
      const entries = await readdir(candidate, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) roots.add(join(candidate, entry.name));
      }
    } catch {
      // VS Code uses platform-specific storage roots; missing candidates are normal.
    }
  }

  return [...roots];
}

async function listJsonlFiles(
  dir: string,
  transcriptKind: string
): Promise<Array<{ path: string; transcriptKind: string; mtimeMs: number; size: number }>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
          const path = join(dir, entry.name);
          const info = await stat(path);
          return { path, transcriptKind, mtimeMs: info.mtimeMs, size: info.size };
        })
    );
    return files;
  } catch {
    return [];
  }
}

async function listJsonlFilesRecursive(
  dir: string,
  transcriptKind: string,
  maxDepth = 3
): Promise<Array<{ path: string; transcriptKind: string; mtimeMs: number; size: number }>> {
  const results: Array<{ path: string; transcriptKind: string; mtimeMs: number; size: number }> = [];
  async function visit(current: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const info = await stat(full);
          results.push({ path: full, transcriptKind, mtimeMs: info.mtimeMs, size: info.size });
        } catch {
          // Ignore files that disappear while Claude is rotating logs.
        }
      }
    }
  }
  await visit(dir, 0);
  return results;
}

async function globalChatSessionFiles(): Promise<Array<{ path: string; transcriptKind: string; mtimeMs: number; size: number }>> {
  const roots = [
    join(homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "emptyWindowChatSessions"),
    join(homedir(), "Library", "Application Support", "Code - Insiders", "User", "globalStorage", "emptyWindowChatSessions"),
    join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "emptyWindowChatSessions"),
    join(homedir(), ".config", "Code", "User", "globalStorage", "emptyWindowChatSessions"),
    join(homedir(), ".config", "Code - Insiders", "User", "globalStorage", "emptyWindowChatSessions"),
    join(homedir(), ".config", "Cursor", "User", "globalStorage", "emptyWindowChatSessions")
  ];
  if (process.env.APPDATA) {
    roots.push(
      join(process.env.APPDATA, "Code", "User", "globalStorage", "emptyWindowChatSessions"),
      join(process.env.APPDATA, "Code - Insiders", "User", "globalStorage", "emptyWindowChatSessions"),
      join(process.env.APPDATA, "Cursor", "User", "globalStorage", "emptyWindowChatSessions")
    );
  }
  const files = await Promise.all(roots.map((root) => listJsonlFiles(root, "vscode-empty-window-chat-session")));
  return files.flat();
}

function parseJsonlRecords(content: string): Record<string, unknown>[] {
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

async function readTextSegment(path: string, startOffset = 0): Promise<{ content: string; startOffset: number; nextOffset: number }> {
  const info = await stat(path);
  const safeOffset = startOffset > 0 && startOffset <= info.size ? startOffset : 0;
  if (safeOffset === 0) {
    return { content: await readFile(path, "utf8"), startOffset: safeOffset, nextOffset: info.size };
  }
  const handle = await open(path, "r");
  const chunks: Buffer[] = [];
  let position = safeOffset;
  try {
    while (position < info.size) {
      const length = Math.min(TRANSCRIPT_READ_CHUNK_BYTES, info.size - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { content: Buffer.concat(chunks).toString("utf8"), startOffset: safeOffset, nextOffset: info.size };
}

async function readJsonlRecords(path: string, startOffset = 0): Promise<{ records: Record<string, unknown>[]; nextOffset: number }> {
  const segment = await readTextSegment(path, startOffset);
  const lastNewline = segment.content.lastIndexOf("\n");
  if (lastNewline < 0) {
    return { records: [], nextOffset: segment.startOffset };
  }
  const completeContent = segment.content.slice(0, lastNewline + 1);
  return {
    records: parseJsonlRecords(completeContent),
    nextOffset: segment.startOffset + Buffer.byteLength(completeContent, "utf8")
  };
}

async function sourceFileInfo(path: string, mtimeMs: number, size: number, content?: string, readOffset = 0) {
  const hashContent = content ?? (size <= TRANSCRIPT_FULL_READ_MAX_BYTES ? await readFile(path, "utf8") : `${path}:${mtimeMs}:${size}:${readOffset}`);
  return {
    path,
    sha256: createHash("sha256").update(hashContent).digest("hex"),
    mtime_ms: mtimeMs,
    size_bytes: size,
    read_offset: readOffset,
    hash_scope: content || size <= TRANSCRIPT_FULL_READ_MAX_BYTES ? "full_file_or_segment" : "metadata"
  };
}

function copilotCheckpointDir(): string | undefined {
  const root = extensionContext?.globalStorageUri?.fsPath;
  return root ? join(root, "copilot-checkpoints") : undefined;
}

function copilotCheckpointPath(sessionKey: string): string | undefined {
  const dir = copilotCheckpointDir();
  return dir ? join(dir, `${hashText(sessionKey)}.json`) : undefined;
}

function checkpointHash(checkpoint: CopilotCheckpointFile): string {
  return fullHashText(JSON.stringify({
    schema_version: checkpoint.schema_version,
    parser_version: checkpoint.parser_version,
    session_id: checkpoint.session_id,
    chat_read_offset: checkpoint.chat_read_offset,
    chat_size: checkpoint.chat_size,
    chat_fingerprint: checkpoint.chat_fingerprint,
    replay_state: checkpoint.replay_state
  }));
}

async function readCopilotCheckpoint(
  sessionKey: string,
  cursor: CopilotSessionCursor | undefined,
  chat: { mtimeMs: number; size: number },
  chatFingerprint: string | undefined
): Promise<CopilotCheckpointFile | undefined> {
  const path = cursor?.checkpoint_path || copilotCheckpointPath(sessionKey);
  if (!path || !cursor?.checkpoint_hash) return undefined;
  if (cursor.checkpoint_parser_version !== COPILOT_TURN_PARSER_VERSION) return undefined;
  if (chat.size < (cursor.chat_read_offset || 0)) return undefined;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as CopilotCheckpointFile;
    if (parsed.schema_version !== "copilot.checkpoint.v1") return undefined;
    if (parsed.parser_version !== COPILOT_TURN_PARSER_VERSION) return undefined;
    if (parsed.session_id !== sessionKey) return undefined;
    if (parsed.chat_read_offset !== cursor.chat_read_offset) return undefined;
    if (chat.size < parsed.chat_read_offset) return undefined;
    if (checkpointHash(parsed) !== cursor.checkpoint_hash) return undefined;
    if (parsed.chat_fingerprint && chatFingerprint && parsed.chat_fingerprint === chatFingerprint) return parsed;
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeCopilotCheckpoint(
  sessionKey: string,
  chat: { mtimeMs: number; size: number },
  chatReadOffset: number,
  chatFingerprint: string | undefined,
  replayState: CopilotChatReplayState
): Promise<{ path?: string; hash?: string }> {
  const path = copilotCheckpointPath(sessionKey);
  const dir = copilotCheckpointDir();
  if (!path || !dir) return {};
  const checkpoint: CopilotCheckpointFile = {
    schema_version: "copilot.checkpoint.v1",
    parser_version: COPILOT_TURN_PARSER_VERSION,
    session_id: sessionKey,
    chat_read_offset: chatReadOffset,
    chat_size: chat.size,
    chat_mtime_ms: chat.mtimeMs,
    chat_fingerprint: chatFingerprint,
    replay_state: replayState,
    updated_at: new Date().toISOString()
  };
  const hash = checkpointHash(checkpoint);
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(checkpoint), "utf8");
  return { path, hash };
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (typeof record.value === "string") return record.value;
  if (typeof record.message === "string") return record.message;
  if (Array.isArray(record.parts)) return record.parts.map(textFromUnknown).filter(Boolean).join("\n");
  return "";
}

function assistantTextFromResponseParts(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (record.kind === "thinking" || record.kind === "mcpServersStarting" || record.kind === "toolInvocationSerialized") return "";
      return typeof record.value === "string" ? record.value : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function pushProcessStep(steps: CapturedProcessStep[], kind: string, text: string, source: string, extra: Partial<CapturedProcessStep> = {}) {
  const step = processStep(kind, text, source, extra);
  if (step) steps.push(step);
}

function processStepsFromResponseParts(value: unknown, steps: CapturedProcessStep[], source: string, fileReads?: Map<string, FileReadRecord>) {
  if (!Array.isArray(value)) return;
  const captureVisibleReasoning = config().captureVisibleReasoningText;
  for (const part of value) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const kind = String(record.kind || "");
    if (kind === "thinking") {
      if (!captureVisibleReasoning) continue;
      const text = textFromUnknown(record.value);
      const label = typeof record.generatedTitle === "string" ? record.generatedTitle : undefined;
      pushProcessStep(steps, "visible_reasoning", text || label || "Thinking", source, { label });
    } else if (kind === "toolInvocationSerialized") {
      const tool = record.value && typeof record.value === "object" ? (record.value as Record<string, unknown>) : record;
      const toolName = readableValue(tool.toolName || tool.name || tool.invocationMessage, "tool");
      const status = typeof tool.isComplete === "boolean" ? (tool.isComplete ? "complete" : "running") : undefined;
      if (fileReads) collectFileReadsFromUnknown(tool, fileReads, source, toolName);
      pushProcessStep(steps, "tool_call", textFromUnknown(tool), source, { tool_name: toolName, status });
    } else if (kind === "mcpServersStarting") {
      pushProcessStep(steps, "tool_call", "Starting MCP servers", source, { tool_name: "mcp", status: "starting" });
    }
  }
}

function userTextFromRenderedUserMessage(value: unknown): string {
  const rendered = textFromUnknown(value);
  if (!rendered) return "";
  const match = /<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/i.exec(rendered);
  return (match?.[1] || "").trim();
}

function userTextFromChatSessionRequest(record: Record<string, unknown>): string {
  const messageText = textFromUnknown(record.message);
  if (messageText) return messageText;
  const metadata = record.metadata && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : {};
  return userTextFromRenderedUserMessage(record.renderedUserMessage) || userTextFromRenderedUserMessage(metadata.renderedUserMessage);
}

function pushParsedMessage(
  messages: CapturedConversationMessage[],
  role: string,
  text: string,
  source: string,
  sourceKey?: string,
  occurredAt?: string
) {
  const message = conversationMessage(role, text, source, sourceKey, occurredAt);
  if (message) messages.push(message);
}

function dedupeMessages(messages: CapturedConversationMessage[]): CapturedConversationMessage[] {
  const output: CapturedConversationMessage[] = [];
  const positions = new Map<string, number>();
  for (const message of messages) {
    if (!message.source_key) {
      const previous = output.at(-1);
      if (previous?.role === message.role && previous.text_hash === message.text_hash) continue;
      output.push(message);
      continue;
    }
    const key = `${message.role}:${message.source_key}`;
    const existingPosition = positions.get(key);
    if (existingPosition === undefined) {
      positions.set(key, output.length);
      output.push(message);
      continue;
    }
    output[existingPosition] = message;
  }
  return output;
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

function messageSignature(messages: CapturedConversationMessage[]) {
  return hashText(JSON.stringify(messages.map((message) => [message.role, message.source_key || "", message.text_hash])));
}

function processSignature(steps: CapturedProcessStep[]) {
  return hashText(JSON.stringify(steps.map((step) => [step.kind, step.text_hash, step.tool_name || "", step.status || ""])));
}

function hasCodeEditProcess(steps: CapturedProcessStep[]) {
  return steps.some((step) => {
    const text = `${step.kind} ${step.label || ""} ${step.tool_name || ""} ${step.text || ""}`;
    return /\b(edited|editing|modified|modifying|patch|applied patch|apply patch|generating patch|created|deleted|renamed|wrote|updated)\b/i.test(text);
  });
}

function parsedTranscriptScore(parsed: ParsedCopilotTranscript, mtimeMs: number) {
  const hasUser = parsed.messages.some((message) => message.role === "user");
  const hasAssistant = parsed.messages.some((message) => message.role === "assistant");
  const completedPairBonus = hasUser && hasAssistant ? 10_000 : 0;
  const toolBonus = parsed.toolCallCount + parsed.toolResultCount + parsed.patchApplyCount + parsed.patchSuccessCount;
  return completedPairBonus + parsed.messages.length * 1_000 + parsed.processSteps.length * 100 + toolBonus * 10 + Math.floor(mtimeMs / 1_000_000_000);
}

function collectPotentialSpecPaths(value: unknown, output = new Set<string>()): Set<string> {
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
    for (const item of Object.values(value as Record<string, unknown>)) collectPotentialSpecPaths(item, output);
  }
  return output;
}

function recordSpecAccessFromUnknown(value: unknown, specAccesses: Map<string, SpecClassification>) {
  for (const candidate of collectPotentialSpecPaths(value)) {
    const classification = classifySpecPath(candidate);
    if (classification.spec_scope !== "unknown") specAccesses.set(classification.doc_path, classification);
  }
}

function parseChatSessionRequest(
  request: unknown,
  messages: CapturedConversationMessage[],
  processSteps: CapturedProcessStep[],
  source: string,
  requestKey: string,
  fileReads?: Map<string, FileReadRecord>,
  codeEdits?: CodeEditRecord[]
) {
  if (!request || typeof request !== "object") return;
  const record = request as Record<string, unknown>;
  const stableRequestKey = String(record.requestId || record.id || record.request_id || requestKey);
  const userText = userTextFromChatSessionRequest(record);
  const occurredAt = isoTimeFromUnknown(record.timestamp ?? record.createdAt);
  if (userText) pushParsedMessage(messages, "user", userText, source, `${stableRequestKey}:user`, occurredAt);
  const responseParts = Array.isArray(record.response)
    ? record.response
    : record.result && typeof record.result === "object" && Array.isArray((record.result as Record<string, unknown>).response)
      ? ((record.result as Record<string, unknown>).response as unknown[])
      : undefined;
  const assistantText = assistantTextFromResponseParts(responseParts);
  if (assistantText) pushParsedMessage(messages, "assistant", assistantText, source, `${stableRequestKey}:assistant`);
  processStepsFromResponseParts(responseParts, processSteps, source, fileReads);
  if (codeEdits) collectCodeEditsFromUnknown(record, codeEdits, source);
}

function parseChatSessionPatch(
  entry: Record<string, unknown>,
  messages: CapturedConversationMessage[],
  processSteps: CapturedProcessStep[],
  source: string,
  fileReads?: Map<string, FileReadRecord>,
  codeEdits?: CodeEditRecord[]
) {
  if (entry.kind === 0 && entry.v && typeof entry.v === "object") {
    const snapshot = entry.v as Record<string, unknown>;
    if (Array.isArray(snapshot.requests)) {
      snapshot.requests.forEach((request, index) =>
        parseChatSessionRequest(request, messages, processSteps, source, `request:${index}`, fileReads, codeEdits)
      );
    }
    return;
  }

  const keyPath = Array.isArray(entry.k) ? entry.k : [];
  if (keyPath.length === 1 && keyPath[0] === "requests" && Array.isArray(entry.v)) {
    entry.v.forEach((request, index) =>
      parseChatSessionRequest(request, messages, processSteps, source, `request:${index}`, fileReads, codeEdits)
    );
    return;
  }
  if (keyPath.length === 3 && keyPath[0] === "requests" && keyPath[2] === "response") {
    const assistantText = assistantTextFromResponseParts(entry.v);
    if (assistantText) pushParsedMessage(messages, "assistant", assistantText, source, `request:${String(keyPath[1])}:assistant`);
    processStepsFromResponseParts(entry.v, processSteps, source, fileReads);
    if (codeEdits) collectCodeEditsFromUnknown(entry.v, codeEdits, source);
  }
  if (keyPath.length >= 2 && keyPath[0] === "requests") {
    if (codeEdits) collectCodeEditsFromUnknown(entry.v, codeEdits, source);
  }
}

async function parseCopilotTranscriptFile(sessionFile: string, transcriptKind: string): Promise<ParsedCopilotTranscript | undefined> {
  let content: string;
  try {
    content = await readFile(sessionFile, "utf8");
  } catch {
    return undefined;
  }

  const messages: CapturedConversationMessage[] = [];
  const processSteps: CapturedProcessStep[] = [];
  let sessionId = basename(sessionFile, ".jsonl");
  let toolCallCount = 0;
  let toolResultCount = 0;
  let turnStartedCount = 0;
  let turnCompletedCount = 0;
  let turnAbortedCount = 0;
  let patchApplyCount = 0;
  let patchSuccessCount = 0;
  let startedAt: string | undefined;
  const patchToolCallIds = new Set<string>();
  const specAccesses = new Map<string, SpecClassification>();
  const fileReads = new Map<string, FileReadRecord>();
  const codeEdits: CodeEditRecord[] = [];
  const mutationEntries: Record<string, unknown>[] = [];
  const source = transcriptKind === "github-copilot-transcript" ? "copilot_local_transcript" : "copilot_chat_session";

  let lineIndex = 0;
  for (const line of content.split(/\r?\n/)) {
    lineIndex += 1;
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof entry.type === "string" ? entry.type : "";
    const data = entry.data && typeof entry.data === "object" ? (entry.data as Record<string, unknown>) : {};
    if (type === "session.start") {
      sessionId = String(data.sessionId || sessionId);
      if (typeof data.startTime === "string") startedAt = data.startTime;
    } else if (type === "user.message") {
      const eventKey = String(data.requestId || data.messageId || data.id || `line:${lineIndex}`);
      pushParsedMessage(
        messages,
        "user",
        textFromUnknown(data.content),
        source,
        `${eventKey}:user`,
        typeof data.timestamp === "string" ? data.timestamp : undefined
      );
    } else if (type === "assistant.message") {
      const eventKey = String(data.requestId || data.messageId || data.id || `line:${lineIndex}`);
      pushParsedMessage(
        messages,
        "assistant",
        textFromUnknown(data.content),
        source,
        `${eventKey}:assistant`,
        typeof data.timestamp === "string" ? data.timestamp : undefined
      );
      if (Array.isArray(data.toolRequests)) toolCallCount += data.toolRequests.length;
      collectCodeEditsFromUnknown(data.toolRequests, codeEdits, source);
      processStepsFromResponseParts(data.content, processSteps, source, fileReads);
    } else if (type === "tool.execution_start") {
      toolCallCount += 1;
      const rawToolName = readableValue(data.toolName || data.name || data.invocationMessage, "tool");
      const toolName = rawToolName.toLowerCase();
      const toolCallId = String(data.toolCallId || "");
      collectFileReadsFromUnknown(data, fileReads, source, rawToolName);
      collectCodeEditsFromUnknown(data, codeEdits, source, rawToolName);
      if (toolName.includes("patch") || toolName.includes("edit") || toolName.includes("replace")) {
        patchApplyCount += 1;
        if (toolCallId) patchToolCallIds.add(toolCallId);
        pushProcessStep(processSteps, "patch_apply", readableValue(data.message || data.input || data.toolName, "Patch apply"), source, {
          tool_name: rawToolName || "patch",
          status: "running"
        });
      } else {
        pushProcessStep(processSteps, "tool_call", readableValue(data.message || data.input || data.toolName, "Tool call"), source, {
          tool_name: rawToolName || "tool",
          status: "running"
        });
      }
    } else if (type === "tool.execution_complete") {
      toolResultCount += 1;
      const toolCallId = String(data.toolCallId || "");
      const rawToolName = readableValue(data.toolName || data.name || data.invocationMessage, "tool");
      collectFileReadsFromUnknown(data, fileReads, source, rawToolName);
      if (patchToolCallIds.has(toolCallId)) {
        if (data.success === true) patchSuccessCount += 1;
        pushProcessStep(processSteps, "patch_result", readableValue(data.message || data.output || data.error, "Patch result"), source, {
          tool_name: rawToolName || "patch",
          status: data.success === true ? "success" : "complete"
        });
      } else {
        pushProcessStep(processSteps, "tool_result", readableValue(data.message || data.output || data.error, "Tool result"), source, {
          tool_name: rawToolName || "tool",
          status: data.success === false ? "failed" : "complete"
        });
      }
    } else if (type === "assistant.turn_start") {
      turnStartedCount += 1;
    } else if (type === "assistant.turn_end") {
      turnCompletedCount += 1;
    } else if (type.includes("abort") || type.includes("cancel")) {
      turnAbortedCount += 1;
    }

    if (typeof entry.kind === "number") {
      mutationEntries.push(entry);
      if (entry.kind === 0 && entry.v && typeof entry.v === "object") {
        const snapshot = entry.v as Record<string, unknown>;
        if (typeof snapshot.sessionId === "string" && snapshot.sessionId) sessionId = snapshot.sessionId;
        if (!startedAt) {
          if (typeof snapshot.creationDate === "string") startedAt = snapshot.creationDate;
          if (typeof snapshot.creationDate === "number") startedAt = new Date(snapshot.creationDate).toISOString();
        }
      }
      parseChatSessionPatch(entry, messages, processSteps, source, fileReads, codeEdits);
    }
  }

  const deduped = dedupeMessages(messages);
  const dedupedProcessSteps = dedupeProcessSteps(processSteps);
  if (deduped.length === 0) return undefined;
  const usage = parseCopilotRequestUsage(mutationEntries);
  sessionId = usage.sessionId || sessionId;
  startedAt = usage.startedAt || startedAt;
  for (const read of fileReads.values()) {
    const classification = classifySpecPath(read.path);
    if (classification.spec_scope !== "unknown") specAccesses.set(classification.doc_path, classification);
  }
  return {
    sessionId,
    sessionFile,
    transcriptKind,
    contentHash: hashText(content),
    messageSignature: messageSignature(deduped),
    processSignature: processSignature(dedupedProcessSteps),
    messages: deduped,
    processSteps: dedupedProcessSteps,
    toolCallCount,
    toolResultCount,
    turnStartedCount,
    turnCompletedCount,
    turnAbortedCount,
    patchApplyCount,
    patchSuccessCount,
    specAccesses: [...specAccesses.values()],
    fileReads: [...fileReads.values()],
    codeEdits: dedupeCodeEdits(codeEdits),
    startedAt,
    title: usage.title,
    resolvedModel: usage.resolvedModel,
    requestUsage: usage.requestUsage,
    usageTotals: usage.usageTotals,
    requestCount: usage.requestCount,
    usageSignature: hashText(JSON.stringify(usage.requestUsage))
  };
}

async function captureCopilotLocalTranscripts(options: { silent?: boolean; includeHistory?: boolean } = {}) {
  const context = extensionContext;
  if (!context) {
    if (!options.silent) vscode.window.showWarningMessage("TinyAI Observability cannot locate VS Code workspaceStorage yet.");
    return;
  }

  const cfg = config();
  const roots = await workspaceStorageRoots();
  const maxAgeMs = Math.max(1, cfg.autoCaptureRecentMinutes) * 60_000;
  const newestAllowedMtime = options.includeHistory ? 0 : Date.now() - maxAgeMs;
  const workspaceFiles = (
    await Promise.all(
      roots.map(async (root) => [
        ...(await listJsonlFiles(join(root, "GitHub.copilot-chat", "transcripts"), "github-copilot-transcript")),
        ...(await listJsonlFiles(join(root, "chatSessions"), "vscode-chat-session"))
      ])
    )
  ).flat();
  const files = [...(await globalChatSessionFiles()), ...workspaceFiles]
    .filter((file) => file.mtimeMs >= newestAllowedMtime)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  const seen = { ...(context.workspaceState.get<CopilotTurnCaptureStateStore>(COPILOT_TRANSCRIPT_STATE_KEY) || {}) };
  const cursors = { ...(context.workspaceState.get<CopilotSessionCursorStore>(COPILOT_SESSION_CURSOR_STATE_KEY) || {}) };
  const bySession = new Map<
    string,
    {
      chat?: { path: string; transcriptKind: string; mtimeMs: number; size: number };
      transcript?: { path: string; transcriptKind: string; mtimeMs: number; size: number };
    }
  >();
  let parseErrorCount = 0;
  let seenChanged = false;
  for (const file of files) {
    const sessionId = basename(file.path, ".jsonl");
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
  for (const [sessionKey, { chat, transcript }] of bySession.entries()) {
    if (!chat) {
      skippedWithoutChatSession += 1;
      continue;
    }
    const newestSourceMtime = Math.max(chat.mtimeMs, transcript?.mtimeMs || 0);
    if (now - newestSourceMtime < 5_000) {
      skippedTooRecent += 1;
      continue;
    }
    const chatFingerprint = fileFingerprint(chat);
    const transcriptFingerprint = fileFingerprint(transcript);
    const cursor = cursors[sessionKey];
    const replayInitializedAtEof = !options.includeHistory && cursor?.initialized_at_eof === true;
    if (
      !options.includeHistory &&
      !replayInitializedAtEof &&
      cursor?.chat_fingerprint === chatFingerprint &&
      cursor?.transcript_fingerprint === transcriptFingerprint
    ) {
      skippedUnchanged += 1;
      continue;
    }
    try {
      const checkpoint = !options.includeHistory && !replayInitializedAtEof
        ? await readCopilotCheckpoint(sessionKey, cursor, chat, chatFingerprint)
        : undefined;
      const replayFromCheckpoint = Boolean(checkpoint);
      const { chatReadOffset, transcriptReadOffset } = checkpoint
        ? {
            chatReadOffset: checkpoint.chat_read_offset,
            transcriptReadOffset: 0
          }
        : copilotReplayOffsets({
            includeHistory: options.includeHistory,
            replayInitializedAtEof,
            chatReadOffset: cursor?.chat_read_offset,
            transcriptReadOffset: cursor?.transcript_read_offset
          });
      const chatRead = await readJsonlRecords(chat.path, chatReadOffset);
      const transcriptRead = transcript ? await readJsonlRecords(transcript.path, transcriptReadOffset) : undefined;
      const chatEntries = chatRead.records;
      const transcriptEntries = transcriptRead?.records;
      const replayState = replayCopilotChatSessionState(chatEntries, checkpoint?.replay_state);
      const snapshots = buildCopilotTurnSnapshotsFromReplayState({
        replay_state: replayState,
        transcript_entries: transcriptEntries,
        chat_file: await sourceFileInfo(chat.path, chat.mtimeMs, chat.size, undefined, chatReadOffset),
        transcript_file: transcript ? await sourceFileInfo(transcript.path, transcript.mtimeMs, transcript.size, undefined, transcriptReadOffset) : undefined
      });
      for (const snapshot of snapshots) {
        const seenKey = `turn:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}:${COPILOT_CAPTURE_CAPABILITY}`;
        const signature = copilotTurnSignature(snapshot);
        if (queuedOrAcknowledgedSignature(seen[seenKey]) === signature) continue;
        const taskId = `copilot-local-${snapshot.session_id}`.slice(0, 64);
        const turnClientId = clientId("copilot", userIdentity());
        const eventId = copilotTurnEventId(snapshot, turnClientId);
        const nowIso = new Date().toISOString();
        const cwd = workspacePath();
        const specAccesses = await specAccessesFromCopilotTurn(snapshot, cwd);
        const specDocuments = await projectSpecDocuments(cwd);
        eventForTask(
          taskId,
          "turn_snapshot",
          {
            ...snapshot,
            cwd,
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
          first_seen_at: typeof seen[seenKey] === "object" ? (seen[seenKey] as CopilotTurnCaptureState).first_seen_at : nowIso,
          last_attempt_at: nowIso,
          error_count: typeof seen[seenKey] === "object" ? (seen[seenKey] as CopilotTurnCaptureState).error_count || 0 : 0
        };
        pendingTurnStateKeysByEventId.set(eventId, seenKey);
        seenChanged = true;
        uploaded += 1;
        capturedMessages += 2;
      }
      const savedCheckpoint = await writeCopilotCheckpoint(sessionKey, chat, chatRead.nextOffset, chatFingerprint, replayState);
      cursors[sessionKey] = {
        chat_fingerprint: chatFingerprint,
        transcript_fingerprint: transcriptFingerprint,
        chat_read_offset: chatRead.nextOffset,
        transcript_read_offset: transcriptRead?.nextOffset,
        checkpoint_path: savedCheckpoint.path,
        checkpoint_hash: savedCheckpoint.hash,
        checkpoint_parser_version: COPILOT_TURN_PARSER_VERSION,
        initialized_at_eof: false,
        processed_at: new Date().toISOString(),
        ...(replayFromCheckpoint ? { replay_mode: "checkpoint" } : {})
      };
      cursorChanged = true;
    } catch (error) {
      parseErrorCount += 1;
      console.warn("TinyAI Observability failed to build Copilot turn snapshots", chat.path, error);
      continue;
    }
  }
  lastCopilotCaptureDiagnostics = {
    scanned_at: new Date().toISOString(),
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
      uploaded > 0
        ? `TinyAI captured ${uploaded} Copilot turn snapshot(s) (${capturedMessages} top-level messages).`
        : `TinyAI found no completed Copilot turns ready in the last ${cfg.autoCaptureRecentMinutes} minute(s). Parsed ${bySession.size} session(s), ${parseErrorCount} parse error(s).`
    );
  }
  if (options.silent || uploaded === 0) {
    void heartbeat();
  }
}

function claudeTurnSignature(snapshot: ClaudeTurnSnapshot): string {
  return hashText(
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

function claudeTurnEventId(snapshot: ClaudeTurnSnapshot, turnClientId: string): string {
  return stableEventId(`claude:turn:${turnClientId}:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}`);
}

async function claudeJsonlFiles(options: { includeHistory?: boolean } = {}) {
  const cfg = config();
  const maxAgeMs = Math.max(1, cfg.autoCaptureRecentMinutes) * 60_000;
  const newestAllowedMtime = options.includeHistory ? 0 : Date.now() - maxAgeMs;
  const roots = [
    join(homedir(), ".claude", "projects"),
    join(homedir(), ".claude", "transcripts")
  ];
  const files = (await Promise.all(roots.map((root) => listJsonlFilesRecursive(root, "claude-project-jsonl", 4))))
    .flat()
    .filter((file) => !file.path.replace(/\\/g, "/").toLowerCase().includes("/subagents/"))
    .filter((file) => file.mtimeMs >= newestAllowedMtime)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return files;
}

async function captureClaudeLocalTranscripts(options: { silent?: boolean; includeHistory?: boolean } = {}) {
  const context = extensionContext;
  if (!context) {
    if (!options.silent) vscode.window.showWarningMessage("TinyAI Observability cannot locate VS Code extension state yet.");
    return;
  }
  const files = await claudeJsonlFiles(options);
  const seen = { ...(context.globalState.get<CopilotTurnCaptureStateStore>(CLAUDE_TRANSCRIPT_STATE_KEY) || {}) };
  const cursors = { ...(context.globalState.get<CopilotSessionCursorStore>(CLAUDE_SESSION_CURSOR_STATE_KEY) || {}) };
  const now = Date.now();
  let uploaded = 0;
  let parseErrorCount = 0;
  let seenChanged = false;
  let cursorChanged = false;

  for (const file of files) {
    if (now - file.mtimeMs < 5_000) continue;
    const fingerprint = fileFingerprint(file, CLAUDE_CAPTURE_CAPABILITY);
    const cursorKey = file.path;
    const cursor = cursors[cursorKey];
    if (!options.includeHistory && !cursor?.chat_read_offset) {
      cursors[cursorKey] = {
        chat_fingerprint: fingerprint,
        chat_read_offset: file.size,
        initialized_at_eof: true,
        processed_at: new Date().toISOString()
      };
      cursorChanged = true;
      continue;
    }
    if (!options.includeHistory && cursor?.chat_fingerprint === fingerprint) continue;
    try {
      const snapshots = await captureLatestClaudeTurnSnapshots({
        sessionFile: file.path,
        latestOnly: false,
        includeText: config().captureConversationText,
        startOffset: options.includeHistory ? 0 : cursor?.chat_read_offset || 0
      });
      let committedOffset = cursor?.chat_read_offset || 0;
      for (const snapshot of snapshots) {
        if (snapshot.turn.status === "incomplete") {
          continue;
        }
        const cwd = snapshot.cwd || workspacePath();
        const seenKey = `claude-turn:${snapshot.session_id}:${snapshot.request_id}:${snapshot.response_id}:${CLAUDE_CAPTURE_CAPABILITY}`;
        const signature = claudeTurnSignature(snapshot);
        if (queuedOrAcknowledgedSignature(seen[seenKey]) === signature) continue;
        const identity = userIdentity();
        const turnClientId = clientId("claude", identity);
        const eventId = claudeTurnEventId(snapshot, turnClientId);
        const taskId = `claude-local-${snapshot.session_id}`.slice(0, 64);
        const nowIso = new Date().toISOString();
        const specAccesses = await specAccessesFromCopilotTurn(snapshot, cwd);
        const specDocuments = await projectSpecDocuments(cwd);
        eventForTask(
          taskId,
          "turn_snapshot",
          {
            ...snapshot,
            cwd,
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
          cwd
        );
        await recordClaudeTurnEditorDelta(snapshot, taskId, turnClientId);
        await markAiActivity(cwd, { tool: "claude", source: "claude_turn_snapshot" });
        seen[seenKey] = {
          event_id: eventId,
          signature,
          status: "queued",
          collector_url_hash: currentCollectorHash(),
          first_seen_at: typeof seen[seenKey] === "object" ? (seen[seenKey] as CopilotTurnCaptureState).first_seen_at : nowIso,
          last_attempt_at: nowIso,
          error_count: typeof seen[seenKey] === "object" ? (seen[seenKey] as CopilotTurnCaptureState).error_count || 0 : 0
        };
        pendingTurnStateKeysByEventId.set(eventId, seenKey);
        seenChanged = true;
        uploaded += 1;
        const nextOffset = Number(snapshot.source_files?.claude_project_jsonl?.next_offset);
        if (Number.isFinite(nextOffset) && nextOffset > committedOffset) {
          committedOffset = nextOffset;
        }
      }
      if (committedOffset > (cursor?.chat_read_offset || 0)) {
        cursors[cursorKey] = {
          chat_fingerprint: fingerprint,
          chat_read_offset: committedOffset,
          initialized_at_eof: false,
          processed_at: new Date().toISOString()
        };
        cursorChanged = true;
      }
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
      uploaded > 0
        ? `TinyAI captured ${uploaded} Claude turn snapshot(s).`
        : `TinyAI found no completed Claude turns ready in the last ${config().autoCaptureRecentMinutes} minute(s). Parsed ${files.length} file(s), ${parseErrorCount} parse error(s).`
    );
  }
}

function applyTurnUploadResult(seen: CopilotTurnCaptureStateStore, result: BatchUploadResult | undefined) {
  if (!result?.events) return;
  const nowIso = new Date().toISOString();
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
        last_error: undefined
      };
      pendingTurnStateKeysByEventId.delete(eventResult.event_id);
    } else {
      seen[seenKey] = {
        ...current,
        status: result.queued ? "queued" : "failed",
        error_count: (current.error_count || 0) + 1,
        last_error: eventResult.reason || "upload_failed"
      };
    }
  }
}

async function flush(): Promise<BatchUploadResult | undefined> {
  if (!pendingEvents.length) return undefined;
  const toUpload = pendingEvents.splice(0, pendingEvents.length);
  const grouped = new Map<ObservabilityEvent["tool"], ObservabilityEvent[]>();
  for (const item of toUpload) {
    const bucket = grouped.get(item.tool) || [];
    bucket.push(item);
    grouped.set(item.tool, bucket);
  }
  let merged: BatchUploadResult | undefined;
  for (const [tool, events] of grouped.entries()) {
    const result = await client(tool).upload(tool, events);
    merged = {
      accepted: (merged?.accepted || 0) + (result.accepted || 0),
      duplicates: (merged?.duplicates || 0) + (result.duplicates || 0),
      failed: (merged?.failed || 0) + (result.failed || 0),
      task_count: (merged?.task_count || 0) + (result.task_count || 0),
      queued: Boolean(merged?.queued || result.queued),
      events: [...(merged?.events || []), ...(result.events || [])]
    };
  }
  return merged;
}

async function flushDiskQueues() {
  for (const tool of QUEUE_FLUSH_TOOLS) {
    try {
      await client(tool).flushQueue(tool);
    } catch (error) {
      console.warn(`TinyAI Observability failed to flush ${tool} queue`, error);
    }
  }
}

async function heartbeat() {
  const cfg = config();
  const identity = userIdentity();
  const heartbeatSignature = hashText(
    JSON.stringify({
      plugin_version: PLUGIN_VERSION,
      workspace: workspacePath(),
      user_id: identity.user_id || identity.username,
      auto_capture: cfg.autoCaptureCopilotLocalTranscripts,
      auto_capture_claude: cfg.autoCaptureClaudeLocalTranscripts,
      queue_flush_interval_seconds: cfg.queueFlushIntervalSeconds,
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
      queue_flush_interval_seconds: config().queueFlushIntervalSeconds,
      capture_conversation_text: config().captureConversationText,
      capture_visible_reasoning_text: config().captureVisibleReasoningText,
      auto_capture_recent_minutes: config().autoCaptureRecentMinutes,
      diagnostics: {
        copilot_capture: lastCopilotCaptureDiagnostics
      }
    },
    "direct",
    stableEventId(`copilot:plugin_heartbeat:${heartbeatSignature}:${new Date().toISOString().slice(0, 16)}`)
  );
  await flush();
}

function updateStatus() {
  const cfg = config();
  statusBar.text = currentTaskId ? "TinyAI Obs: Task" : "TinyAI Obs: Auto";
  statusBar.tooltip = currentTaskId
    ? `Current task: ${currentTaskId}`
    : cfg.autoCaptureCopilotLocalTranscripts || cfg.autoCaptureClaudeLocalTranscripts
      ? `Auto-capturing recent Copilot/Claude sessions every 15s; queue flush every ${Math.max(5, cfg.queueFlushIntervalSeconds)}s; window: ${cfg.autoCaptureRecentMinutes} min.`
      : `TinyAI transcript capture is disabled; queue flush still runs every ${Math.max(5, cfg.queueFlushIntervalSeconds)}s.`;
  statusBar.command = "tinyaiObservability.showMenu";
  panelProvider?.refresh();
}

async function configure() {
  const cfg = config();
  const userName = await vscode.window.showInputBox({ title: "TinyAI user name", value: cfg.userName, prompt: "用于监控面板按人聚合，例如：张三 / lyl / Alice" });
  if (userName) await vscode.workspace.getConfiguration("tinyaiObservability").update("userName", userName, vscode.ConfigurationTarget.Global);
  if (!cfg.collectorUrl) {
    await vscode.workspace.getConfiguration("tinyaiObservability").update("collectorUrl", DEFAULT_COLLECTOR_URL, vscode.ConfigurationTarget.Global);
  }
  await heartbeat();
  vscode.window.showInformationMessage("TinyAI Observability configured. Reload VS Code once to apply the latest extension settings.");
}

async function remindMissingUserName(context: vscode.ExtensionContext) {
  const cfg = config();
  if (cfg.userName) return;
  const reminderKey = "tinyaiObservability.userNameReminderShown";
  if (context.globalState.get<boolean>(reminderKey)) return;
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

async function firstReachableUrl(urls: string[]): Promise<string> {
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(1_500)
      });
      if (response.ok) return url;
    } catch {
      // Try the next known dashboard address.
    }
  }
  return urls[0];
}

async function openPanel() {
  await vscode.commands.executeCommand("workbench.view.extension.tinyaiObservability");
  await vscode.commands.executeCommand("tinyaiObservability.actionsView.focus");
}

async function startTask() {
  currentTaskId = randomUUID();
  conversationMessages.splice(0, conversationMessages.length);
  event("task_start", { trigger: "vscode_command" });
  updateStatus();
  await flush();
  vscode.window.showInformationMessage("TinyAI Observability task started.");
}

function matchedByCountsFor(results: Array<{ matched_by?: string[] }>) {
  return results.reduce<Record<string, number>>((counts, result) => {
    for (const match of result.matched_by || []) counts[match] = (counts[match] || 0) + 1;
    return counts;
  }, {});
}

function fallbackTinyAIResponse(prompt: string, results: Array<{ path: string; excerpt: string; matched_by?: string[] }>) {
  if (results.length === 0) {
    return `TinyAI did not find matching specs for this request.\n\nRequest: ${prompt}`;
  }
  const top = results
    .slice(0, 3)
    .map((result, index) => `${index + 1}. ${result.path}\n${result.excerpt.trim()}`)
    .join("\n\n");
  return `TinyAI found relevant specs and recorded telemetry.\n\n${top}`;
}

async function callLanguageModel(
  prompt: string,
  results: Array<{ path: string; excerpt: string; matched_by?: string[] }>,
  token?: vscode.CancellationToken,
  preferredModel?: { sendRequest: (messages: unknown[], options: Record<string, unknown>, token?: vscode.CancellationToken) => Promise<{ text: AsyncIterable<string> }> }
) {
  const lmApi = (vscode as any).lm;
  const Message = (vscode as any).LanguageModelChatMessage;
  if (!lmApi?.selectChatModels || !Message?.User) return fallbackTinyAIResponse(prompt, results);

  const models = preferredModel
    ? [preferredModel]
    : ((await lmApi.selectChatModels({ vendor: "copilot" }).catch(() => [])) ||
      (await lmApi.selectChatModels().catch(() => [])));
  const model = models[0];
  if (!model) return fallbackTinyAIResponse(prompt, results);

  const modelId: string | undefined = (model as any).id || (model as any).name || undefined;
  if (modelId) currentModel = modelId;

  const context = results
    .slice(0, 5)
    .map((result: { path: string; excerpt: string }, index: number) => `Spec ${index + 1}: ${result.path}\n${result.excerpt}`)
    .join("\n\n");
  const request = [
    Message.User(
      [
        "You are TinyAI, a coding assistant that must ground answers in project personal specs when available.",
        "Use the provided specs context first. If context is insufficient, say what is missing.",
        "",
        `User request:\n${prompt}`,
        "",
        `Specs context:\n${context || "No matching specs found."}`
      ].join("\n")
    )
  ];

  try {
    const response = await model.sendRequest(request, {}, token);
    let text = "";
    for await (const chunk of response.text) text += chunk;
    return text.trim() || fallbackTinyAIResponse(prompt, results);
  } catch (error) {
    return `${fallbackTinyAIResponse(prompt, results)}\n\nLanguage model request failed: ${String(error)}`;
  }
}

async function runTinyAIProxyPrompt(prompt: string, source: string, token?: vscode.CancellationToken, preferredModel?: Parameters<typeof callLanguageModel>[3]) {
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
  currentTaskId = undefined;
  updateStatus();
  await flush();
  vscode.window.showInformationMessage(`TinyAI Observability task ended: ${endedTask}`);
}

async function captureClipboardConversation() {
  if (!currentTaskId) {
    currentTaskId = randomUUID();
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
    currentTaskId = randomUUID();
    event("task_start", { trigger: "capture_active_editor_conversation" });
    updateStatus();
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Open or paste a conversation transcript in an editor first.");
    return;
  }
  const selections = editor.selections
    .filter((selection) => !selection.isEmpty)
    .map((selection) => editor.document.getText(selection))
    .join("\n\n");
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
  event(kind as "user_correction" | "regenerate" | "interruption" | "official_misread", { reason: reason || undefined }, "direct");
  await flush();
}

async function adoptionSnapshot() {
  if (!currentTaskId) {
    vscode.window.showInformationMessage("Start a TinyAI Observability task first.");
    return;
  }
  const generated = Number(await vscode.window.showInputBox({ title: "Generated lines", validateInput: (value) => (Number.isFinite(Number(value)) ? null : "Enter a number") }));
  if (!Number.isFinite(generated)) return;
  const retained = Number(await vscode.window.showInputBox({ title: "Retained lines", validateInput: (value) => (Number.isFinite(Number(value)) ? null : "Enter a number") }));
  if (!Number.isFinite(retained)) return;
  event(
    "adoption_snapshot",
    {
      lines_added: generated,
      retained_lines: retained,
      adoption_rate: generated > 0 ? retained / generated : undefined,
      snapshot_kind: "vscode_manual_retention_check"
    },
    "direct"
  );
  await flush();
}

async function recordCommitSnapshot(options: { silent?: boolean } = {}) {
  const snapshot = await commitSnapshot(workspacePath(), "HEAD", {
    aiAssisted: true,
    attributionEvidence: "manual_vscode_commit_snapshot"
  });
  pendingEvents.push(makeEvent({
    tool: "git",
    eventType: "commit_snapshot",
    taskId: snapshot.commit_sha ? `commit-${snapshot.commit_sha.slice(0, 16)}` : undefined,
    workspacePath: workspacePath(),
    payload: { ...snapshot, source: "vscode_command", hook_tool: "git", hook_installer_tool: "copilot" },
    sourceConfidence: "derived",
    eventId: snapshot.commit_sha ? stableEventId(`git:commit_snapshot:${workspacePath()}:${snapshot.commit_sha}`) : undefined,
    userIdentity: userIdentity()
  }));
  updateStatus();
  await flush();
  if (!options.silent) {
    vscode.window.showInformationMessage(
      `TinyAI recorded commit snapshot: ${snapshot.ai_lines_added} AI-added line(s), ${snapshot.files_changed} file(s).`
    );
  }
}

async function recordAiLinesSnapshot(options: { silent?: boolean } = {}) {
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

async function recordPushSnapshot(options: { silent?: boolean } = {}) {
  const snapshot = await pushSnapshot(workspacePath(), {
    aiAssisted: true,
    attributionEvidence: "manual_vscode_push_snapshot"
  });
  const rangeKey = snapshot.head_sha ? `${snapshot.upstream_ref || ""}:${snapshot.base_sha || ""}:${snapshot.head_sha}` : "";
  pendingEvents.push(makeEvent({
    tool: "git",
    eventType: "push_snapshot",
    taskId: snapshot.head_sha ? `push-${snapshot.head_sha.slice(0, 16)}` : undefined,
    workspacePath: workspacePath(),
    payload: { ...snapshot, source: "vscode_command", hook_tool: "git", hook_installer_tool: "copilot" },
    sourceConfidence: "derived",
    eventId: rangeKey ? stableEventId(`git:push_snapshot:${workspacePath()}:${rangeKey}`) : undefined,
    userIdentity: userIdentity()
  }));
  updateStatus();
  await flush();
  if (!options.silent) {
    vscode.window.showInformationMessage(
      `TinyAI recorded push/PR snapshot: ${snapshot.ai_lines_added} AI-added line(s), ${snapshot.commit_count} commit(s).`
    );
  }
}

async function installGitHooksForWorkspace(options: { silent?: boolean; emitHeartbeat?: boolean } = {}) {
  try {
    const cfg = config();
    const result = await installGitHooks(workspacePath(), {
      tool: "copilot",
      collectorUrl: cfg.collectorUrl,
      fallbackUrls: cfg.collectorFallbackUrls,
      token: cfg.token || undefined,
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
      { label: "Configure User", detail: "配置姓名，确保采集数据归到正确用户。", command: "configure" }
    ],
    { title: "TinyAI Observability" }
  );
  if (!choice) return;
  if (choice.command === "configure") await configure();
}

class ObservabilityPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml();
    view.webview.onDidReceiveMessage(async (message) => {
      if (message?.command === "configure") await configure();
      this.refresh();
    });
  }

  refresh(latestResponse?: string) {
    if (this.view) this.view.webview.html = this.renderHtml(latestResponse);
  }

  private renderHtml(_latestResponse = "") {
    const cfg = config();
    const identity = userIdentity();
    const userLabel = identity.user_display_name || identity.username || "未配置";
    const taskText = currentTaskId ? `活动中：${currentTaskId.slice(0, 8)}` : "自动采集中";
    const enabledSources = [
      cfg.autoCaptureCopilotLocalTranscripts ? "Copilot" : undefined,
      cfg.autoCaptureClaudeLocalTranscripts ? "Claude" : undefined
    ].filter(Boolean).join(" / ");
    const autoText = enabledSources
      ? `已开启，每 15 秒扫描最近 ${cfg.autoCaptureRecentMinutes} 分钟的 ${enabledSources} 本地会话；本地失败队列每 ${Math.max(5, cfg.queueFlushIntervalSeconds)} 秒独立补发。`
      : `会话自动扫描已关闭；本地失败队列仍每 ${Math.max(5, cfg.queueFlushIntervalSeconds)} 秒独立补发。`;
    const collectorLabel = cfg.collectorUrl || DEFAULT_COLLECTOR_URL;
    return /* html */ `<!doctype html>
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
    <div class="label">采集状态</div>
    <div class="value">${escapeHtml(taskText)}</div>
    <div class="hint">${escapeHtml(autoText)}</div>
    <div class="pill-row">
      <span class="pill">turn_snapshot</span>
      <span class="pill">code_change</span>
      <span class="pill">commit_snapshot</span>
    </div>
  </div>
  <div class="status">
    <div class="label">当前用户</div>
    <div class="value">${escapeHtml(userLabel)}</div>
    <div class="hint">所有 session 会按这个用户聚合。Collector：${escapeHtml(collectorLabel)}</div>
  </div>
  <div class="status">
    <div class="label">代码归因</div>
    <div class="value">Commit 后自动计算 AI / Human 占比</div>
    <div class="hint">不需要手动标记当前 diff。AI 证据来自 Copilot / Claude 会话，commit 全量 diff 由 Git hook 自动上传，collector 按文件、行类型和 text_hash 匹配。</div>
  </div>
  <div class="section">需要时配置</div>
  <button data-command="configure">Configure User</button>
  <p>正常使用 Copilot、Claude Code / Claude CLI 和 git commit 即可自动采集。一般情况下不需要手动操作。</p>
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll("button[data-command]").forEach((button) => {
      button.addEventListener("click", () => vscode.postMessage({ command: button.dataset.command }));
    });
  </script>
</body>
</html>`;
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] || char));
}

function recordSpecAccess(uri: vscode.Uri) {
  if (!currentTaskId) return;
  const path = vscode.workspace.asRelativePath(uri, false);
  const classification = classifySpecPath(path);
  if (classification.spec_scope === "unknown") return;
  event("spec_read", { ...classification }, classification.via_catalog ? "direct" : "derived");
}

function registerChatSurface(context: vscode.ExtensionContext) {
  const chatApi = (vscode as any).chat;
  if (chatApi?.createChatParticipant) {
    const participant = chatApi.createChatParticipant("tinyai.tinyai-observability-copilot.tinyai", async (request: any, _context: any, stream: any, token: vscode.CancellationToken) => {
      const prompt = String(request?.prompt || "");
      const responseText = await runTinyAIProxyPrompt(prompt, "chat_participant", token, request?.model);
      stream.markdown(responseText || "TinyAI did not receive a prompt.");
    });
    participant.iconPath = new vscode.ThemeIcon("book");
    participant.followupProvider = {
      provideFollowups() {
        return [
          { prompt: "继续按个人 specs 完成实现并记录采纳快照", label: "Continue with specs" },
          { prompt: "结束当前 TinyAI 任务并上传 diff 快照", label: "End TinyAI task" }
        ];
      }
    };
    context.subscriptions.push(participant);
  }

  const lmApi = (vscode as any).lm;
  if (lmApi?.registerTool && (vscode as any).LanguageModelToolResult && (vscode as any).LanguageModelTextPart) {
    const disposable = lmApi.registerTool("tinyai_specs", {
      async invoke(options: any) {
        const query = String(options?.input?.query || "");
        await ensureTask("lm_tool");
        const results = await searchSpecs(workspacePath(), query).catch(() => []);
        const matchedByCounts = results.reduce<Record<string, number>>((counts, result) => {
          for (const match of result.matched_by || []) counts[match] = (counts[match] || 0) + 1;
          return counts;
        }, {});
        event(
          results.length > 0 ? "catalog_hit" : "fallback_search",
          { query_hash: query ? "present" : "empty", result_count: results.length, source: "lm_tool", matched_by_counts: matchedByCounts },
          "direct"
        );
        return new (vscode as any).LanguageModelToolResult([
          new (vscode as any).LanguageModelTextPart(JSON.stringify({ results }, null, 2))
        ]);
      }
    });
    context.subscriptions.push(disposable);
  }
}

export function activate(context: vscode.ExtensionContext) {
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
  void flushDiskQueues();
  const queueFlushIntervalMs = Math.max(5, config().queueFlushIntervalSeconds) * 1000;
  const queueFlushTimer = setInterval(() => void flushDiskQueues(), queueFlushIntervalMs);
  context.subscriptions.push({ dispose: () => clearInterval(queueFlushTimer) });
  if (config().autoInstallGitHooks) {
    void installGitHooksForWorkspace({ silent: true, emitHeartbeat: false });
  }
  if (config().autoCaptureCopilotLocalTranscripts) {
    void captureCopilotLocalTranscripts({ silent: true });
    const timer = setInterval(() => void captureCopilotLocalTranscripts({ silent: true }), 15000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }
  if (config().autoCaptureClaudeLocalTranscripts) {
    void captureClaudeLocalTranscripts({ silent: true });
    const timer = setInterval(() => void captureClaudeLocalTranscripts({ silent: true }), 15000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }
  updateStatus();
}

export function deactivate() {
  emitConversationSnapshot("derived");
  return flush();
}
