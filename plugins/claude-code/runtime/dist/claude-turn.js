import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { stableEventId } from "./event-schema.js";
export const CLAUDE_TURN_PARSER_VERSION = "claude-turn-v1.0.2";
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
    const text = textFromClaudeContent(content, { excludeToolBlocks: true, excludeSystemReminder: true }).trim();
    if (!text)
        return false;
    if (/^\[Request interrupted by user/i.test(text))
        return false;
    return true;
}
function textFromClaudeContent(content, options = {}) {
    if (typeof content === "string")
        return content;
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
            if (options.excludeSystemReminder && /<system-reminder>[\s\S]*?<\/system-reminder>/i.test(text)) {
                return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
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
        excludeSystemReminder: true
    });
}
function assistantTextFromEntry(entry) {
    const message = record(entry.message);
    return textFromClaudeContent(message?.content, {
        excludeToolBlocks: true,
        excludeSystemReminder: true,
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
function diffFromReplacement(args, toolName, toolCallId, requestId, responseId, turnIndex) {
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
    const oldLines = oldText.split(/\r?\n/).filter((line) => line.length > 0);
    const newLines = newText.split(/\r?\n/).filter((line) => line.length > 0);
    const lines = [];
    oldLines.forEach((line, index) => {
        lines.push({
            line_type: "removed",
            old_line: index + 1,
            text: line,
            text_hash: lineHash(filePath, line)
        });
    });
    newLines.forEach((line, index) => {
        lines.push({
            line_type: "added",
            new_line: index + 1,
            text: line,
            text_hash: lineHash(filePath, line)
        });
    });
    return {
        snapshot_kind: "claude_turn_tool_patch",
        file_path: filePath,
        lines_added: newLines.length,
        lines_deleted: oldLines.length,
        hunks: [
            {
                old_start: 1,
                old_lines: oldLines.length,
                new_start: 1,
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
        if (existing) {
            existing.status = rec.is_error ? "failed" : "complete";
            existing.result_raw = entry.toolUseResult || rec.content;
            existing.completed_at = at;
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
            status: rec.is_error ? "failed" : "complete",
            occurred_at: at,
            actor_path: "top",
            actor_type: "assistant"
        });
    }
}
function attachAssistantBlocks(turn, entry) {
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
                const change = diffFromReplacement(args, toolName, toolCallId, turn.requestId, responseId, turn.turnIndex);
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
function finalizeTurn(turn, sourcePath, sourceInfo) {
    const responseId = turn.responseId || `${turn.requestId}:no_response`;
    for (const change of turn.codeChanges) {
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
        code_changes: turn.codeChanges,
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
            started_at: turn.startedAt,
            completed_at: turn.completedAt
        },
        source_files: {
            claude_project_jsonl: sourceInfo,
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
    const raw = await readFile(filePath, "utf8");
    const st = await stat(filePath);
    const sourceInfo = {
        path: filePath.replace(homedir(), "~"),
        sha256: hashText(raw),
        mtime_ms: st.mtimeMs,
        size_bytes: st.size
    };
    const entries = raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
        try {
            return JSON.parse(line);
        }
        catch {
            return undefined;
        }
    })
        .filter((entry) => Boolean(entry));
    const turns = [];
    let current;
    let turnIndex = 0;
    const requestedSessionId = options.sessionId;
    function finishCurrent() {
        if (!current)
            return;
        if (!current.completedAt)
            current.completedAt = current.assistantAt || current.startedAt;
        turns.push(finalizeTurn(current, filePath, sourceInfo));
        current = undefined;
    }
    for (const entry of entries) {
        const sessionId = cleanString(entry.sessionId) || cleanString(entry.session_id) || requestedSessionId || basename(filePath, ".jsonl");
        if (requestedSessionId && sessionId !== requestedSessionId)
            continue;
        if (isRealUserPrompt(entry)) {
            finishCurrent();
            turnIndex += 1;
            const text = textFromEntry(entry);
            if (!text)
                continue;
            const requestId = cleanString(entry.uuid) || cleanString(entry.promptId) || stableEventId(`claude:request:${sessionId}:${turnIndex}:${text}`);
            const at = isoTimestamp(entry.timestamp);
            current = {
                sessionId,
                turnIndex,
                requestId,
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
            continue;
        }
        if (!current)
            continue;
        if (entry.type === "user" && contentBlocks(entry).some((block) => record(block)?.type === "tool_result")) {
            attachToolResult(current, entry);
            continue;
        }
        if (entry.type === "assistant") {
            const message = record(entry.message);
            attachAssistantBlocks(current, entry);
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
