import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
async function walkJsonl(root, maxFiles = 500) {
    const files = [];
    async function visit(dir) {
        if (files.length >= maxFiles)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (files.length >= maxFiles)
                return;
            const path = join(dir, entry.name);
            if (entry.isDirectory())
                await visit(path);
            else if (entry.name.endsWith(".jsonl"))
                files.push(path);
        }
    }
    await visit(root);
    return files;
}
async function latestSessionFile() {
    const root = join(homedir(), ".codex", "sessions");
    const files = await walkJsonl(root);
    return latestFile(files);
}
async function latestClaudeTranscriptFile() {
    const roots = [join(homedir(), ".claude", "transcripts"), join(homedir(), ".claude", "projects")];
    const files = (await Promise.all(roots.map((root) => walkJsonl(root)))).flat();
    return latestFile(files);
}
function cleanExistingFile(raw) {
    if (typeof raw !== "string" || !raw.trim())
        return undefined;
    return raw.trim().replace(/^file:\/\//, "");
}
async function latestFile(files) {
    let latest;
    for (const file of files) {
        const info = await stat(file).catch(() => undefined);
        if (!info)
            continue;
        if (!latest || info.mtimeMs > latest.mtimeMs)
            latest = { file, mtimeMs: info.mtimeMs };
    }
    return latest?.file;
}
function extractText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    const chunks = [];
    for (const part of content) {
        if (!part || typeof part !== "object")
            continue;
        const value = part.text || part.input_text || part.output_text;
        if (typeof value === "string")
            chunks.push(value);
    }
    return chunks.join("\n");
}
function hashText(text) {
    return createHash("sha256").update(text).digest("hex").slice(0, 32);
}
function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function cleanString(value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
    return value.trim();
}
function jsonRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
const READ_TOOLS = /^(read|Read|view|View|cat|open|Open|get|show|Show|display|list|List|search_content|search_file|search_files|codebase_search|grep|Grep|glob|Glob|find_files|read_file|read_lints|read_lints)$/;
const EDIT_TOOLS = /^(write|Write|edit|Edit|replace|Replace|patch|Patch|apply_patch|create|Create|update|Update|delete|Delete|remove|Remove|rename|Rename|write_to_file|replace_in_file|edit_file)$/;
const SENSITIVE_PATH_RE = /(^|\/)\.env(?:\.|$)|(^|\/)(\.?npmrc|\.?pypirc|\.?netrc|id_rsa|id_ed25519)$|(secret|secrets|credential|credentials|token|private-key|private_key)/i;
function normalizeToolName(raw) {
    if (typeof raw === "string" && raw.trim())
        return raw.trim();
    return "unknown_tool";
}
function isReadTool(name) {
    return READ_TOOLS.test(name);
}
function isEditTool(name) {
    return EDIT_TOOLS.test(name);
}
function cleanFilePath(raw) {
    let candidate = raw.trim();
    candidate = candidate.replace(/^file:\/\//, "").replace(/^[`"'[(<\s]+/, "").replace(/[`"'\])>,.;:\s]+$/, "");
    if (!candidate || candidate.length > 500)
        return undefined;
    if (/^(https?:|data:)/i.test(candidate))
        return undefined;
    return candidate;
}
function extractFileReads(toolName, input, output, sequence, occurredAt) {
    if (!isReadTool(toolName))
        return;
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
                }
                else if ([...output.keys()].some((existingKey) => existingKey.startsWith(`${cleaned}:`) && existingKey !== pathOnlyKey)) {
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
function parseApplyPatchEdits(patchText) {
    if (!patchText.includes("*** Begin Patch"))
        return [];
    const edits = [];
    let current;
    let oldLine = 1;
    let newLine = 1;
    const finish = () => {
        if (!current)
            return;
        current.hunks = current.hunks.filter((hunk) => hunk.lines.length > 0);
        if (current.hunks.length > 0)
            edits.push(current);
        current = undefined;
    };
    for (const rawLine of patchText.split(/\r?\n/)) {
        const fileMatch = rawLine.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
        if (fileMatch) {
            finish();
            const cleaned = cleanFilePath(fileMatch[2]);
            if (!cleaned)
                continue;
            current = {
                file_path: cleaned,
                lines_added: 0,
                lines_deleted: 0,
                hunks: []
            };
            oldLine = 1;
            newLine = 1;
            continue;
        }
        if (!current)
            continue;
        if (rawLine.startsWith("@@")) {
            const hunkMatch = rawLine.match(/^@@(?:\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?)?/);
            if (hunkMatch?.[1]) {
                oldLine = Number(hunkMatch[1]);
                newLine = Number(hunkMatch[2] || 1);
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
        }
        else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
            const text = rawLine.slice(1);
            hunk.lines.push({ line_type: "removed", old_line: oldLine, text, text_hash: hashText(`${current.file_path}\0${text}`) });
            hunk.old_lines += 1;
            current.lines_deleted += 1;
            oldLine += 1;
        }
        else if (rawLine.startsWith(" ")) {
            oldLine += 1;
            newLine += 1;
        }
    }
    finish();
    return edits;
}
function toolInputRecord(input) {
    if (typeof input === "string")
        return { input };
    if (typeof input === "object" && input !== null)
        return input;
    return {};
}
function extractCodeEdits(toolName, input, _includeText) {
    if (!isEditTool(toolName))
        return [];
    const patchText = input.input || input.patch || input.diff;
    if (typeof patchText === "string" && patchText.includes("*** Begin Patch")) {
        return parseApplyPatchEdits(patchText);
    }
    const filePath = input.filePath || input.file_path || input.path || input.file;
    const oldStr = input.oldString || input.old_str || input.oldString || "";
    const newStr = input.newString || input.new_str || input.newString || input.content || input.text || "";
    if (typeof filePath !== "string" || (!oldStr && !newStr))
        return [];
    const cleaned = cleanFilePath(filePath);
    if (!cleaned)
        return [];
    const oldLines = typeof oldStr === "string" ? oldStr.split(/\r?\n/) : [];
    const newLines = typeof newStr === "string" ? newStr.split(/\r?\n/) : [];
    if (oldLines.at(-1) === "")
        oldLines.pop();
    if (newLines.at(-1) === "")
        newLines.pop();
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix])
        prefix += 1;
    let suffix = 0;
    while (suffix + prefix < oldLines.length && suffix + prefix < newLines.length && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix])
        suffix += 1;
    const removed = oldLines.slice(prefix, oldLines.length - suffix);
    const added = newLines.slice(prefix, newLines.length - suffix);
    if (removed.length === 0 && added.length === 0)
        return [];
    const hunkLines = [];
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
            hunks: [{ old_start: prefix + 1, old_lines: removed.length, new_start: prefix + 1, new_lines: added.length, lines: hunkLines }]
        }];
}
function dedupeProcessSteps(steps) {
    const seen = new Set();
    return steps.flatMap((step) => {
        const key = `${step.kind}:${step.text_hash}:${step.tool_name || ""}:${step.status || ""}`;
        if (seen.has(key))
            return [];
        seen.add(key);
        return [{ ...step, step_id: hashText(key) }];
    });
}
function isSensitiveFilePath(filePath) {
    return SENSITIVE_PATH_RE.test(filePath);
}
function processSignature(steps) {
    return hashText(JSON.stringify(steps.map((s) => [s.kind, s.text_hash, s.tool_name || "", s.status || ""])));
}
function messageSignature(messages) {
    return hashText(JSON.stringify(messages.map((m) => [m.role, m.text_hash])));
}
function codexTurnIds(sessionId, turnIndex, userMessage) {
    const base = `${sessionId || "codex-session"}:${turnIndex}:${userMessage.message_id || userMessage.text_hash}`;
    const digest = hashText(base);
    return {
        requestId: `codex_request_${digest}`,
        responseId: `codex_response_${digest}`
    };
}
function buildCodexRequestUsage(input) {
    const userMessages = input.messages.filter((message) => message.role === "user");
    const requestUsage = [];
    userMessages.forEach((userMessage, index) => {
        const turnIndex = index + 1;
        const startSequence = typeof userMessage.sequence === "number" ? userMessage.sequence : 0;
        const nextUserSequence = userMessages[index + 1]?.sequence;
        const beforeNextTurn = (sequence) => nextUserSequence === undefined || sequence < nextUserSequence;
        const inTurn = (sequence) => sequence >= startSequence && beforeNextTurn(sequence);
        const tokenEvents = input.tokenUsageEvents.filter((event) => inTurn(event.sequence));
        const completeEvent = input.turnEvents.find((event) => event.kind === "task_complete" && inTurn(event.sequence));
        const modelEvent = [...input.modelEvents].reverse().find((event) => inTurn(event.sequence) || event.sequence <= startSequence);
        const promptTokens = tokenEvents.reduce((sum, event) => sum + (event.prompt_tokens || 0), 0);
        const outputTokens = tokenEvents.reduce((sum, event) => sum + (event.output_tokens || 0), 0);
        const elapsedMs = completeEvent?.duration_ms;
        const model = modelEvent?.model;
        if (!model && promptTokens <= 0 && outputTokens <= 0 && elapsedMs === undefined)
            return;
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
    const usageTotals = requestUsage.reduce((totals, usage) => ({
        prompt_tokens: totals.prompt_tokens + (usage.prompt_tokens || 0),
        output_tokens: totals.output_tokens + (usage.output_tokens || 0),
        completion_tokens: totals.completion_tokens,
        elapsed_ms: totals.elapsed_ms + (usage.elapsed_ms || 0),
        copilot_credits: totals.copilot_credits
    }), { prompt_tokens: 0, output_tokens: 0, completion_tokens: 0, elapsed_ms: 0, copilot_credits: 0 });
    const resolvedModel = [...requestUsage].reverse().find((usage) => usage.model)?.model;
    return { requestUsage, usageTotals, resolvedModel };
}
export function latestCodexTurnSnapshot(snapshot) {
    const messages = snapshot.messages || [];
    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === "user") {
            lastUserIndex = index;
            break;
        }
    }
    if (lastUserIndex < 0)
        return snapshot;
    const turnIndex = messages.slice(0, lastUserIndex + 1).filter((message) => message.role === "user").length;
    const userMessage = messages[lastUserIndex];
    const boundarySequence = typeof userMessage.sequence === "number" ? userMessage.sequence : undefined;
    const { requestId, responseId } = codexTurnIds(snapshot.session_id, turnIndex, userMessage);
    const inLatestTurn = (item) => {
        if (boundarySequence === undefined)
            return true;
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
    const latestUsageTotals = latestRequestUsage.reduce((totals, usage) => ({
        prompt_tokens: totals.prompt_tokens + (usage.prompt_tokens || 0),
        output_tokens: totals.output_tokens + (usage.output_tokens || 0),
        completion_tokens: totals.completion_tokens + (usage.completion_tokens || 0),
        elapsed_ms: totals.elapsed_ms + (usage.elapsed_ms || 0),
        copilot_credits: totals.copilot_credits + (usage.copilot_credits || 0)
    }), { prompt_tokens: 0, output_tokens: 0, completion_tokens: 0, elapsed_ms: 0, copilot_credits: 0 });
    const latestTurnComplete = latestTurnEvents.some((event) => event.kind === "task_complete");
    const latestTurnAborted = latestTurnEvents.some((event) => event.kind === "turn_aborted");
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
        latest_turn_complete: latestTurnComplete
    };
}
export async function captureLatestCodexConversation(options = {}) {
    const file = cleanExistingFile(options.sessionFile) || await latestSessionFile();
    if (!file)
        throw new Error("No Codex session file found under ~/.codex/sessions");
    const includeText = Boolean(options.includeText);
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    const messages = [];
    const processSteps = [];
    const fileReads = new Map();
    const codeEdits = [];
    const turnEvents = [];
    const tokenUsageEvents = [];
    const modelEvents = [];
    let sessionId = options.sessionId;
    let cwd;
    let source;
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
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
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
            if (model)
                modelEvents.push({ model, sequence });
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
                if (payload.success === true)
                    patchSuccessCount += 1;
                continue;
            }
            if (payload.type === "user_message" || payload.type === "agent_message") {
                sawEventMessages = true;
                const role = payload.type === "user_message" ? "user" : "assistant";
                const text = typeof payload.message === "string" ? payload.message : "";
                if (!text.trim())
                    continue;
                const message = {
                    role,
                    text_len: text.length,
                    text_hash: hashText(text),
                    message_id: String(payload.id || payload.message_id || entry.id || `${entry.type}:${messages.length}`),
                    occurred_at: occurredAt,
                    sequence
                };
                if (includeText)
                    message.text = text;
                messages.push(message);
                continue;
            }
        }
        if (entry.type !== "response_item")
            continue;
        if (payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "web_search_call") {
            toolCallCount += 1;
            const toolName = normalizeToolName(payload.name || payload.function_name || payload.tool_name);
            const args = payload.arguments || payload.input || payload.args || {};
            const argsObj = toolInputRecord(args);
            const argsText = typeof args === "string" ? args : JSON.stringify(argsObj);
            const step = {
                kind: "tool_call",
                text_len: argsText.length,
                text_hash: hashText(argsText),
                tool_name: toolName,
                status: "complete",
                occurred_at: occurredAt,
                sequence
            };
            if (includeText)
                step.text = argsText;
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
            const step = {
                kind: "tool_result",
                text_len: outputText.length,
                text_hash: hashText(outputText),
                tool_name: normalizeToolName(payload.name || payload.tool_name),
                status: payload.is_error || payload.isError ? "failed" : "complete",
                occurred_at: occurredAt,
                sequence
            };
            if (includeText)
                step.text = outputText.slice(0, 2048);
            processSteps.push(step);
            continue;
        }
        if (payload.type === "reasoning") {
            const reasoningText = extractText(payload.summary) ||
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
        if (payload.type !== "message")
            continue;
        if (sawEventMessages)
            continue;
        const role = String(payload.role || "unknown");
        if (!["user", "assistant"].includes(role))
            continue;
        const text = extractText(payload.content);
        if (!text.trim())
            continue;
        const message = {
            role,
            text_len: text.length,
            text_hash: hashText(text),
            message_id: String(payload.id || entry.id || `${entry.type}:${messages.length}`),
            occurred_at: occurredAt,
            sequence
        };
        if (includeText)
            message.text = text;
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
        modelEvents
    });
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
        code_edits: codeEdits.length > 0 ? codeEdits : undefined,
        turn_events: turnEvents.length > 0 ? turnEvents : undefined,
        request_usage: requestUsage.length > 0 ? requestUsage : undefined,
        usage_totals: requestUsage.length > 0 ? usageTotals : undefined
    };
    return options.latestTurnOnly ? latestCodexTurnSnapshot(snapshot) : snapshot;
}
function roleFromClaudeEntry(entry) {
    if (["user", "assistant"].includes(String(entry.type)))
        return String(entry.type);
    if (["user", "assistant"].includes(String(entry.role)))
        return String(entry.role);
    if (entry.message && ["user", "assistant"].includes(String(entry.message.role)))
        return String(entry.message.role);
    return undefined;
}
function textFromClaudeEntry(entry) {
    if (typeof entry.content === "string" || Array.isArray(entry.content))
        return extractText(entry.content);
    if (entry.message && (typeof entry.message.content === "string" || Array.isArray(entry.message.content))) {
        return extractText(entry.message.content);
    }
    if (typeof entry.text === "string")
        return entry.text;
    if (typeof entry.message === "string")
        return entry.message;
    return "";
}
function processClaudeContentBlocks(content, processSteps, fileReads, codeEdits, includeText) {
    if (!Array.isArray(content))
        return { toolCalls: 0, toolResults: 0 };
    let toolCalls = 0;
    let toolResults = 0;
    for (const block of content) {
        if (!block || typeof block !== "object")
            continue;
        const blockType = block.type;
        if (blockType === "thinking") {
            const thinkingText = typeof block.thinking === "string" ? block.thinking : "";
            if (thinkingText) {
                processSteps.push({
                    kind: "thinking",
                    text_len: thinkingText.length,
                    text_hash: hashText(thinkingText),
                    ...(includeText ? { text: thinkingText } : {})
                });
            }
        }
        else if (blockType === "tool_use") {
            toolCalls += 1;
            const toolName = normalizeToolName(block.name);
            const input = block.input || {};
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
        }
        else if (blockType === "tool_result") {
            toolResults += 1;
            const output = block.content || block.output || "";
            const outputText = typeof output === "string" ? output : JSON.stringify(output);
            processSteps.push({
                kind: "tool_result",
                text_len: outputText.length,
                text_hash: hashText(outputText),
                tool_name: normalizeToolName(block.name || block.tool_name),
                status: block.is_error ? "failed" : "complete",
                ...(includeText ? { text: outputText.slice(0, 2048) } : {})
            });
        }
    }
    return { toolCalls, toolResults };
}
export async function captureLatestClaudeConversation(options = {}) {
    const file = cleanExistingFile(options.sessionFile) || await latestClaudeTranscriptFile();
    if (!file)
        throw new Error("No Claude transcript file found under ~/.claude/transcripts or ~/.claude/projects");
    const includeText = Boolean(options.includeText);
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    const messages = [];
    const processSteps = [];
    const fileReads = new Map();
    const codeEdits = [];
    let sessionId = options.sessionId || basename(file, ".jsonl");
    let cwd;
    let toolCallCount = 0;
    let toolResultCount = 0;
    const seenMessageIds = new Set();
    const seenFallbackEntries = new Set();
    for (const line of lines) {
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
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
        if (!role)
            continue;
        // Extract thinking/tool_use from Claude content block arrays
        const content = entry.content || entry.message?.content;
        if (content) {
            const counts = processClaudeContentBlocks(content, processSteps, fileReads, codeEdits, includeText);
            toolCallCount += counts.toolCalls;
            toolResultCount += counts.toolResults;
        }
        const text = textFromClaudeEntry(entry);
        if (!text.trim())
            continue;
        const messageId = String(entry.uuid || entry.id || entry.message?.id || "");
        if (messageId) {
            if (seenMessageIds.has(messageId))
                continue;
            seenMessageIds.add(messageId);
        }
        else {
            const fallbackKey = hashText(JSON.stringify({
                type: entry.type,
                role,
                text,
                timestamp: entry.timestamp || entry.created_at || entry.createdAt
            }));
            if (seenFallbackEntries.has(fallbackKey))
                continue;
            seenFallbackEntries.add(fallbackKey);
        }
        const message = {
            role,
            text_len: text.length,
            text_hash: hashText(text),
            message_id: messageId || undefined,
            occurred_at: typeof entry.timestamp === "string"
                ? entry.timestamp
                : typeof entry.created_at === "string"
                    ? entry.created_at
                    : typeof entry.createdAt === "string"
                        ? entry.createdAt
                        : undefined
        };
        if (includeText)
            message.text = text;
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
        code_edits: codeEdits.length > 0 ? codeEdits : undefined
    };
}
export async function captureLatestConversation(tool, options = {}) {
    if (tool === "claude")
        return captureLatestClaudeConversation(options);
    return captureLatestCodexConversation(options);
}
