import * as vscode from "vscode";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  CollectorClient,
  classifySpecPath,
  commitSnapshot,
  diffSummary,
  installGitHooks,
  markAiActivity,
  makeEvent,
  pushSnapshot,
  recordAiLineSnapshot,
  searchSpecs,
  stableEventId,
  type ObservabilityEvent,
  type SpecClassification
} from "@tinyai/observability-runtime";

let currentTaskId: string | undefined;
let statusBar: vscode.StatusBarItem;
let panelProvider: ObservabilityPanelProvider | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
const pendingEvents: ObservabilityEvent[] = [];
type SourceConfidence = "direct" | "derived" | "inferred";
type CapturedConversationMessage = { role: string; text_len: number; text_hash: string; text?: string; source?: string };
type ParsedCopilotTranscript = {
  sessionId: string;
  sessionFile: string;
  transcriptKind: string;
  contentHash: string;
  messages: CapturedConversationMessage[];
  toolCallCount: number;
  toolResultCount: number;
  turnStartedCount: number;
  turnCompletedCount: number;
  turnAbortedCount: number;
  patchApplyCount: number;
  patchSuccessCount: number;
  specAccesses: SpecClassification[];
  startedAt?: string;
};
const conversationMessages: CapturedConversationMessage[] = [];
const COPILOT_TRANSCRIPT_STATE_KEY = "tinyaiObservability.copilotTranscriptHashes";

function workspacePath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}

function config() {
  const cfg = vscode.workspace.getConfiguration("tinyaiObservability");
  return {
    collectorUrl: cfg.get<string>("collectorUrl") || "http://localhost:18080",
    token: cfg.get<string>("token") || "dev-token",
    captureConversationText: cfg.get<boolean>("captureConversationText") ?? true,
    autoCaptureCopilotLocalTranscripts: cfg.get<boolean>("autoCaptureCopilotLocalTranscripts") ?? true
  };
}

const PLUGIN_VERSION = "0.1.8";

function client(): CollectorClient {
  const cfg = config();
  return new CollectorClient({ baseUrl: cfg.collectorUrl, token: cfg.token, pluginName: "tinyai-observability-vscode", pluginVersion: PLUGIN_VERSION });
}

function event(
  eventType: Parameters<typeof makeEvent>[0]["eventType"],
  payload: Record<string, unknown> = {},
  sourceConfidence: SourceConfidence = "direct",
  eventId?: string
) {
  if (!currentTaskId) return;
  eventForTask(currentTaskId, eventType, payload, sourceConfidence, eventId);
}

function eventForTask(
  taskId: string,
  eventType: Parameters<typeof makeEvent>[0]["eventType"],
  payload: Record<string, unknown> = {},
  sourceConfidence: SourceConfidence = "direct",
  eventId?: string
) {
  pendingEvents.push(makeEvent({ tool: "copilot", eventType, taskId, workspacePath: workspacePath(), payload, sourceConfidence, eventId }));
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

function appendConversationMessage(role: string, text: string, source: string) {
  const message = conversationMessage(role, text, source);
  if (message) conversationMessages.push(message);
}

function conversationMessage(role: string, text: string, source: string): CapturedConversationMessage | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const includeText = config().captureConversationText;
  const message: CapturedConversationMessage = {
    role,
    text_len: trimmed.length,
    text_hash: hashText(trimmed),
    source
  };
  if (includeText) message.text = trimmed;
  return message;
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
      "Captured from VS Code local GitHub Copilot Chat transcript JSONL files under workspaceStorage. This is complete local user/assistant transcript text when VS Code writes those files, but it is classified as derived because it is read from persisted local transcripts rather than the Copilot Chat API.",
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

async function listJsonlFiles(dir: string, transcriptKind: string): Promise<Array<{ path: string; transcriptKind: string; mtimeMs: number }>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
          const path = join(dir, entry.name);
          const info = await stat(path);
          return { path, transcriptKind, mtimeMs: info.mtimeMs };
        })
    );
    return files;
  } catch {
    return [];
  }
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
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

function pushParsedMessage(messages: CapturedConversationMessage[], role: string, text: string, source: string) {
  const message = conversationMessage(role, text, source);
  if (message) messages.push(message);
}

