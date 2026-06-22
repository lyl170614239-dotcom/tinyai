import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { ToolName } from "./event-schema.js";

type CapturedMessage = {
  role: string;
  text_len: number;
  text_hash: string;
  text?: string;
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

export async function captureLatestCodexConversation(options: { includeText?: boolean } = {}): Promise<ConversationSnapshot> {
  const file = await latestSessionFile();
  if (!file) throw new Error("No Codex session file found under ~/.codex/sessions");

  const includeText = Boolean(options.includeText);
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  const messages: CapturedMessage[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let source: string | undefined;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let turnStartedCount = 0;
  let turnCompletedCount = 0;
  let turnAbortedCount = 0;
  let patchApplyCount = 0;
  let patchSuccessCount = 0;
  let sawEventMessages = false;

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry.payload || {};
    if (entry.type === "session_meta") {
      sessionId = payload.id || sessionId;
      cwd = payload.cwd || cwd;
      source = payload.source || source;
      continue;
    }
    if (entry.type === "event_msg") {
      if (payload.type === "task_started") {
        turnStartedCount += 1;
        continue;
      }
      if (payload.type === "task_complete") {
        turnCompletedCount += 1;
        continue;
      }
      if (payload.type === "turn_aborted") {
        turnAbortedCount += 1;
        continue;
      }
      if (payload.type === "patch_apply_end") {
        patchApplyCount += 1;
        if (payload.success === true) patchSuccessCount += 1;
        continue;
      }
      if (payload.type === "user_message" || payload.type === "agent_message") {
        sawEventMessages = true;
        const role = payload.type === "user_message" ? "user" : "assistant";
        const text = typeof payload.message === "string" ? payload.message : "";
        const message: CapturedMessage = {
          role,
          text_len: text.length,
          text_hash: hashText(text)
        };
        if (includeText) message.text = text;
        messages.push(message);
        continue;
      }
    }
    if (entry.type !== "response_item") continue;
    if (payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "web_search_call") {
      toolCallCount += 1;
      continue;
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      toolResultCount += 1;
      continue;
    }
    if (payload.type !== "message") continue;
    if (sawEventMessages) continue;
    const role = String(payload.role || "unknown");
    if (!["user", "assistant"].includes(role)) continue;
    const text = extractText(payload.content);
    const message: CapturedMessage = {
      role,
      text_len: text.length,
      text_hash: hashText(text)
    };
    if (includeText) message.text = text;
    messages.push(message);
  }

  const userMessageCount = messages.filter((message) => message.role === "user").length;
  const assistantMessageCount = messages.filter((message) => message.role === "assistant").length;

  return {
    session_id: sessionId,
    session_file: file.replace(homedir(), "~"),
    cwd,
    source,
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
    messages
  };
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

export async function captureLatestClaudeConversation(options: { includeText?: boolean } = {}): Promise<ConversationSnapshot> {
  const file = await latestClaudeTranscriptFile();
  if (!file) throw new Error("No Claude transcript file found under ~/.claude/transcripts or ~/.claude/projects");

  const includeText = Boolean(options.includeText);
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  const messages: CapturedMessage[] = [];
  let sessionId: string | undefined = basename(file, ".jsonl");
  let cwd: string | undefined;
  let toolCallCount = 0;
  let toolResultCount = 0;

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
      continue;
    }
    if (entry.type === "tool_use" || entry.tool_use || entry.tool_name) {
      toolCallCount += 1;
      continue;
    }

    const role = roleFromClaudeEntry(entry);
    if (!role) continue;
    const text = textFromClaudeEntry(entry);
    const message: CapturedMessage = {
      role,
      text_len: text.length,
      text_hash: hashText(text)
    };
    if (includeText) message.text = text;
    messages.push(message);
  }

  const userMessageCount = messages.filter((message) => message.role === "user").length;
  const assistantMessageCount = messages.filter((message) => message.role === "assistant").length;

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
    messages
  };
}

export async function captureLatestConversation(tool: ToolName, options: { includeText?: boolean } = {}): Promise<ConversationSnapshot> {
  if (tool === "claude") return captureLatestClaudeConversation(options);
  return captureLatestCodexConversation(options);
}
