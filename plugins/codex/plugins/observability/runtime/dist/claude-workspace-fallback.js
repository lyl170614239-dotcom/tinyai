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
export function hasClaudeExternalWriteSignal(snapshot) {
    for (const toolCall of snapshot.tool_calls || []) {
        const name = String(toolCall.tool_name || toolCall.name || "").toLowerCase();
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
