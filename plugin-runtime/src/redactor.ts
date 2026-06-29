const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{20,}/g,
  /(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[^'"\s]+/gi
];

const BLOCKED_KEYS = new Set(["prompt", "message", "content", "answer", "code", "env", "dotenv"]);

export interface RedactOptions {
  allowFullConversationText?: boolean;
}

export function redactText(value: string, options: RedactOptions = {}): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  if (options.allowFullConversationText) return redacted;
  return redacted.length > 2048 ? `${redacted.slice(0, 2048)}...[truncated]` : redacted;
}

export function redact(value: unknown, options: RedactOptions = {}): unknown {
  if (typeof value === "string") return redactText(value, options);
  if (Array.isArray(value)) {
    const items = options.allowFullConversationText ? value : value.slice(0, 50);
    return items.map((item) => redact(item, options));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value);
    const selectedEntries = options.allowFullConversationText ? entries : entries.slice(0, 80);
    for (const [key, item] of selectedEntries) {
      output[key] = BLOCKED_KEYS.has(key.toLowerCase()) && !options.allowFullConversationText ? "[REDACTED]" : redact(item, options);
    }
    return output;
  }
  return value;
}
