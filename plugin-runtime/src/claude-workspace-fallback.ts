type ClaudeLikeCodeChange = {
  file_path?: unknown;
};

type ClaudeLikeToolCall = {
  tool_name?: unknown;
  name?: unknown;
  arguments_raw?: unknown;
  result_raw?: unknown;
};

type ClaudeLikeSnapshot = {
  code_changes?: ClaudeLikeCodeChange[];
  tool_calls?: ClaudeLikeToolCall[];
};

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(textFromUnknown).filter(Boolean).join("\n");
  }
  return "";
}

function cleanPathCandidate(candidate: string): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 500) return undefined;
  if (/^(https?:|mailto:|data:)/i.test(trimmed)) return undefined;
  if (trimmed.includes("node_modules/") || trimmed.includes(".git/")) return undefined;
  return trimmed.replace(/^file:\/\//, "");
}

export function collectClaudePotentialFilePaths(value: unknown): string[] {
  const text = textFromUnknown(value);
  const output = new Set<string>();
  const patterns = [
    /(?:^|[\s"'`=:(])((?:\.{1,2}\/|\/|~\/)?[\w.@%+=:,~/-]+\.[A-Za-z0-9_+-]{1,16})(?=$|[\s"'`),;])/g,
    /(?:^|[\s"'`=:(])((?:\.{1,2}\/|\/|~\/)?[\w.@%+=:,~/-]+\/[\w.@%+=:,~/-]+)(?=$|[\s"'`),;])/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const cleaned = cleanPathCandidate(match[1] || "");
      if (cleaned) output.add(cleaned);
    }
  }
  return [...output].slice(0, 50);
}

function terminalWriteSignal(text: string): boolean {
  return /(write_text|writefilesync|writefile|appendfile|open\s*\([^)]*['"]w|(?<![0-9])>>|(?<![0-9])>\s*[^&]|\btee\s+|\bsed\s+-i\b|\bperl\s+-pi\b|\btouch\s+|\bcp\s+|\bmv\s+|\brm\s+)/.test(text);
}

function isTerminalTool(toolName: string): boolean {
  return /(bash|shell|terminal|run_command|run_in_terminal)/.test(toolName);
}

function isDirectEditTool(toolName: string): boolean {
  return /(replace_string_in_file|create_file|edit_file|write_file|insert_edit)/.test(toolName);
}

function collectClaudeToolPathArguments(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const output = new Set<string>();
  for (const key of ["file_path", "filePath", "path", "relative_path", "absolute_path", "target_path"]) {
    const candidate = record[key];
    if (typeof candidate !== "string") continue;
    const cleaned = cleanPathCandidate(candidate);
    if (cleaned) output.add(cleaned);
  }
  return [...output].slice(0, 20);
}

function hasClaudeToolPatchPath(snapshot: ClaudeLikeSnapshot): boolean {
  return (snapshot.code_changes || []).some((change) => {
    const filePath = typeof change.file_path === "string" ? cleanPathCandidate(change.file_path) : undefined;
    return Boolean(filePath);
  });
}

export function hasClaudeExternalWriteSignal(snapshot: ClaudeLikeSnapshot): boolean {
  if (hasClaudeToolPatchPath(snapshot)) return true;
  for (const toolCall of snapshot.tool_calls || []) {
    const name = String(toolCall.tool_name || toolCall.name || "").toLowerCase();
    if (isDirectEditTool(name)) return true;
    if (!isTerminalTool(name)) continue;
    const command = textFromUnknown(toolCall.arguments_raw).toLowerCase();
    if (terminalWriteSignal(command)) return true;
  }
  return false;
}

export function claudeWorkspaceDiffPathCandidates(snapshot: ClaudeLikeSnapshot): string[] {
  const paths = new Set<string>();
  for (const change of snapshot.code_changes || []) {
    const filePath = typeof change.file_path === "string" ? cleanPathCandidate(change.file_path) : undefined;
    if (filePath) paths.add(filePath);
  }
  for (const toolCall of snapshot.tool_calls || []) {
    const name = String(toolCall.tool_name || toolCall.name || "").toLowerCase();
    if (isDirectEditTool(name)) {
      for (const path of collectClaudeToolPathArguments(toolCall.arguments_raw)) paths.add(path);
      continue;
    }
    if (!isTerminalTool(name)) continue;
    const command = textFromUnknown(toolCall.arguments_raw).toLowerCase();
    if (!terminalWriteSignal(command)) continue;
    for (const path of collectClaudePotentialFilePaths(toolCall.arguments_raw)) paths.add(path);
  }
  return [...paths].slice(0, 50);
}