function dedupeMessages(messages: CapturedConversationMessage[]): CapturedConversationMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const key = `${message.role}:${message.text_hash}:${message.source || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function parseChatSessionRequest(request: unknown, messages: CapturedConversationMessage[], source: string) {
  if (!request || typeof request !== "object") return;
  const record = request as Record<string, unknown>;
  const userText = userTextFromChatSessionRequest(record);
  if (userText) pushParsedMessage(messages, "user", userText, source);
  const assistantText = assistantTextFromResponseParts(record.response);
  if (assistantText) pushParsedMessage(messages, "assistant", assistantText, source);
}

function parseChatSessionPatch(entry: Record<string, unknown>, messages: CapturedConversationMessage[], source: string) {
  if (entry.kind === 0 && entry.v && typeof entry.v === "object") {
    const snapshot = entry.v as Record<string, unknown>;
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

async function parseCopilotTranscriptFile(sessionFile: string, transcriptKind: string): Promise<ParsedCopilotTranscript | undefined> {
  let content: string;
  try {
    content = await readFile(sessionFile, "utf8");
  } catch {
    return undefined;
  }

  const messages: CapturedConversationMessage[] = [];
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
  const source = transcriptKind === "github-copilot-transcript" ? "copilot_local_transcript" : "copilot_chat_session";

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    recordSpecAccessFromUnknown(entry, specAccesses);

    const type = typeof entry.type === "string" ? entry.type : "";
    const data = entry.data && typeof entry.data === "object" ? (entry.data as Record<string, unknown>) : {};
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
        const snapshot = entry.v as Record<string, unknown>;
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
  if (deduped.length === 0) return undefined;
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

async function captureCopilotLocalTranscripts(options: { silent?: boolean } = {}) {
  const context = extensionContext;
  const root = workspaceStorageRoot();
  if (!context || !root) {
    if (!options.silent) vscode.window.showWarningMessage("TinyAI Observability cannot locate VS Code workspaceStorage yet.");
    return;
  }

  const files = [
    ...(await listJsonlFiles(join(root, "GitHub.copilot-chat", "transcripts"), "github-copilot-transcript")),
    ...(await listJsonlFiles(join(root, "chatSessions"), "vscode-chat-session"))
  ]
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, 30);

  const seen = { ...(context.workspaceState.get<Record<string, string>>(COPILOT_TRANSCRIPT_STATE_KEY) || {}) };
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
      uploaded > 0
        ? `TinyAI captured ${capturedMessages} Copilot transcript messages from ${uploaded} local file(s).`
        : "TinyAI found no new local Copilot transcript messages."
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
  if (!currentTaskId) {
    vscode.window.showInformationMessage("Start a TinyAI Observability task first.");
    return;
  }
  const kind = await vscode.window.showQuickPick(["user_correction", "regenerate", "interruption"], { title: "Feedback type" });
  if (!kind) return;
  const reason = await vscode.window.showInputBox({ title: "Feedback reason", value: kind === "user_correction" ? "specs_misunderstanding" : "" });
  event(kind as "user_correction" | "regenerate" | "interruption", { reason: reason || undefined }, "direct");
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
  await ensureTask("commit_snapshot");
  const snapshot = await commitSnapshot(workspacePath(), "HEAD", {
    aiAssisted: true,
    attributionEvidence: "manual_vscode_commit_snapshot"
  });
  event(
    "commit_snapshot",
    { ...snapshot, source: "vscode_command" },
    "derived",
    snapshot.commit_sha ? stableEventId(`copilot:commit_snapshot:${workspacePath()}:${snapshot.commit_sha}`) : undefined
  );
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
    rangeKey ? stableEventId(`copilot:push_snapshot:${workspacePath()}:${rangeKey}`) : undefined
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

class ObservabilityPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  resolveWebviewView(view: vscode.WebviewView) {
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

  refresh(latestResponse?: string) {
    if (this.view) this.view.webview.html = this.renderHtml(latestResponse);
  }

  private renderHtml(latestResponse = "") {
    const taskText = currentTaskId ? `On: ${currentTaskId.slice(0, 8)}` : "Idle";
    const messageCount = conversationMessages.length;
    const recentMessages = conversationMessages
      .slice(-6)
      .map((message) => {
        const text = typeof message.text === "string" ? message.text : `[${message.text_len} chars]`;
        return `<div class="msg ${escapeHtml(message.role)}"><div class="role">${escapeHtml(message.role)}</div><div>${escapeHtml(text)}</div></div>`;
      })
      .join("");
    return /* html */ `<!doctype html>
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
  event(classification.spec_scope === "official" ? "official_misread" : "spec_read", { ...classification }, classification.via_catalog ? "direct" : "derived");
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
    const timer = setInterval(() => void captureCopilotLocalTranscripts({ silent: true }), 15000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }
  updateStatus();
}

export function deactivate() {
  emitConversationSnapshot("derived");
  return flush();
}
