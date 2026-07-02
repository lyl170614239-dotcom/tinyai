import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cwd } from "node:process";

export type TinyAiToolName = "copilot" | "claude" | "codex" | string;

export const DEFAULT_TINYAI_ENV_FILE = join(homedir(), ".tinyai-observability", "tinyai-observability.env");
export const DEFAULT_COLLECTOR_URL = "http://10.161.248.133:18080";
export const DEFAULT_COLLECTOR_FALLBACK_URLS: string[] = [];
export const DEFAULT_DASHBOARD_URL = "http://10.161.248.133:18081";
export const DEFAULT_DASHBOARD_FALLBACK_URLS: string[] = [];
const LEGACY_DEFAULT_URLS = new Set([
  "http://192.168.215.94:18080",
  "http://192.168.215.94:18080/",
  "http://192.168.215.94:18081",
  "http://192.168.215.94:18081/",
  "http://10.161.248.127:18080",
  "http://10.161.248.127:18080/",
  "http://10.161.248.127:18081",
  "http://10.161.248.127:18081/"
]);

export type TinyAiEnv = Record<string, string>;

let cachedEnvFile: string | undefined;
let cachedEnvMtimeMs: number | undefined;
let cachedEnv: TinyAiEnv | undefined;
const loadedEnvValues = new Map<string, string>();

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function cleanConfiguredValue(value: string | undefined): string | undefined {
  const trimmed = String(value || "").trim();
  if (!trimmed || /^\$\{[A-Z0-9_]+\}$/.test(trimmed)) return undefined;
  if (LEGACY_DEFAULT_URLS.has(trimmed)) return undefined;
  return trimmed;
}

export function parseTinyAiEnv(content: string): TinyAiEnv {
  const env: TinyAiEnv = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^TINYAI_OBS_[A-Z0-9_]+$/.test(key)) continue;
    const value = stripQuotes(normalized.slice(equalsIndex + 1));
    env[key] = value;
  }
  return env;
}

