#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
const pluginId = `${pluginName}@${marketplaceName}`;

run("claude", ["plugin", "validate", manifestPath], { dryRun });
run("claude", ["plugin", "validate", marketplacePath], { dryRun });

if (!skipInstall) {
  run("claude", ["plugin", "marketplace", "add", pluginRoot], { dryRun, allowFailure: true });
  run("claude", ["plugin", "marketplace", "update", marketplaceName], { dryRun, allowFailure: true });
  run("claude", ["plugin", "install", pluginId], { dryRun });
}

console.log(JSON.stringify({
  ok: true,
  dryRun,
  pluginRoot,
  marketplacePath,
  pluginId,
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
