#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args["dry-run"]);
const disable = Boolean(args.disable);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(String(args["plugin-root"] || join(repoRoot, "plugins", "claude-code")));
const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
const manifest = readJson(manifestPath, "Claude plugin manifest");
const pluginName = String(manifest.name || "").trim();
const pluginVersion = String(manifest.version || "").trim();
const marketplace = String(args.marketplace || "tinyai").trim();
const pluginId = `${pluginName}@${marketplace}`;

if (!pluginName || !pluginVersion) {
  throw new Error(`Invalid Claude plugin manifest at ${manifestPath}: missing name/version`);
}

const claudeHome = resolve(String(args["claude-home"] || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")));
const installPath = resolve(
  String(args["install-path"] || join(claudeHome, "plugins", "cache", marketplace, pluginName, pluginVersion))
);
const installedPluginsPath = join(claudeHome, "plugins", "installed_plugins.json");
const settingsPath = join(claudeHome, "settings.json");
const claudeJsonPath = resolve(String(args["claude-json"] || join(homedir(), ".claude.json")));
const keepOldCache = Boolean(args["keep-old-cache"]);

const report = {
  pluginId,
  pluginVersion,
  pluginRoot,
  installPath,
  installedPluginsPath,
  settingsPath,
  claudeJsonPath,
  enabled: !disable,
  dryRun,
  copiedPlugin: false,
  cleanedOldCaches: [],
  updatedClaudeJsonProjectMcpConfigs: 0,
  updatedInstalledPlugins: false,
  updatedSettings: false,
  notes: []
};

validateSource(pluginRoot);

if (!dryRun) {
  rmSync(installPath, { recursive: true, force: true });
  mkdirSync(dirname(installPath), { recursive: true });
  cpSync(pluginRoot, installPath, {
    recursive: true,
    filter: (source) => shouldCopy(source)
  });
  report.copiedPlugin = true;
  validateSource(installPath);

  const installedPlugins = readJson(installedPluginsPath, "Claude installed plugins registry", {
    version: 2,
    plugins: {}
  });
  if (!installedPlugins.plugins || typeof installedPlugins.plugins !== "object" || Array.isArray(installedPlugins.plugins)) {
    installedPlugins.plugins = {};
  }

  const now = new Date().toISOString();
  const existingList = Array.isArray(installedPlugins.plugins[pluginId]) ? installedPlugins.plugins[pluginId] : [];
  const existing = existingList.find((entry) => entry?.scope === "user") || existingList[0] || {};
  const nextEntry = {
    ...existing,
    scope: "user",
    installPath,
    version: pluginVersion,
    installedAt: existing.installedAt || now,
    lastUpdated: now
  };
  installedPlugins.plugins[pluginId] = [nextEntry];
  writeJson(installedPluginsPath, installedPlugins);
  report.updatedInstalledPlugins = true;

  const settings = readJson(settingsPath, "Claude settings", {});
  if (!settings.enabledPlugins || typeof settings.enabledPlugins !== "object" || Array.isArray(settings.enabledPlugins)) {
    settings.enabledPlugins = {};
  }
  settings.enabledPlugins[pluginId] = !disable;
  writeJson(settingsPath, settings);
  report.updatedSettings = true;

  const claudeJsonUpdate = updateClaudeProjectMcpConfigs(claudeJsonPath, installPath);
  report.updatedClaudeJsonProjectMcpConfigs = claudeJsonUpdate.updatedCount;

  if (!keepOldCache) {
    report.cleanedOldCaches = cleanupOldPluginCaches(dirname(installPath), installPath);
  }
} else {
  report.notes.push("Dry run only; no files were changed.");
}

if (!existsSync(join(pluginRoot, "runtime", "dist", "hook.js"))) {
  report.notes.push("runtime/dist/hook.js is missing in source; run `npm run build:plugins` first.");
}
if (!existsSync(join(pluginRoot, "hooks", "hooks.json"))) {
  report.notes.push("hooks/hooks.json is missing in source.");
}
if (!disable) {
  report.notes.push("Restart Claude Code or reload VS Code after installation so Claude loads the updated plugin.");
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

function readJson(path, label, fallback) {
  if (!existsSync(path)) {
    if (fallback !== undefined) return structuredClone(fallback);
    throw new Error(`${label} not found: ${path}`);
  }
  const content = readFileSync(path, "utf8").trim();
  if (!content) return fallback !== undefined ? structuredClone(fallback) : {};
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Cannot parse ${label} at ${path}: ${String(error?.message || error)}`);
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function updateClaudeProjectMcpConfigs(path, nextInstallPath) {
  if (!existsSync(path)) return { updatedCount: 0 };
  const root = readJson(path, "Claude global config", {});
  const projects = root.projects && typeof root.projects === "object" && !Array.isArray(root.projects) ? root.projects : {};
  const nextMcpServer = join(nextInstallPath, "runtime", "dist", "mcp-server.js");
  let updatedCount = 0;
  for (const project of Object.values(projects)) {
    if (!project || typeof project !== "object" || Array.isArray(project)) continue;
    const servers = project.mcpServers && typeof project.mcpServers === "object" && !Array.isArray(project.mcpServers)
      ? project.mcpServers
      : {};
    for (const [serverName, server] of Object.entries(servers)) {
      if (!server || typeof server !== "object" || Array.isArray(server)) continue;
      if (!isTinyAiObservabilityServer(serverName, server)) continue;
      let changed = false;
      const args = Array.isArray(server.args) ? server.args : [];
      const hasOldCacheArg = args.some((value) =>
        typeof value === "string" && /\/\.claude\/plugins\/cache\/tinyai\/observability\/[^/]+\/runtime\/dist\/mcp-server\.js$/.test(value)
      );
      if (hasOldCacheArg || serverName === "tinyai-observability") {
        server.args = [nextMcpServer];
        changed = true;
      }
      if (!server.env || typeof server.env !== "object" || Array.isArray(server.env)) {
        server.env = {};
      }
      for (const legacyEnvKey of [
        "TINYAI_OBS_PLUGIN_VERSION",
        "TINYAI_OBS_USER_EMAIL",
        "TINYAI_OBS_CLAUDE_USER_EMAIL"
      ]) {
        if (Object.prototype.hasOwnProperty.call(server.env, legacyEnvKey)) {
          delete server.env[legacyEnvKey];
          changed = true;
        }
      }
      if (changed) updatedCount += 1;
    }
  }
  if (updatedCount > 0) writeJson(path, root);
  return { updatedCount };
}

function isTinyAiObservabilityServer(serverName, server) {
  if (serverName === "tinyai-observability") return true;
  const args = Array.isArray(server.args) ? server.args : [];
  return args.some((value) =>
    typeof value === "string" && value.includes("/.claude/plugins/cache/tinyai/observability/")
  );
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
      report.notes.push(`Could not remove old Claude plugin cache: ${path}`);
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

function validateSource(root) {
  const required = [
    ".claude-plugin/plugin.json",
    "hooks/hooks.json",
    "runtime/dist/hook.js",
    "runtime/package.json",
    "skills/observability/SKILL.md"
  ];
  for (const relative of required) {
    const path = join(root, relative);
    if (!existsSync(path)) {
      throw new Error(`Claude plugin is incomplete; missing ${path}`);
    }
  }
}

function shouldCopy(source) {
  const normalized = source.split("/").join("/");
  if (normalized.includes("/node_modules/")) return false;
  if (normalized.includes("/.git/")) return false;
  if (normalized.endsWith(".tgz")) return false;
  if (normalized.endsWith(".DS_Store")) return false;
  return true;
}