export function resolveTinyAiEnvFile(workspacePath?: string): string {
  const explicit = cleanConfiguredValue(process.env.TINYAI_OBS_ENV_FILE);
  if (explicit) return resolve(explicit.replace(/^file:\/\//, ""));

  const localWorkspaceFile = workspacePath ? join(workspacePath, ".tinyai-observability.env") : "";
  if (localWorkspaceFile && existsSync(localWorkspaceFile)) return localWorkspaceFile;

  const localCwdFile = join(cwd(), ".tinyai-observability.env");
  if (existsSync(localCwdFile)) return localCwdFile;

  return DEFAULT_TINYAI_ENV_FILE;
}

export function readTinyAiEnvFile(workspacePath?: string): { path: string; values: TinyAiEnv; exists: boolean } {
  const path = resolveTinyAiEnvFile(workspacePath);
  if (!existsSync(path)) return { path, values: {}, exists: false };
  const mtimeMs = statSync(path).mtimeMs;
  if (cachedEnv && cachedEnvFile === path && cachedEnvMtimeMs === mtimeMs) return { path, values: cachedEnv, exists: true };
  const values = parseTinyAiEnv(readFileSync(path, "utf8"));
  cachedEnvFile = path;
  cachedEnvMtimeMs = mtimeMs;
  cachedEnv = values;
  return { path, values, exists: true };
}

export function loadTinyAiEnvFile(workspacePath?: string): { path: string; values: TinyAiEnv; exists: boolean } {
  const result = readTinyAiEnvFile(workspacePath);
  for (const [key, value] of Object.entries(result.values)) {
    const previousLoadedValue = loadedEnvValues.get(key);
    if (!cleanConfiguredValue(process.env[key]) || process.env[key] === previousLoadedValue) {
      process.env[key] = value;
      loadedEnvValues.set(key, value);
    }
  }
  return result;
}

export function tinyAiEnvValue(key: string, workspacePath?: string): string | undefined {
  return cleanConfiguredValue(process.env[key]) || cleanConfiguredValue(readTinyAiEnvFile(workspacePath).values[key]);
}

export function tinyAiBooleanEnvValue(key: string, defaultValue: boolean, workspacePath?: string): boolean {
  const value = tinyAiEnvValue(key, workspacePath);
  if (value === undefined) return defaultValue;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function tinyAiAutoInstallGitHooksEnabled(workspacePath?: string): boolean {
  return tinyAiBooleanEnvValue("TINYAI_OBS_AUTO_INSTALL_GIT_HOOKS", true, workspacePath);
}

function normalizeToolName(tool?: TinyAiToolName): string | undefined {
  const normalized = String(tool || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || undefined;
}

export function tinyAiToolEnvValue(tool: TinyAiToolName | undefined, suffix: string, workspacePath?: string): string | undefined {
  const normalizedTool = normalizeToolName(tool);
  const normalizedSuffix = suffix.replace(/^TINYAI_OBS_/, "").replace(/^_+/, "");
  if (normalizedTool) {
    const toolValue = tinyAiEnvValue(`TINYAI_OBS_${normalizedTool}_${normalizedSuffix}`, workspacePath);
    if (toolValue) return toolValue;
  }
  return tinyAiEnvValue(`TINYAI_OBS_${normalizedSuffix}`, workspacePath);
}

export function splitTinyAiUrls(value: string | undefined): string[] {
  return String(value || "")
    .split(/[,\s]+/)
    .map((url) => url.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function tinyAiCollectorUrl(workspacePath?: string): string {
  return tinyAiEnvValue("TINYAI_OBS_COLLECTOR_URL", workspacePath) || DEFAULT_COLLECTOR_URL;
}

export function tinyAiCollectorUrlForTool(tool?: TinyAiToolName, workspacePath?: string): string {
  return tinyAiToolEnvValue(tool, "COLLECTOR_URL", workspacePath) || DEFAULT_COLLECTOR_URL;
}

export function tinyAiCollectorFallbackUrls(workspacePath?: string): string[] {
  const configured = splitTinyAiUrls(tinyAiEnvValue("TINYAI_OBS_COLLECTOR_URLS", workspacePath));
  return configured.length > 0 ? configured : DEFAULT_COLLECTOR_FALLBACK_URLS;
}

export function tinyAiCollectorFallbackUrlsForTool(tool?: TinyAiToolName, workspacePath?: string): string[] {
  const configured = splitTinyAiUrls(tinyAiToolEnvValue(tool, "COLLECTOR_URLS", workspacePath));
  return configured.length > 0 ? configured : DEFAULT_COLLECTOR_FALLBACK_URLS;
}

export function tinyAiDashboardUrl(workspacePath?: string): string {
  return tinyAiEnvValue("TINYAI_OBS_DASHBOARD_URL", workspacePath) || DEFAULT_DASHBOARD_URL;
}

export function tinyAiDashboardUrlForTool(tool?: TinyAiToolName, workspacePath?: string): string {
  return tinyAiToolEnvValue(tool, "DASHBOARD_URL", workspacePath) || DEFAULT_DASHBOARD_URL;
}

export function tinyAiDashboardFallbackUrls(workspacePath?: string): string[] {
  const configured = splitTinyAiUrls(tinyAiEnvValue("TINYAI_OBS_DASHBOARD_URLS", workspacePath));
  return configured.length > 0 ? configured : DEFAULT_DASHBOARD_FALLBACK_URLS;
}

export function tinyAiDashboardFallbackUrlsForTool(tool?: TinyAiToolName, workspacePath?: string): string[] {
  const configured = splitTinyAiUrls(tinyAiToolEnvValue(tool, "DASHBOARD_URLS", workspacePath));
  return configured.length > 0 ? configured : DEFAULT_DASHBOARD_FALLBACK_URLS;
}

export function tinyAiQueuePathForTool(tool?: TinyAiToolName, workspacePath?: string): string {
  const configured = tinyAiToolEnvValue(tool, "QUEUE", workspacePath);
  if (configured) return resolve(configured.replace(/^file:\/\//, ""));
  const normalizedTool = String(tool || "unknown").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  return join(homedir(), ".tinyai-observability", `queue-${normalizedTool}.jsonl`);
}
