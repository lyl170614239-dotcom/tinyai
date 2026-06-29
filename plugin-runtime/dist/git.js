import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_TINYAI_ENV_FILE, tinyAiCollectorFallbackUrlsForTool, tinyAiCollectorUrlForTool } from "./config.js";
import { redactText } from "./redactor.js";
const execFileAsync = promisify(execFile);
async function git(workspacePath, args, timeout = 10000) {
    const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], { cwd: workspacePath, timeout });
    return stdout.trim();
}
async function resolvedGitDir(workspacePath) {
    const gitDir = await git(workspacePath, ["rev-parse", "--git-dir"]);
    return gitDir.startsWith("/") ? gitDir : join(workspacePath, gitDir);
}
async function aiActivityMarkerPath(workspacePath) {
    return join(await resolvedGitDir(workspacePath), "tinyai-observability", "ai-activity.json");
}
async function aiLineEvidencePath(workspacePath) {
    return join(await resolvedGitDir(workspacePath), "tinyai-observability", "ai-line-spans.jsonl");
}
function markerTtlMs() {
    const seconds = Number.parseInt(process.env.TINYAI_OBS_AI_MARKER_TTL_SECONDS || "21600", 10);
    return (Number.isFinite(seconds) && seconds > 0 ? seconds : 21600) * 1000;
}
function lineHash(filePath, content) {
    return createHash("sha256").update(`${filePath}\0${content}`).digest("hex");
}
function isSensitiveDiffPath(filePath) {
    const normalized = filePath.toLowerCase();
    return (/(^|\/)\.env(?:\.|$)/.test(normalized) ||
        /(^|\/)(\.?npmrc|\.?pypirc|\.?netrc|id_rsa|id_ed25519)$/.test(normalized) ||
        /(secret|secrets|credential|credentials|token|private-key|private_key)/.test(normalized));
}
function decodeGitQuotedPath(raw) {
    const trimmed = raw.trim();
    const isQuoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
    const inner = isQuoted ? trimmed.slice(1, -1) : trimmed;
    if (!/\\(?:[0-7]{3}|[abfnrtv\\"'])/.test(inner))
        return trimmed;
    const bytes = [];
    for (let index = 0; index < inner.length; index += 1) {
        const char = inner[index];
        if (char !== "\\") {
            for (const byte of Buffer.from(char, "utf8"))
                bytes.push(byte);
            continue;
        }
        const next = inner[index + 1];
        const octal = inner.slice(index + 1, index + 4);
        if (/^[0-7]{3}$/.test(octal)) {
            bytes.push(Number.parseInt(octal, 8));
            index += 3;
            continue;
        }
        const escapes = {
            a: 0x07,
            b: 0x08,
            f: 0x0c,
            n: 0x0a,
            r: 0x0d,
            t: 0x09,
            v: 0x0b,
            "\\": 0x5c,
            '"': 0x22,
            "'": 0x27
        };
        if (next && Object.prototype.hasOwnProperty.call(escapes, next)) {
            bytes.push(escapes[next]);
            index += 1;
        }
        else {
            bytes.push(0x5c);
        }
    }
    return Buffer.from(bytes).toString("utf8");
}
function normalizeDiffPath(raw) {
    let path = decodeGitQuotedPath(raw.trim()).replace(/\\/g, "/");
    if (path.startsWith("a/") || path.startsWith("b/"))
        path = path.slice(2);
    return path;
}
function safeDiffLineText(filePath, text, includeText) {
    if (!includeText)
        return { text: "[text not stored]", redacted: true };
    if (isSensitiveDiffPath(filePath))
        return { text: "[REDACTED:SENSITIVE_FILE]", redacted: true };
    const redacted = redactText(text, { allowFullConversationText: true });
    return { text: redacted, redacted: redacted !== text };
}
function parseUnifiedDiffDetails(diff, options = {}) {
    const includeText = options.includeText ?? true;
    const maxFiles = options.maxFiles ?? 30;
    const maxLinesPerFile = options.maxLinesPerFile ?? 240;
    const files = [];
    let currentFile;
    let currentHunk;
    let pendingOldPath;
    let oldLine = 0;
    let newLine = 0;
    let totalAdded = 0;
    let totalDeleted = 0;
    let truncated = false;
    function pushFile(file) {
        if (!file)
            return;
        if (files.length >= maxFiles) {
            truncated = true;
            return;
        }
        files.push(file);
    }
    function addLine(lineType, rawText) {
        if (!currentFile || !currentHunk)
            return;
        if (currentFile.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) >= maxLinesPerFile) {
            truncated = true;
            return;
        }
        const display = safeDiffLineText(currentFile.file_path, rawText, includeText);
        const detail = {
            line_type: lineType,
            text: display.text,
            text_hash: lineHash(currentFile.file_path, rawText)
        };
        if (display.redacted)
            detail.redacted = true;
        if (lineType === "added") {
            detail.new_line = newLine;
            currentFile.lines_added += 1;
            totalAdded += 1;
            newLine += 1;
        }
        else if (lineType === "removed") {
            detail.old_line = oldLine;
            currentFile.lines_deleted += 1;
            totalDeleted += 1;
            oldLine += 1;
        }
        else {
            detail.old_line = oldLine;
            detail.new_line = newLine;
            oldLine += 1;
            newLine += 1;
        }
        currentHunk.lines.push(detail);
    }
    for (const line of diff.split(/\r?\n/)) {
        if (line.startsWith("diff --git ")) {
            pushFile(currentFile);
            currentFile = undefined;
            currentHunk = undefined;
            pendingOldPath = undefined;
            continue;
        }
        if (line.startsWith("Binary files ")) {
            if (currentFile)
                currentFile.binary = true;
            continue;
        }
        if (line.startsWith("--- ")) {
            const oldPath = line.slice(4).trim();
            pendingOldPath = oldPath === "/dev/null" ? undefined : normalizeDiffPath(oldPath);
            continue;
        }
        if (line.startsWith("+++ ")) {
            const path = line.slice(4).trim();
            const filePath = path === "/dev/null" ? currentFile?.old_path || "" : normalizeDiffPath(path);
            currentFile = {
                file_path: filePath,
                old_path: pendingOldPath,
                sensitive: isSensitiveDiffPath(filePath),
                lines_added: 0,
                lines_deleted: 0,
                hunks: []
            };
            continue;
        }
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk && currentFile) {
            oldLine = Number.parseInt(hunk[1], 10);
            newLine = Number.parseInt(hunk[3], 10);
            currentHunk = {
                old_start: oldLine,
                old_lines: Number.parseInt(hunk[2] || "1", 10),
                new_start: newLine,
                new_lines: Number.parseInt(hunk[4] || "1", 10),
                lines: []
            };
            currentFile.hunks.push(currentHunk);
            continue;
        }
        if (!currentFile || !currentHunk || line.startsWith("\\ No newline"))
            continue;
        if (line.startsWith("+") && !line.startsWith("+++")) {
            addLine("added", line.slice(1));
        }
        else if (line.startsWith("-") && !line.startsWith("---")) {
            addLine("removed", line.slice(1));
        }
        else if (line.startsWith(" ")) {
            addLine("context", line.slice(1));
        }
    }
    pushFile(currentFile);
    const filePaths = files.map((file) => file.file_path).filter(Boolean);
    return {
        snapshot_kind: "workspace_diff",
        diff_hash: createHash("sha256").update(diff).digest("hex").slice(0, 32),
        include_text: includeText,
        truncated,
        files_changed: filePaths.length,
        lines_added: totalAdded,
        lines_deleted: totalDeleted,
        file_paths: filePaths.slice(0, 100),
        files
    };
}
function parseUnifiedAddedLines(diff) {
    const added = [];
    let currentFile = "";
    let newLine = 0;
    for (const line of diff.split(/\r?\n/)) {
        if (line.startsWith("diff --git ")) {
            currentFile = "";
            continue;
        }
        if (line.startsWith("+++ ")) {
            const path = line.slice(4).trim();
            currentFile = path === "/dev/null" ? "" : normalizeDiffPath(path);
            continue;
        }
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) {
            newLine = Number.parseInt(hunk[1], 10);
            continue;
        }
        if (!currentFile || !line)
            continue;
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
async function diffAddedLines(workspacePath, args) {
    try {
        return parseUnifiedAddedLines(await git(workspacePath, args, 20000));
    }
    catch {
        return [];
    }
}
export async function markAiActivity(workspacePath, options) {
    try {
        const path = await aiActivityMarkerPath(workspacePath);
        const now = new Date();
        const ttlMs = options.ttlSeconds && options.ttlSeconds > 0 ? options.ttlSeconds * 1000 : markerTtlMs();
        const marker = {
            tool: options.tool,
            task_id: options.taskId,
            source: options.source,
            marked_at: now.toISOString(),
            expires_at: new Date(now.getTime() + ttlMs).toISOString()
        };
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(marker, null, 2));
        return marker;
    }
    catch {
        return undefined;
    }
}
export async function recordAiLineSnapshot(workspacePath, options) {
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
    const evidence = addedLines.map((line) => ({
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
async function readActiveAiMarker(workspacePath) {
    try {
        const raw = await readFile(await aiActivityMarkerPath(workspacePath), "utf8");
        const marker = JSON.parse(raw);
        const markedAt = Date.parse(marker.marked_at);
        const expiresAt = Date.parse(marker.expires_at);
        const now = Date.now();
        if (!Number.isFinite(markedAt) || !Number.isFinite(expiresAt) || expiresAt < now)
            return undefined;
        return { marker, age_seconds: Math.max(0, Math.round((now - markedAt) / 1000)) };
    }
    catch {
        return undefined;
    }
}
async function readAiLineEvidence(workspacePath) {
    try {
        const raw = await readFile(await aiLineEvidencePath(workspacePath), "utf8");
        const now = Date.now();
        return raw
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((item) => Date.parse(item.expires_at) >= now);
    }
    catch {
        return [];
    }
}
async function lineAttributionForCommit(workspacePath, ref = "HEAD") {
    const commitLines = await diffAddedLines(workspacePath, ["show", "--unified=0", "--no-color", "--format=", ref, "--", "."]);
    const evidence = await readAiLineEvidence(workspacePath);
    const evidenceCounts = new Map();
    for (const item of evidence) {
        const key = `${item.file_path}\0${item.line_hash}`;
        const bucket = evidenceCounts.get(key) || [];
        bucket.push(item);
        evidenceCounts.set(key, bucket);
    }
    const files = new Map();
    let aiAdded = 0;
    for (const line of commitLines) {
        const file = files.get(line.file_path) || { file_path: line.file_path, ai_lines: [], human_lines: [] };
        const key = `${line.file_path}\0${line.line_hash}`;
        const bucket = evidenceCounts.get(key) || [];
        const matched = bucket.shift();
        if (matched) {
            aiAdded += 1;
            file.ai_lines.push({ new_line: line.new_line, line_hash: line.line_hash, evidence_source: matched.source });
        }
        else {
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
async function attribution(workspacePath, options = {}) {
    const activeMarker = await readActiveAiMarker(workspacePath);
    const aiAssisted = options.aiAssisted ?? (options.requireAiMarker ? Boolean(activeMarker) : true);
    const evidence = options.attributionEvidence ||
        (activeMarker ? "active_ai_task_marker" : options.requireAiMarker ? "no_active_ai_task_marker" : "manual_snapshot");
    return {
        ai_assisted: aiAssisted,
        ai_attribution_evidence: evidence,
        ai_marker_task_id: activeMarker?.marker.task_id,
        ai_marker_age_seconds: activeMarker?.age_seconds
    };
}
function parseNumstat(stdout) {
    const rows = stdout.split("\n").filter(Boolean);
    let linesAdded = 0;
    let linesDeleted = 0;
    const filePaths = [];
    for (const row of rows) {
        const parts = row.includes("\t") ? row.split("\t") : row.split(/\s+/);
        const [added, deleted, ...pathParts] = parts;
        const filePath = normalizeDiffPath(pathParts.join(row.includes("\t") ? "\t" : " "));
        if (filePath)
            filePaths.push(filePath);
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
export async function diffSummary(workspacePath) {
    try {
        return parseNumstat(await git(workspacePath, ["diff", "--numstat", "--", "."]));
    }
    catch {
        return { files_changed: 0, lines_added: 0, lines_deleted: 0, file_paths: [] };
    }
}
export async function currentDiffDetails(workspacePath, options = {}) {
    try {
        const paths = normalizePathspecs(options.paths);
        const pathspecs = paths.length > 0 ? paths : ["."];
        const args = [options.staged ? "diff" : "diff", options.staged ? "--cached" : "", "--unified=3", "--no-color", "--", ...pathspecs].filter(Boolean);
        const trackedDiff = await git(workspacePath, args, 30000);
        const untrackedDiff = options.includeUntracked && !options.staged ? await untrackedFilesDiff(workspacePath, pathspecs, options.includeText ?? true) : "";
        const diff = [trackedDiff, untrackedDiff].filter(Boolean).join("\n");
        return {
            ...parseUnifiedDiffDetails(diff, options),
            diff_raw: diff || undefined
        };
    }
    catch {
        return {
            snapshot_kind: "workspace_diff",
            diff_hash: "",
            diff_raw: undefined,
            include_text: options.includeText ?? true,
            truncated: false,
            files_changed: 0,
            lines_added: 0,
            lines_deleted: 0,
            file_paths: [],
            files: []
        };
    }
}
function normalizePathspecs(paths) {
    const output = new Set();
    for (const raw of paths || []) {
        let value = raw.trim().replace(/\\/g, "/");
        if (!value || value.includes("\0"))
            continue;
        value = value.replace(/^file:\/\//, "");
        value = value.replace(/^\.?\//, "");
        if (value.startsWith("a/") || value.startsWith("b/"))
            value = value.slice(2);
        if (value && value.length < 1000)
            output.add(value);
    }
    return [...output].slice(0, 50);
}
async function untrackedFilesDiff(workspacePath, pathspecs, includeText) {
    let raw = "";
    try {
        raw = await git(workspacePath, ["ls-files", "--others", "--exclude-standard", "--", ...pathspecs], 20000);
    }
    catch {
        return "";
    }
    const files = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 50);
    const chunks = [];
    for (const filePath of files) {
        if (isSensitiveDiffPath(filePath))
            continue;
        try {
            const content = await readFile(join(workspacePath, filePath), "utf8");
            const lines = content.split(/\r?\n/);
            if (lines.length > 0 && lines[lines.length - 1] === "")
                lines.pop();
            chunks.push([
                `diff --git a/${filePath} b/${filePath}`,
                "new file mode 100644",
                "--- /dev/null",
                `+++ b/${filePath}`,
                `@@ -0,0 +1,${lines.length} @@`,
                ...lines.map((line) => `+${includeText ? line : "[text not stored]"}`)
            ].join("\n"));
        }
        catch {
            // Best effort: an unreadable untracked file should not block tracked diff capture.
        }
    }
    return chunks.join("\n");
}
export async function currentBranch(workspacePath) {
    try {
        return await git(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    }
    catch {
        return undefined;
    }
}
export async function currentHead(workspacePath) {
    try {
        return await git(workspacePath, ["rev-parse", "HEAD"]);
    }
    catch {
        return undefined;
    }
}
export async function commitSnapshot(workspacePath, ref = "HEAD", options = {}) {
    try {
        const summary = parseNumstat(await git(workspacePath, ["show", "--numstat", "--format=", ref, "--", "."]));
        const attr = await attribution(workspacePath, options);
        const diffRaw = await git(workspacePath, ["show", "--unified=3", "--no-color", "--format=", ref, "--", "."], 30000);
        const diffDetails = parseUnifiedDiffDetails(diffRaw, { includeText: true, maxFiles: 1000, maxLinesPerFile: 20000 });
        return {
            ...summary,
            commit_sha: await git(workspacePath, ["rev-parse", ref]),
            branch: await currentBranch(workspacePath),
            snapshot_kind: "commit",
            diff_hash: diffDetails.diff_hash,
            diff_raw: diffRaw,
            include_text: true,
            truncated: diffDetails.truncated,
            files: diffDetails.files,
            ...attr,
            ai_lines_added: 0,
            ai_lines_deleted: 0,
            ai_lines_modified: 0,
            human_lines_added: summary.lines_added,
            human_lines_deleted: summary.lines_deleted,
            human_lines_modified: 0,
            ai_added_ratio: 0,
            ai_deleted_ratio: 0,
            ai_modified_ratio: 0,
            ai_overall_change_ratio: 0,
            line_attribution: { total_added_lines: summary.lines_added, ai_added_lines: 0, human_added_lines: summary.lines_added, files: [] },
            ai_attribution_method: "server_commit_diff_matched_to_ai_code_changes"
        };
    }
    catch {
        return {
            files_changed: 0,
            lines_added: 0,
            lines_deleted: 0,
            file_paths: [],
            snapshot_kind: "commit",
            ai_assisted: false,
            ai_lines_added: 0,
            ai_lines_deleted: 0,
            ai_lines_modified: 0,
            ai_attribution_method: "server_commit_diff_matched_to_ai_code_changes",
            ai_attribution_evidence: "snapshot_failed",
            human_lines_added: 0,
            human_lines_deleted: 0,
            human_lines_modified: 0,
            ai_added_ratio: 0,
            ai_deleted_ratio: 0,
            ai_modified_ratio: 0,
            ai_overall_change_ratio: 0,
            line_attribution: { total_added_lines: 0, ai_added_lines: 0, human_added_lines: 0, files: [] }
        };
    }
}
async function upstreamRef(workspacePath) {
    try {
        return await git(workspacePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    }
    catch {
        return undefined;
    }
}
async function commitCount(workspacePath, range) {
    try {
        return Number.parseInt(await git(workspacePath, ["rev-list", "--count", range]), 10) || 0;
    }
    catch {
        return 0;
    }
}
export async function pushSnapshot(workspacePath, options = {}) {
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
    }
    catch {
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
export async function installGitHooks(workspacePath, options) {
    const gitDir = await resolvedGitDir(workspacePath);
    const hooksDir = join(gitDir, "hooks");
    await mkdir(hooksDir, { recursive: true });
    const hookScript = fileURLToPath(new URL("./hook.js", import.meta.url));
    const envFile = options.envFile || process.env.TINYAI_OBS_ENV_FILE || DEFAULT_TINYAI_ENV_FILE;
    const hookTool = process.env.TINYAI_OBS_GIT_HOOK_TOOL || "copilot";
    const fallbackUrls = (options.fallbackUrls && options.fallbackUrls.length > 0 ? options.fallbackUrls : tinyAiCollectorFallbackUrlsForTool(options.tool, workspacePath)).filter(Boolean);
    const fallbackEnv = fallbackUrls.length > 0 ? fallbackUrls.join(",") : process.env.TINYAI_OBS_COLLECTOR_URLS;
    const setupLines = [
        `TINYAI_OBS_ENV_FILE=${shellQuote(envFile)}`,
        `if [ -f "$TINYAI_OBS_ENV_FILE" ]; then . "$TINYAI_OBS_ENV_FILE"; fi`,
        `if [ -z "$\{TINYAI_OBS_COLLECTOR_URL:-}" ]; then TINYAI_OBS_COLLECTOR_URL=${shellQuote(options.collectorUrl || tinyAiCollectorUrlForTool(options.tool, workspacePath))}; fi`,
        fallbackEnv ? `if [ -z "$\{TINYAI_OBS_COLLECTOR_URLS:-}" ]; then TINYAI_OBS_COLLECTOR_URLS=${shellQuote(fallbackEnv)}; fi` : "",
        options.token || process.env.TINYAI_OBS_TOKEN ? `if [ -z "$\{TINYAI_OBS_TOKEN:-}" ]; then TINYAI_OBS_TOKEN=${shellQuote(options.token || process.env.TINYAI_OBS_TOKEN || "")}; fi` : "",
        `export TINYAI_OBS_ENV_FILE TINYAI_OBS_COLLECTOR_URL TINYAI_OBS_COLLECTOR_URLS TINYAI_OBS_TOKEN`,
        `export TINYAI_OBS_WORKSPACE=${shellQuote(workspacePath)}`,
        `if [ -z "$\{TINYAI_OBS_GIT_HOOK_TOOL:-}" ]; then TINYAI_OBS_GIT_HOOK_TOOL=${shellQuote(hookTool)}; fi`,
        `export TINYAI_OBS_TOOL="$TINYAI_OBS_GIT_HOOK_TOOL"`,
        `export TINYAI_OBS_HOOK_INSTALLER_TOOL=${shellQuote(options.tool)}`,
        `export TINYAI_OBS_PLUGIN_VERSION=${shellQuote(options.pluginVersion || process.env.TINYAI_OBS_PLUGIN_VERSION || "0.1.0")}`
    ];
    const setupScript = setupLines.filter(Boolean).join("; ");
    const postCommit = managedHookBlock("record commit diff evidence for server-side AI attribution", `${setupScript}; TINYAI_OBS_EVENT_TYPE=commit_snapshot node ${shellQuote(hookScript)} >/dev/null 2>&1 || true`);
    const prePush = managedHookBlock("record AI-attributed branch diff before push", `${setupScript}; TINYAI_OBS_EVENT_TYPE=push_snapshot node ${shellQuote(hookScript)} >/dev/null 2>&1 || true`);
    const preCommitPath = join(hooksDir, "pre-commit");
    const postCommitPath = join(hooksDir, "post-commit");
    const prePushPath = join(hooksDir, "pre-push");
    await removeManagedHook(preCommitPath);
    await writeManagedHook(postCommitPath, postCommit);
    await writeManagedHook(prePushPath, prePush);
    await chmod(postCommitPath, 0o755);
    await chmod(prePushPath, 0o755);
    return { installed: [postCommitPath, prePushPath], git_dir: dirname(hooksDir) };
}
function shellQuote(value) {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
const TINYAI_HOOK_BEGIN = "# >>> TinyAI Observability >>>";
const TINYAI_HOOK_END = "# <<< TinyAI Observability <<<";
const TINYAI_HOOK_RE = new RegExp(`${escapeRegExp(TINYAI_HOOK_BEGIN)}[\\s\\S]*?${escapeRegExp(TINYAI_HOOK_END)}\\n?`, "m");
function managedHookBlock(description, command) {
    return `${TINYAI_HOOK_BEGIN}
# TinyAI Observability: ${description}.
${command}
${TINYAI_HOOK_END}
`;
}
async function writeManagedHook(hookPath, block) {
    let existing = "";
    try {
        existing = await readFile(hookPath, "utf8");
    }
    catch {
        existing = "";
    }
    let next;
    if (TINYAI_HOOK_RE.test(existing)) {
        next = existing.replace(TINYAI_HOOK_RE, block);
    }
    else if (isLegacyTinyAiHook(existing)) {
        next = `#!/bin/sh\n${block}`;
    }
    else if (existing.trim()) {
        next = existing.startsWith("#!") ? `${existing.trimEnd()}\n\n${block}` : `#!/bin/sh\n${existing.trimEnd()}\n\n${block}`;
    }
    else {
        next = `#!/bin/sh\n${block}`;
    }
    await writeFile(hookPath, next, { mode: 0o755 });
}
async function removeManagedHook(hookPath) {
    let existing = "";
    try {
        existing = await readFile(hookPath, "utf8");
    }
    catch {
        return;
    }
    if (!TINYAI_HOOK_RE.test(existing) && !isLegacyTinyAiHook(existing))
        return;
    const next = TINYAI_HOOK_RE.test(existing) ? existing.replace(TINYAI_HOOK_RE, "") : "";
    const normalized = next.trim();
    if (!normalized || normalized === "#!/bin/sh") {
        try {
            await unlink(hookPath);
        }
        catch {
            // best effort: hook removal should not block post-commit installation
        }
        return;
    }
    await writeFile(hookPath, next.endsWith("\n") ? next : `${next}\n`, { mode: 0o755 });
}
function isLegacyTinyAiHook(value) {
    return value.includes("TinyAI Observability:") && value.includes("TINYAI_OBS_EVENT_TYPE=");
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
