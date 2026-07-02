function textFromUnknown(value) {
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    if (Array.isArray(value))
        return value.map(textFromUnknown).filter(Boolean).join("\n");
    if (value && typeof value === "object") {
        return Object.values(value).map(textFromUnknown).filter(Boolean).join("\n");
    }
    return "";
}
function cleanPathCandidate(candidate) {
    const trimmed = candidate.trim();
    if (!trimmed)
        return undefined;
    if (trimmed.length > 500)
        return undefined;
    if (/^(https?:|mailto:|data:)/i.test(trimmed))
        return undefined;
    if (trimmed.includes("node_modules/") || trimmed.includes(".git/"))
        return undefined;
    return trimmed.replace(/^file:\/\//, "");
}
export function collectClaudePotentialFilePaths(value) {
    const text = textFromUnknown(value);
    const output = new Set();
    const patterns = [
        /(?:^|[\s"'`=:(])((?:\.{1,2}\/|\/|~\/)?[\w.@%+=:,~/-]+\.[A-Za-z0-9_+-]{1,16})(?=$|[\s"'`),;])/g,
        /(?:^|[\s"'`=:(])((?:\.{1,2}\/|\/|~\/)?[\w.@%+=:,~/-]+\/[\w.@%+=:,~/-]+)(?=$|[\s"'`),;])/g
    ];
    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            const cleaned = cleanPathCandidate(match[1] || "");
            if (cleaned)
                output.add(cleaned);
        }
    }
    return [...output].slice(0, 50);
}
function terminalWriteSignal(text) {
    return /(write_text|writefilesync|writefile|appendfile|open\s*\([^)]*['"]w|(?<![0-9])>>|(?<![0-9])>\s*[^&]|\btee\s+|\bsed\s+-i\b|\bperl\s+-pi\b|\btouch\s+|\bcp\s+|\bmv\s+|\brm\s+)/.test(text);
}
function isTerminalTool(toolName) {
    return /(bash|shell|terminal|run_command|run_in_terminal)/.test(toolName);
}
function isDirectEditTool(toolName) {
    return /(replace_string_in_file|create_file|edit_file|write_file|insert_edit)/.test(toolName);
}
function collectClaudeToolPathArguments(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return [];
    const record = value;
    const output = new Set();
    for (const key of ["file_path", "filePath", "path", "relative_path", "absolute_path", "target_path"]) {
        const candidate = record[key];
        if (typeof candidate !== "string")
            continue;
        const cleaned = cleanPathCandidate(candidate);
        if (cleaned)
            output.add(cleaned);
    }
    return [...output].slice(0, 20);
}
function hasClaudeToolPatchPath(snapshot) {
    return (snapshot.code_changes || []).some((change) => {
        const filePath = typeof change.file_path === "string" ? cleanPathCandidate(change.file_path) : undefined;
        return Boolean(filePath);
    });
}
export function hasClaudeExternalWriteSignal(snapshot) {
    if (hasClaudeToolPatchPath(snapshot))
        return true;
    for (const toolCall of snapshot.tool_calls || []) {
        const name = String(toolCall.tool_name || toolCall.name || "").toLowerCase();
        if (isDirectEditTool(name))
            return true;
        if (!isTerminalTool(name))
            continue;
        const command = textFromUnknown(toolCall.arguments_raw).toLowerCase();
        if (terminalWriteSignal(command))
            return true;
    }
    return false;
}
export function claudeWorkspaceDiffPathCandidates(snapshot) {
    const paths = new Set();
    for (const change of snapshot.code_changes || []) {
        const filePath = typeof change.file_path === "string" ? cleanPathCandidate(change.file_path) : undefined;
        if (filePath)
            paths.add(filePath);
    }
    for (const toolCall of snapshot.tool_calls || []) {
        const name = String(toolCall.tool_name || toolCall.name || "").toLowerCase();
        if (isDirectEditTool(name)) {
            for (const path of collectClaudeToolPathArguments(toolCall.arguments_raw))
                paths.add(path);
            continue;
        }
        if (!isTerminalTool(name))
            continue;
        const command = textFromUnknown(toolCall.arguments_raw).toLowerCase();
        if (!terminalWriteSignal(command))
            continue;
        for (const path of collectClaudePotentialFilePaths(toolCall.arguments_raw))
            paths.add(path);
    }
    return [...paths].slice(0, 50);
}
