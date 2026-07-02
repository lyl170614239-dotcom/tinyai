import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { stableEventId } from "./event-schema.js";
const execFileAsync = promisify(execFile);
export const CLAUDE_TURN_PARSER_VERSION = "claude-turn-v1.0.3";
const JSONL_READ_CHUNK_BYTES = 1024 * 1024;
const CLAUDE_NON_PROMPT_TAGS = [
    "system-reminder",
    "ide_opened_file",
    "ide_selection",
    "selected_text",
    "ide_context",
    "editor_context"
];
const CLAUDE_NON_PROMPT_TAG_RE = new RegExp(`<(${CLAUDE_NON_PROMPT_TAGS.join("|")})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>`, "gi");
const CLAUDE_CONTEXT_TAG_RE = /<(ide_opened_file|ide_selection|selected_text|ide_context|editor_context)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function array(value) {
    return Array.isArray(value) ? value : [];
}
function cleanString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function hashText(value) {
    return createHash("sha256").update(value).digest("hex");
}
function hashJson(value) {
    return hashText(JSON.stringify(value ?? null));
}
function stripClaudeNonPromptContext(value) {
    return value.replace(CLAUDE_NON_PROMPT_TAG_RE, "").trim();
}
function claudeContextStepsFromContent(content, requestId, occurredAt) {
    const steps = [];
    for (const part of array(content)) {
        const blockText = typeof part === "string"
            ? part
            : record(part)?.type === "text"
                ? cleanString(record(part)?.text) || ""
                : "";
        if (!blockText)
            continue;
        for (const match of blockText.matchAll(CLAUDE_CONTEXT_TAG_RE)) {
            const sourceType = match[1];
            const rawText = (match[2] || "").trim();
            if (!rawText)
                continue;
            const label = sourceType === "ide_opened_file"
                ? `IDE 当前文件：${rawText}`
                : sourceType === "selected_text" || sourceType === "ide_selection"
                    ? `IDE 选区上下文：${rawText}`
                    : `IDE 上下文：${rawText}`;
            steps.push({
                step_id: hashText(`${requestId}:context:${sourceType}:${hashText(rawText)}`).slice(0, 32),
                step_type: "context",
                text: label,
                text_hash: hashText(label),
                source: "claude_project_jsonl",
                source_event_type: sourceType,
                status: "complete",
                occurred_at: occurredAt,
                actor_path: "top",
                actor_type: "system"
            });
        }
    }
    return steps;
}
async function readJsonlSegment(filePath, startOffset = 0) {
    const st = await stat(filePath);
    const safeOffset = startOffset > 0 && startOffset <= st.size ? startOffset : 0;
    function completeSegment(raw) {
        const lastNewline = raw.lastIndexOf("\n");
        if (lastNewline < 0)
            return { raw: "", nextOffset: safeOffset };
        const completeRaw = raw.slice(0, lastNewline + 1);
        return { raw: completeRaw, nextOffset: safeOffset + Buffer.byteLength(completeRaw, "utf8") };
    }
    if (safeOffset === 0) {
        const segment = completeSegment(await readFile(filePath, "utf8"));
        return { raw: segment.raw, mtimeMs: st.mtimeMs, size: st.size, startOffset: 0, nextOffset: segment.nextOffset };
    }
    const handle = await open(filePath, "r");
    const chunks = [];
    let position = safeOffset;
    try {
        while (position < st.size) {
            const length = Math.min(JSONL_READ_CHUNK_BYTES, st.size - position);
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(buffer, 0, length, position);
            if (bytesRead <= 0)
                break;
            chunks.push(buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
    }
    finally {
        await handle.close();
    }
    const segment = completeSegment(Buffer.concat(chunks).toString("utf8"));
    return { raw: segment.raw, mtimeMs: st.mtimeMs, size: st.size, startOffset: safeOffset, nextOffset: segment.nextOffset };
}
function isoTimestamp(value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
function isRealUserPrompt(entry) {
    if (entry.type !== "user" || entry.isMeta === true)
        return false;
    const message = record(entry.message);
    if (message?.role !== "user")
        return false;
    const content = message.content;
    const blocks = array(content);
    const hasUserText = typeof content === "string"
        ? Boolean(content.trim())
        : blocks.some((part) => {
            const block = record(part);
            return typeof part === "string" || block?.type === "text";
        });
    if (!hasUserText)
        return false;
    const text = textFromClaudeContent(content, { excludeToolBlocks: true, excludeSystemReminder: true, excludeContext: true }).trim();
    if (!text)
        return false;
    if (/^\[Request interrupted by user/i.test(text))
        return false;
    if (/^Base directory for this skill:/i.test(text))
        return false;
    return true;
}
function isClaudeUserInterruptMarker(entry) {
    if (entry.type !== "user")
        return false;
    const message = record(entry.message);
    if (message?.role !== "user")
        return false;
    const text = textFromClaudeContent(message.content, {
        excludeToolBlocks: true,
        excludeSystemReminder: true,
        excludeContext: true
    }).trim();
    return /^\[Request interrupted by user/i.test(text);
}
async function countPriorClaudeUserTurns(filePath, startOffset, requestedSessionId) {
    if (startOffset <= 0)
        return 0;
    const raw = await readFile(filePath);
    const prefix = raw.subarray(0, Math.min(startOffset, raw.length)).toString("utf8");
    let count = 0;
    for (const line of prefix.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        const sessionId = cleanString(entry.sessionId) || cleanString(entry.session_id) || basename(filePath, ".jsonl");
        if (requestedSessionId && sessionId !== requestedSessionId)
            continue;
        if (isRealUserPrompt(entry))
            count += 1;
    }
    return count;
}
function textFromClaudeContent(content, options = {}) {
    if (typeof content === "string") {
        return options.excludeSystemReminder || options.excludeContext ? stripClaudeNonPromptContext(content) : content;
    }
    return array(content)
        .map((part) => {
        if (typeof part === "string")
            return part;
        const block = record(part);
        if (!block)
            return "";
        const type = String(block.type || "");
        if (options.excludeToolBlocks && (type === "tool_use" || type === "tool_result"))
            return "";
        if (type === "thinking")
            return options.excludeThinking ? "" : cleanString(block.thinking) || "";
        if (type === "text") {
            const text = cleanString(block.text) || "";
            if (options.excludeSystemReminder || options.excludeContext) {
                return stripClaudeNonPromptContext(text);
            }
            return text;
        }
        if (type === "tool_result")
            return cleanString(block.content) || "";
        return cleanString(block.text) || cleanString(block.content) || "";
    })
        .filter(Boolean)
        .join("\n")
        .trim();
}
function textFromEntry(entry) {
    const message = record(entry.message);
    return textFromClaudeContent(message?.content, {
        excludeToolBlocks: true,
        excludeSystemReminder: true,
        excludeContext: true
    });
}
function assistantTextFromEntry(entry) {
    const message = record(entry.message);
    return textFromClaudeContent(message?.content, {
        excludeToolBlocks: true,
        excludeSystemReminder: true,
        excludeContext: true,
        excludeThinking: true
    });
}
function normalizeToolName(name) {
    const raw = String(name || "").trim();
    const lower = raw.toLowerCase();
    if (lower === "read")
        return "read_file";
    if (lower === "edit")
        return "replace_string_in_file";
    if (lower === "multiedit")
        return "edit_file";
    if (lower === "write")
        return "create_file";
    if (lower === "bash")
        return "run_in_terminal";
    if (lower === "grep")
        return "grep_search";
    if (lower === "glob")
        return "glob_search";
    if (lower === "ls")
        return "list_dir";
    return lower || raw || "unknown_tool";
}
function filePathFromArgs(args) {
    return cleanString(args.file_path) || cleanString(args.filePath) || cleanString(args.path) || cleanString(args.uri);
}
function toolSummary(toolName, args) {
    const path = filePathFromArgs(args);
    if (toolName === "read_file")
        return path ? `读取文件：${path}` : "读取文件";
    if (toolName === "replace_string_in_file" || toolName === "edit_file")
        return path ? `修改文件：${path}` : "修改文件";
    if (toolName === "create_file")
        return path ? `写入文件：${path}` : "写入文件";
    if (toolName === "run_in_terminal")
        return cleanString(args.command) ? `执行命令：${String(args.command).slice(0, 300)}` : "执行命令";
    if (toolName === "grep_search")
        return cleanString(args.pattern) ? `搜索：${args.pattern}` : "搜索";
    if (toolName === "glob_search")
        return cleanString(args.pattern) ? `匹配文件：${args.pattern}` : "匹配文件";
    if (toolName === "list_dir")
        return path ? `列目录：${path}` : "列目录";
    return toolName;
}
function lineHash(filePath, text) {
    return hashText(`${filePath}\0${text}`);
}
function splitReplacementLines(value) {
    const lines = value.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "")
        lines.pop();
    return lines;
}
function countLinesBefore(value, index) {
    if (index <= 0)
        return 0;
    let count = 0;
    for (let cursor = 0; cursor < index; cursor += 1) {
        if (value.charCodeAt(cursor) === 10)
            count += 1;
    }
    return count;
}
function uniqueIndexOf(haystack, needle) {
    if (!needle)
        return undefined;
    const first = haystack.indexOf(needle);
    if (first < 0)
        return undefined;
    return haystack.indexOf(needle, first + needle.length) < 0 ? first : undefined;
}
function sequenceStartIndexes(haystack, needle) {
    if (needle.length === 0 || needle.length > haystack.length)
        return [];
    const matches = [];
    for (let index = 0; index <= haystack.length - needle.length; index += 1) {
        let matched = true;
        for (let offset = 0; offset < needle.length; offset += 1) {
            if (haystack[index + offset] !== needle[offset]) {
                matched = false;
                break;
            }
        }
        if (matched)
            matches.push(index);
    }
    return matches;
}
function resolvedToolFilePath(filePath, workspacePath, cwd) {
    if (isAbsolute(filePath))
        return filePath;
    const root = cwd || workspacePath;
    return root ? resolve(root, filePath) : undefined;
}
function gitPathspec(filePath, workspacePath, cwd) {
    const root = cwd || workspacePath;
    if (!root || filePath.includes("\0"))
        return undefined;
    const absolutePath = resolvedToolFilePath(filePath, workspacePath, cwd);
    if (!absolutePath)
        return undefined;
    const pathspec = isAbsolute(filePath) ? relative(root, absolutePath).replace(/\\/g, "/") : filePath.replace(/^\.?\//, "").replace(/\\/g, "/");
    if (!pathspec || pathspec.startsWith("../") || pathspec === ".." || isAbsolute(pathspec))
        return undefined;
    return { root, pathspec };
}
function parseGitDiffLines(diff) {
    const hunks = [];
    let current;
    let oldLine = 0;
    let newLine = 0;
    for (const line of diff.split(/\r?\n/)) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) {
            oldLine = Number.parseInt(hunk[1], 10);
            newLine = Number.parseInt(hunk[2], 10);
            current = { old_start: oldLine, new_start: newLine, lines: [] };
            hunks.push(current);
            continue;
        }
        if (!current || line.startsWith("\\ No newline"))
            continue;
        if (line.startsWith("+") && !line.startsWith("+++")) {
            current.lines.push({ line_type: "added", new_line: newLine, text: line.slice(1) });
            newLine += 1;
        }
        else if (line.startsWith("-") && !line.startsWith("---")) {
            current.lines.push({ line_type: "removed", old_line: oldLine, text: line.slice(1) });
            oldLine += 1;
        }
        else if (line.startsWith(" ")) {
            current.lines.push({ line_type: "context", old_line: oldLine, new_line: newLine, text: line.slice(1) });
            oldLine += 1;
            newLine += 1;
        }
    }
    return hunks;
}
async function gitDiffText(root, pathspec, staged) {
    try {
        const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", "diff", ...(staged ? ["--cached"] : []), "--unified=0", "--no-color", "--", pathspec], {
            cwd: root,
            timeout: 20000,
            maxBuffer: 1024 * 1024 * 100
        });
        return String(stdout || "");
    }
    catch {
        return "";
    }
}
function lineSequenceLocation(hunks, oldLines, newLines) {
    const candidates = [];
    for (const hunk of hunks) {
        const removed = hunk.lines.filter((line) => line.line_type === "removed");
        const added = hunk.lines.filter((line) => line.line_type === "added");
        const removedMatches = oldLines.length > 0 ? sequenceStartIndexes(removed.map((line) => line.text), oldLines) : [0];
        const addedMatches = newLines.length > 0 ? sequenceStartIndexes(added.map((line) => line.text), newLines) : [0];
        for (const removedIndex of removedMatches) {
            for (const addedIndex of addedMatches) {
                const oldStart = oldLines.length > 0 ? removed[removedIndex]?.old_line : added[addedIndex]?.new_line;
                const newStart = newLines.length > 0 ? added[addedIndex]?.new_line : removed[removedIndex]?.old_line;
                if (oldStart && newStart)
                    candidates.push({ oldStart, newStart });
            }
        }
    }
    return candidates.length === 1 ? candidates[0] : undefined;
}
async function absoluteReplacementLocation(filePath, oldText, newText, workspacePath, cwd) {
    const absolutePath = resolvedToolFilePath(filePath, workspacePath, cwd);
    if (absolutePath && newText) {
        try {
            const content = await readFile(absolutePath, "utf8");
            const matchIndex = uniqueIndexOf(content, newText);
            if (matchIndex !== undefined) {
                const startLine = countLinesBefore(content, matchIndex) + 1;
                return { oldStart: startLine, newStart: startLine };
            }
        }
        catch {
            // Fall through to git diff based resolution.
        }
    }
    const spec = gitPathspec(filePath, workspacePath, cwd);
    if (!spec)
        return undefined;
    const oldLines = splitReplacementLines(oldText);
    const newLines = splitReplacementLines(newText);
    for (const staged of [false, true]) {
        const diff = await gitDiffText(spec.root, spec.pathspec, staged);
        const location = lineSequenceLocation(parseGitDiffLines(diff), oldLines, newLines);
        if (location)
            return location;
    }
    return undefined;
}
async function diffFromReplacement(args, toolName, toolCallId, requestId, responseId, turnIndex, workspacePath, cwd) {
    const filePath = filePathFromArgs(args);
    if (!filePath)
        return undefined;
    const oldText = cleanString(args.old_string) ??
        cleanString(args.oldString) ??
        cleanString(args.original) ??
        "";
    const newText = cleanString(args.new_string) ??
        cleanString(args.newString) ??
        cleanString(args.replacement) ??
        cleanString(args.content) ??
        "";
    if (!oldText && !newText)
        return undefined;
    const oldLines = splitReplacementLines(oldText);
    const newLines = splitReplacementLines(newText);
    const absoluteLocation = await absoluteReplacementLocation(filePath, oldText, newText, workspacePath, cwd);
    const oldLineOffset = absoluteLocation !== undefined ? absoluteLocation.oldStart - 1 : 0;
    const newLineOffset = absoluteLocation !== undefined ? absoluteLocation.newStart - 1 : 0;
    const lineNumberBasis = absoluteLocation !== undefined ? "absolute" : "relative";
    const lines = [];
    oldLines.forEach((line, index) => {
        lines.push({
            line_type: "removed",
            old_line: oldLineOffset + index + 1,
            text: line,
            text_hash: lineHash(filePath, line)
        });
    });
    newLines.forEach((line, index) => {
        lines.push({
            line_type: "added",
            new_line: newLineOffset + index + 1,
            text: line,
            text_hash: lineHash(filePath, line)
        });
    });
    return {
        snapshot_kind: "claude_turn_tool_patch",
        file_path: filePath,
        lines_added: newLines.length,
        lines_deleted: oldLines.length,
        line_number_basis: lineNumberBasis,
        line_numbers_are_absolute: lineNumberBasis === "absolute",
        hunks: [
            {
                old_start: oldLineOffset + 1,
                old_lines: oldLines.length,
                new_start: newLineOffset + 1,
                new_lines: newLines.length,
                lines
            }
        ],
        request_id: requestId,
        response_id: responseId,
        turn_index: turnIndex,
        tool_call_id: toolCallId,
        tool_name: toolName,
        status: "complete",
        source: "claude_tool_arguments",
        raw_json: args
    };
}
async function latestClaudeProjectFile(options = {}) {
    if (options.sessionFile) {
        try {
            await stat(options.sessionFile);
            return options.sessionFile;
        }
        catch {
            // Fall through to discovery.
        }
    }
    const roots = [join(homedir(), ".claude", "projects"), join(homedir(), ".claude", "transcripts")];
    const candidates = [];
    async function walk(dir, depth = 0) {
        if (depth > 3)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full, depth + 1);
            }
            else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                try {
                    const st = await stat(full);
                    let score = 0;
                    if (options.sessionId && basename(full, ".jsonl") === options.sessionId)
                        score += 1000;
                    if (options.workspacePath && full.includes(options.workspacePath.replace(/\//g, "-")))
                        score += 100;
                    candidates.push({ path: full, mtimeMs: st.mtimeMs, score });
                }
                catch {
                    // Ignore races.
                }
            }
        }
    }
    for (const root of roots)
        await walk(root);
    candidates.sort((a, b) => (b.score - a.score) || (b.mtimeMs - a.mtimeMs));
    return candidates[0]?.path;
}
function usageFromMessage(message) {
    const usage = record(message?.usage) || {};
    const input = Number(usage.input_tokens ?? usage.prompt_tokens);
    const output = Number(usage.output_tokens ?? usage.completion_tokens);
    return {
        ...(Number.isFinite(input) ? { prompt_tokens: input } : {}),
        ...(Number.isFinite(output) ? { output_tokens: output, completion_tokens: output } : {})
    };
}
function contentBlocks(entry) {
    const message = record(entry.message);
    return array(message?.content);
}
function attachToolResult(turn, entry) {
    const at = isoTimestamp(entry.timestamp);
    updateTurnContext(turn, entry);
    for (const block of contentBlocks(entry)) {
        const rec = record(block);
        if (!rec || rec.type !== "tool_result")
            continue;
        const toolCallId = cleanString(rec.tool_use_id) || cleanString(entry.sourceToolAssistantUUID) || `tool_result_${hashJson(rec).slice(0, 16)}`;
        const content = textFromClaudeContent([rec]);
        const existing = turn.tools.get(toolCallId);
        const failed = isFailedToolResult(rec, entry);
        if (existing) {
            existing.status = failed ? "failed" : "complete";
            existing.result_raw = entry.toolUseResult || rec.content;
            existing.completed_at = at;
        }
        if (failed) {
            turn.codeChanges = turn.codeChanges.filter((change) => change.tool_call_id !== toolCallId);
        }
        turn.steps.push({
            step_id: hashText(`${turn.requestId}:tool_result:${toolCallId}:${content}`).slice(0, 32),
            step_type: "tool_result",
            text: content,
            text_hash: hashText(content),
            source: "claude_project_jsonl",
            source_event_type: "tool_result",
            tool_call_id: toolCallId,
            tool_name: existing?.tool_name,
            status: failed ? "failed" : "complete",
            occurred_at: at,
            actor_path: "top",
            actor_type: "assistant"
        });
    }
}
function isFailedToolResult(rec, entry) {
    if (rec.is_error === true || rec.isError === true)
        return true;
    const result = entry.toolUseResult ?? rec.content;
    if (typeof result === "string") {
        return /user rejected tool use|tool use was rejected|tool interrupted|request interrupted|cancelled|canceled|denied/i.test(result);
    }
    const resultRecord = record(result);
    if (resultRecord) {
        const status = cleanString(resultRecord.status) || cleanString(resultRecord.error) || "";
        if (/failed|error|rejected|interrupted|cancelled|canceled|denied/i.test(status))
            return true;
    }
    return false;
}
async function attachAssistantBlocks(turn, entry, workspacePath) {
    const message = record(entry.message);
    const at = isoTimestamp(entry.timestamp);
    updateTurnContext(turn, entry);
    const responseId = cleanString(message?.id) || cleanString(entry.uuid) || turn.responseId;
    if (responseId)
        turn.responseId = responseId;
    const model = cleanString(message?.model);
    if (model)
        turn.model = model;
    const usage = usageFromMessage(message);
    turn.usage.prompt_tokens = usage.prompt_tokens ?? turn.usage.prompt_tokens;
    turn.usage.output_tokens = usage.output_tokens ?? turn.usage.output_tokens;
    turn.usage.completion_tokens = usage.completion_tokens ?? turn.usage.completion_tokens;
    for (const block of contentBlocks(entry)) {
        const rec = record(block);
        if (!rec)
            continue;
        const type = String(rec.type || "");
        if (type === "thinking") {
            const thinking = cleanString(rec.thinking);
            if (thinking) {
                turn.steps.push({
                    step_id: hashText(`${turn.requestId}:thinking:${hashText(thinking)}`).slice(0, 32),
                    step_type: "visible_reasoning",
                    text: thinking,
                    text_hash: hashText(thinking),
                    source: "claude_project_jsonl",
                    source_event_type: "thinking",
                    occurred_at: at,
                    actor_path: "top",
                    actor_type: "assistant"
                });
            }
            continue;
        }
        if (type === "tool_use") {
            const toolCallId = cleanString(rec.id) || `call_${hashJson(rec).slice(0, 16)}`;
            const toolName = normalizeToolName(rec.name);
            const args = record(rec.input) || {};
            const summary = toolSummary(toolName, args);
            const stepId = hashText(`${turn.requestId}:tool_call:${toolCallId}:${summary}`).slice(0, 32);
            const toolCall = {
                step_id: stepId,
                tool_call_id: toolCallId,
                tool_name: toolName,
                arguments_raw: args,
                status: "requested",
                started_at: at,
                actor_path: "top",
                actor_type: "assistant",
                source: "claude_project_jsonl"
            };
            turn.tools.set(toolCallId, toolCall);
            turn.steps.push({
                step_id: stepId,
                step_type: "tool_call",
                text: summary,
                text_hash: hashText(summary),
                source: "claude_project_jsonl",
                source_event_type: "tool_use",
                tool_call_id: toolCallId,
                tool_name: toolName,
                status: "requested",
                occurred_at: at,
                actor_path: "top",
                actor_type: "assistant"
            });
            if (["replace_string_in_file", "edit_file", "create_file"].includes(toolName)) {
                const change = await diffFromReplacement(args, toolName, toolCallId, turn.requestId, responseId, turn.turnIndex, workspacePath, turn.cwd);
                if (change)
                    turn.codeChanges.push(change);
            }
            continue;
        }
        if (type === "text") {
            const text = cleanString(rec.text);
            if (text) {
                turn.steps.push({
                    step_id: hashText(`${turn.requestId}:assistant_progress:${hashText(text)}`).slice(0, 32),
                    step_type: "assistant_progress",
                    text,
                    text_hash: hashText(text),
                    source: "claude_project_jsonl",
                    source_event_type: "assistant_text",
                    occurred_at: at,
                    actor_path: "top",
                    actor_type: "assistant"
                });
            }
        }
    }
}
function updateTurnContext(turn, entry) {
    turn.cwd = cleanString(entry.cwd) || turn.cwd;
    turn.gitBranch = cleanString(entry.gitBranch) || turn.gitBranch;
    turn.entrypoint = cleanString(entry.entrypoint) || turn.entrypoint;
    turn.version = cleanString(entry.version) || turn.version;
}
function markTurnInterrupted(turn, occurredAt) {
    turn.status = "failed";
    turn.interrupted = true;
    turn.interruptReason = "request_interrupted_by_user";
    turn.finishReason = "request_interrupted_by_user";
    turn.completedAt = occurredAt || turn.assistantAt || turn.startedAt;
}
function markTurnAbandoned(turn, occurredAt) {
    turn.status = "failed";
    turn.abandoned = true;
    turn.finishReason = "next_user_turn_started";
    turn.completedAt = occurredAt || turn.assistantAt || turn.startedAt;
}
function finalizeTurn(turn, sourcePath, sourceInfo) {
    const responseId = turn.responseId || `${turn.requestId}:no_response`;
    const confirmedCodeChanges = turn.codeChanges.filter((change) => {
        const toolCall = change.tool_call_id ? turn.tools.get(change.tool_call_id) : undefined;
        return !toolCall || toolCall.status === "complete";
    });
    for (const change of confirmedCodeChanges) {
        change.request_id = turn.requestId;
        change.response_id = responseId;
        change.turn_index = turn.turnIndex;
    }
    const finalAssistantHash = turn.assistantText ? hashText(turn.assistantText) : undefined;
    const processSteps = turn.steps.filter((step) => {
        if (step.step_type !== "assistant_progress")
            return true;
        return Boolean(finalAssistantHash && step.text_hash !== finalAssistantHash);
    });
    const visibleReasoning = processSteps.filter((step) => step.step_type === "visible_reasoning");
    const assistantProgress = processSteps.filter((step) => step.step_type === "assistant_progress");
    const elapsedMs = turn.startedAt && turn.completedAt
        ? Math.max(0, Date.parse(turn.completedAt) - Date.parse(turn.startedAt))
        : undefined;
    const requestUsage = [
        {
            request_id: turn.requestId,
            response_id: responseId,
            request_index: Math.max(turn.turnIndex - 1, 0),
            turn_index: turn.turnIndex,
            model: turn.model,
            prompt_tokens: turn.usage.prompt_tokens,
            output_tokens: turn.usage.output_tokens,
            completion_tokens: turn.usage.completion_tokens,
            elapsed_ms: elapsedMs,
            credits_source: "claude",
            occurred_at: turn.completedAt
        }
    ];
    const turnSourceInfo = {
        ...sourceInfo,
        next_offset: turn.status === "incomplete" ? turn.startOffset : turn.endOffset
    };
    return {
        schema_version: "claude.turn_snapshot.v1",
        session_id: turn.sessionId,
        request_id: turn.requestId,
        response_id: responseId,
        turn_index: turn.turnIndex,
        attempt: 1,
        source: "claude_project_jsonl",
        cwd: turn.cwd,
        git_branch: turn.gitBranch,
        claude_entrypoint: turn.entrypoint,
        claude_version: turn.version,
        title: turn.userText.slice(0, 80),
        model: turn.model,
        resolved_model: turn.model,
        user_message: {
            role: "user",
            text: turn.userText,
            text_hash: hashText(turn.userText),
            source: "claude_project_jsonl",
            occurred_at: turn.userAt
        },
        assistant_message: turn.assistantText
            ? {
                role: "assistant",
                text: turn.assistantText,
                text_hash: hashText(turn.assistantText),
                source: "claude_project_jsonl",
                occurred_at: turn.assistantAt
            }
            : undefined,
        messages: turn.messages,
        assistant_progress: assistantProgress,
        visible_reasoning: visibleReasoning,
        process_steps: processSteps,
        tool_calls: [...turn.tools.values()],
        code_changes: confirmedCodeChanges,
        request_usage: requestUsage,
        usage_totals: {
            prompt_tokens: turn.usage.prompt_tokens,
            output_tokens: turn.usage.output_tokens,
            completion_tokens: turn.usage.completion_tokens,
            elapsed_ms: elapsedMs
        },
        turn: {
            turn_index: turn.turnIndex,
            request_id: turn.requestId,
            response_id: responseId,
            attempt: 1,
            status: turn.status,
            interrupted: turn.interrupted || undefined,
            interrupt_reason: turn.interruptReason,
            abandoned: turn.abandoned || undefined,
            finish_reason: turn.finishReason,
            started_at: turn.startedAt,
            completed_at: turn.completedAt
        },
        source_files: {
            claude_project_jsonl: turnSourceInfo,
            parser_version: CLAUDE_TURN_PARSER_VERSION,
            capture_limitations: "Captured from Claude Code project JSONL. Visible thinking and tool calls are included when present. Hidden model reasoning is not available. Bash-created file diffs are only attributable when Claude logs explicit edit/write tool arguments."
        }
    };
}
export async function captureLatestClaudeTurnSnapshots(options = {}) {
    const file = await latestClaudeProjectFile(options);
    if (!file)
        throw new Error("No Claude Code JSONL file found under ~/.claude/projects or ~/.claude/transcripts");
    const filePath = file;
    const segment = await readJsonlSegment(filePath, options.startOffset);
    const sourceInfo = {
        path: filePath.replace(homedir(), "~"),
        sha256: hashText(segment.raw),
        mtime_ms: segment.mtimeMs,
        size_bytes: segment.size,
        read_offset: segment.startOffset,
        next_offset: segment.nextOffset,
        hash_scope: segment.startOffset > 0 ? "read_segment" : "full_file"
    };
    const entries = [];
    let lineOffset = segment.startOffset;
    for (const rawLine of segment.raw.match(/[^\n]*\n/g) || []) {
        const lineStartOffset = lineOffset;
        const lineEndOffset = lineStartOffset + Buffer.byteLength(rawLine, "utf8");
        lineOffset = lineEndOffset;
        const line = rawLine.replace(/\r?\n$/, "");
        if (!line)
            continue;
        try {
            entries.push({
                entry: JSON.parse(line),
                lineStartOffset,
                lineEndOffset
            });
        }
        catch {
            // Ignore malformed lines inside an otherwise complete segment.
        }
    }
    const turns = [];
    let current;
    const requestedSessionId = options.sessionId;
    let turnIndex = await countPriorClaudeUserTurns(filePath, segment.startOffset, requestedSessionId);
    function finishCurrent() {
        if (!current)
            return;
        if (!current.completedAt)
            current.completedAt = current.assistantAt || current.startedAt;
        turns.push(finalizeTurn(current, filePath, sourceInfo));
        current = undefined;
    }
    for (const { entry, lineStartOffset, lineEndOffset } of entries) {
        const sessionId = cleanString(entry.sessionId) || cleanString(entry.session_id) || requestedSessionId || basename(filePath, ".jsonl");
        if (requestedSessionId && sessionId !== requestedSessionId)
            continue;
        if (isClaudeUserInterruptMarker(entry)) {
            if (current) {
                markTurnInterrupted(current, isoTimestamp(entry.timestamp));
                current.endOffset = lineEndOffset;
                finishCurrent();
            }
            continue;
        }
        if (isRealUserPrompt(entry)) {
            if (current && current.status === "incomplete") {
                markTurnAbandoned(current, isoTimestamp(entry.timestamp));
            }
            finishCurrent();
            turnIndex += 1;
            const text = textFromEntry(entry);
            if (!text)
                continue;
            const requestId = cleanString(entry.uuid) || cleanString(entry.promptId) || stableEventId(`claude:request:${sessionId}:${turnIndex}:${text}`);
            const at = isoTimestamp(entry.timestamp);
            const message = record(entry.message);
            current = {
                sessionId,
                turnIndex,
                requestId,
                startOffset: lineStartOffset,
                endOffset: lineEndOffset,
                userText: text,
                userAt: at,
                userKey: requestId,
                status: "incomplete",
                startedAt: at,
                cwd: cleanString(entry.cwd),
                gitBranch: cleanString(entry.gitBranch),
                entrypoint: cleanString(entry.entrypoint),
                version: cleanString(entry.version),
                messages: [
                    {
                        role: "user",
                        text,
                        text_hash: hashText(text),
                        source: "claude_project_jsonl",
                        source_key: requestId,
                        occurred_at: at
                    }
                ],
                steps: [],
                tools: new Map(),
                codeChanges: [],
                usage: {}
            };
            current.steps.push(...claudeContextStepsFromContent(message?.content, requestId, at));
            continue;
        }
        if (!current)
            continue;
        if (entry.type === "user" && contentBlocks(entry).some((block) => record(block)?.type === "tool_result")) {
            attachToolResult(current, entry);
            current.endOffset = lineEndOffset;
            continue;
        }
        if (entry.type === "assistant") {
            const message = record(entry.message);
            await attachAssistantBlocks(current, entry, options.workspacePath);
            current.endOffset = lineEndOffset;
            const text = assistantTextFromEntry(entry);
            const at = isoTimestamp(entry.timestamp);
            const hasError = Boolean(entry.error || entry.isApiErrorMessage || entry.apiErrorStatus);
            if (text) {
                current.assistantText = [current.assistantText, text].filter(Boolean).join("\n");
                current.assistantAt = at;
                current.messages.push({
                    role: "assistant",
                    text,
                    text_hash: hashText(text),
                    source: "claude_project_jsonl",
                    source_key: cleanString(message?.id) || cleanString(entry.uuid) || hashText(text).slice(0, 32),
                    occurred_at: at
                });
            }
            if (hasError) {
                current.status = "failed";
                current.completedAt = at;
                current.steps.push({
                    step_id: hashText(`${current.requestId}:error:${entry.error || entry.apiErrorStatus || text}`).slice(0, 32),
                    step_type: "error",
                    text: text || String(entry.error || entry.apiErrorStatus || "Claude execution error"),
                    text_hash: hashText(text || String(entry.error || entry.apiErrorStatus || "Claude execution error")),
                    source: "claude_project_jsonl",
                    source_event_type: "assistant_error",
                    status: "failed",
                    occurred_at: at,
                    actor_path: "top",
                    actor_type: "assistant"
                });
                finishCurrent();
            }
            else if (String(message?.stop_reason || "") !== "tool_use" && text) {
                current.status = "completed";
                current.completedAt = at;
                finishCurrent();
            }
        }
    }
    finishCurrent();
    const output = turns.filter((turn) => turn.messages.some((message) => message.role === "user"));
    return options.latestOnly === false ? output : output.slice(-1);
}
