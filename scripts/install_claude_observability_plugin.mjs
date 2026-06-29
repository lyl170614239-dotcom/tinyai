#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

const report = {
  pluginId,
  pluginVersion,
  pluginRoot,
  installPath,
  installedPluginsPath,
  settingsPath,
  enabled: !disable,
  dryRun,
  copiedPlugin: false,
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
