#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args["dry-run"]);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(String(args["plugin-root"] || join(repoRoot, "plugins", "codex", "plugins", "observability")));
const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
const manifest = readJson(manifestPath, "Codex plugin manifest");
const pluginName = String(manifest.name || "").trim();
const pluginVersion = String(manifest.version || "").trim();
const marketplace = String(args.marketplace || "tinyai").trim();

if (!pluginName || !pluginVersion) {
  throw new Error(`Invalid Codex plugin manifest at ${manifestPath}: missing name/version`);
}

const codexHome = resolve(String(args["codex-home"] || process.env.CODEX_HOME || join(homedir(), ".codex")));
const installPath = resolve(
  String(args["install-path"] || join(codexHome, "plugins", "cache", marketplace, pluginName, pluginVersion))
);
const codexConfigPath = resolve(String(args["codex-config"] || join(codexHome, "config.toml")));
const keepOldCache = Boolean(args["keep-old-cache"]);

const report = {
  pluginId: `${marketplace}/${pluginName}`,
  pluginVersion,
  pluginRoot,
  installPath,
  codexConfigPath,
  dryRun,
  copiedPlugin: false,
  cleanedOldCaches: [],
  updatedCodexConfig: false,
  notes: [
    "Restart Codex or open a new Codex thread after installation so Codex loads the updated plugin.",
    "The installer writes an explicit Codex MCP server entry so telemetry capture does not depend on plugin lazy-loading.",
    "Plugin version is resolved from the installed .codex-plugin/plugin.json manifest."
  ]
};

validateSource(pluginRoot);

if (!dryRun) {
  rmSync(installPath, { recursive: true, force: true });
  mkdirSync(dirname(installPath), { recursive: true });
  cpSync(pluginRoot, installPath, {
    recursive: true,
    filter: (source) => shouldCopy(source)
  });
  validateSource(installPath);
  report.copiedPlugin = true;
  writeCodexMcpConfig(codexConfigPath, installPath);
  report.updatedCodexConfig = true;
  if (!keepOldCache) {
    report.cleanedOldCaches = cleanupOldPluginCaches(dirname(installPath), installPath);
  }
}

console.log(JSON.stringify(report, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const [key, inlineValue] = raw.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  const content = readFileSync(path, "utf8").trim();
  try {
    return JSON.parse(content || "{}");
  } catch (error) {
    throw new Error(`Cannot parse ${label} at ${path}: ${String(error?.message || error)}`);
  }
}

function validateSource(root) {
  const required = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "runtime/dist/mcp-server.js",
    "runtime/package.json",
    "skills/observability/SKILL.md"
  ];
  for (const relative of required) {
    const path = join(root, relative);
    if (!existsSync(path)) throw new Error(`Codex plugin is incomplete; missing ${path}`);
  }
}

function shouldCopy(source) {
  const normalized = source.split("/").join("/");
  if (normalized.includes("/node_modules/")) return false;
  if (normalized.includes("/.git/")) return false;
  if (normalized.endsWith(".DS_Store")) return false;
  return true;
}

function cleanupOldPluginCaches(cacheRoot, currentInstallPath) {
  if (!existsSync(cacheRoot)) return [];
  const currentName = basename(currentInstallPath);
  const removed = [];
  for (const entry of readdirSafe(cacheRoot)) {
    const path = join(cacheRoot, entry);
    if (entry === currentName || path === currentInstallPath) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      report.notes.push(`Could not remove old Codex plugin cache: ${path}`);
    }
  }
  return removed;
}

function readdirSafe(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function writeCodexMcpConfig(configPath, installedPluginPath) {
  mkdirSync(dirname(configPath), { recursive: true });
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const begin = "# BEGIN TinyAI Codex Observability MCP";
  const end = "# END TinyAI Codex Observability MCP";
  const block = [
    begin,
    "[mcp_servers.tinyai_observability]",
    'type = "stdio"',
    `command = ${tomlString(process.execPath)}`,
    `args = [${tomlString(join(installedPluginPath, "runtime", "dist", "mcp-server.js"))}]`,
    "startup_timeout_sec = 60",
    "",
    "[mcp_servers.tinyai_observability.env]",
    'TINYAI_OBS_TOOL = "codex"',
    `TINYAI_OBS_ENV_FILE = ${tomlString(process.env.TINYAI_OBS_ENV_FILE || join(homedir(), ".tinyai-observability", "tinyai-observability.env"))}`,
    'TINYAI_OBS_CAPTURE_CONVERSATION_TEXT = "true"',
    'TINYAI_OBS_AUTO_CAPTURE_CONVERSATION = "true"',
    end
  ].join("\n");
  const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "m");
  const next = pattern.test(existing)
    ? existing.replace(pattern, `${block}\n`)
    : `${existing.trimEnd()}\n\n${block}\n`;
  writeFileSync(configPath, next, "utf8");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
