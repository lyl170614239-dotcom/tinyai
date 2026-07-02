#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(pluginRoot, ".claude-plugin", "plugin.json");
const marketplacePath = resolve(pluginRoot, ".claude-plugin", "marketplace.json");
const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args["dry-run"]);
const skipInstall = Boolean(args["skip-install"]);
const marketplaceName = String(args.marketplace || "tinyai");

assertFile(manifestPath, "Claude plugin manifest");
assertFile(marketplacePath, "Claude marketplace manifest");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const pluginName = String(manifest.name || "observability");
const pluginVersion = String(manifest.version || "").trim();
const pluginId = `${pluginName}@${marketplaceName}`;
const installPath = join(homedir(), ".claude", "plugins", "cache", marketplaceName, pluginName, pluginVersion);

run("claude", ["plugin", "validate", manifestPath], { dryRun });
run("claude", ["plugin", "validate", marketplacePath], { dryRun });

let cleanup = { cleanedOldCaches: [], updatedClaudeJsonProjectMcpConfigs: 0 };
if (!skipInstall) {
  run("claude", ["plugin", "marketplace", "add", pluginRoot], { dryRun, allowFailure: true });
  run("claude", ["plugin", "marketplace", "update", marketplaceName], { dryRun, allowFailure: true });
  run("claude", ["plugin", "install", pluginId], { dryRun });
  if (!dryRun) {
    cleanup = cleanupLocalClaudeConfig({ installPath, marketplaceName, pluginName });
  }
}

console.log(JSON.stringify({
  ok: true,
  dryRun,
  pluginRoot,
  marketplacePath,
  pluginId,
  installPath,
  ...cleanup,
  nextSteps: [
    "Restart Claude Code or reload the VS Code Claude Code window.",
    "Verify with: claude plugin validate " + manifestPath,
    "Verify marketplace with: claude plugin validate " + marketplacePath,
    "If an older MCP process is still running, quit Claude Code and start it again."
  ]
}, null, 2));

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

function assertFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing: ${path}`);
  }
}

function run(command, commandArgs, options = {}) {
  const printable = [command, ...commandArgs].join(" ");
  if (options.dryRun) {
    console.log(`[dry-run] ${printable}`);
    return;
  }
  const result = spawnSync(command, commandArgs, {
    cwd: pluginRoot,
    stdio: "inherit",
    env: process.env
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`Command failed (${result.status}): ${printable}`);
  }
}

function cleanupLocalClaudeConfig({ installPath, marketplaceName, pluginName }) {
  const claudeJsonPath = join(homedir(), ".claude.json");
  const updatedClaudeJsonProjectMcpConfigs = updateClaudeProjectMcpConfigs(claudeJsonPath, installPath);
  const cacheRoot = join(homedir(), ".claude", "plugins", "cache", marketplaceName, pluginName);
  const cleanedOldCaches = cleanupOldPluginCaches(cacheRoot, installPath);
  return { cleanedOldCaches, updatedClaudeJsonProjectMcpConfigs };
}

function updateClaudeProjectMcpConfigs(path, nextInstallPath) {
  if (!existsSync(path)) return 0;
  const root = JSON.parse(readFileSync(path, "utf8"));
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
      const hasCacheArg = args.some((value) =>
        typeof value === "string" && /\/\.claude\/plugins\/cache\/tinyai\/observability\/[^/]+\/runtime\/dist\/mcp-server\.js$/.test(value)
      );
      if (hasCacheArg || serverName === "tinyai-observability") {
        server.args = [nextMcpServer];
        changed = true;
      }
      if (!server.env || typeof server.env !== "object" || Array.isArray(server.env)) server.env = {};
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
  if (updatedCount > 0) {
    writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  }
  return updatedCount;
}

function isTinyAiObservabilityServer(serverName, server) {
  if (serverName === "tinyai-observability") return true;
  const args = Array.isArray(server.args) ? server.args : [];
  return args.some((value) => typeof value === "string" && value.includes("/.claude/plugins/cache/tinyai/observability/"));
}

function cleanupOldPluginCaches(cacheRoot, currentInstallPath) {
  if (!existsSync(cacheRoot)) return [];
  const currentName = basename(currentInstallPath);
  const removed = [];
  for (const entry of readdirSync(cacheRoot)) {
    const path = join(cacheRoot, entry);
    if (entry === currentName || path === currentInstallPath) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}
