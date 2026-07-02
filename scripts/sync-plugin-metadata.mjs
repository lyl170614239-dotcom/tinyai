#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const claudeManifestPath = join(repoRoot, "plugins", "claude-code", ".claude-plugin", "plugin.json");
const claudePackagePath = join(repoRoot, "plugins", "claude-code", "package.json");
const claudeMarketplacePath = join(repoRoot, "plugins", "claude-code", ".claude-plugin", "marketplace.json");

const codexManifestPath = join(repoRoot, "plugins", "codex", "plugins", "observability", ".codex-plugin", "plugin.json");

const claudeManifest = readJson(claudeManifestPath);
const codexManifest = readJson(codexManifestPath);
const claudeVersion = requiredVersion(claudeManifestPath, claudeManifest);
const codexVersion = requiredVersion(codexManifestPath, codexManifest);

const claudePackage = readJson(claudePackagePath);
claudePackage.version = claudeVersion;
writeJson(claudePackagePath, claudePackage);

const claudeMarketplace = readJson(claudeMarketplacePath);
if (!claudeMarketplace.metadata || typeof claudeMarketplace.metadata !== "object" || Array.isArray(claudeMarketplace.metadata)) {
  claudeMarketplace.metadata = {};
}
claudeMarketplace.metadata.version = claudeVersion;
for (const plugin of Array.isArray(claudeMarketplace.plugins) ? claudeMarketplace.plugins : []) {
  if (plugin && typeof plugin === "object" && plugin.name === claudeManifest.name) {
    plugin.version = claudeVersion;
  }
}
writeJson(claudeMarketplacePath, claudeMarketplace);

assertNoHardcodedTemplateVersion(join(repoRoot, "plugins", "claude-code", ".mcp.json"));
assertNoHardcodedTemplateVersion(join(repoRoot, "plugins", "claude-code", "hooks", "hooks.json"));
assertNoHardcodedTemplateVersion(join(repoRoot, "plugins", "codex", "plugins", "observability", ".mcp.json"));

console.log(JSON.stringify({
  ok: true,
  claude: {
    source: claudeManifestPath,
    version: claudeVersion,
    synced: [claudePackagePath, claudeMarketplacePath]
  },
  codex: {
    source: codexManifestPath,
    version: codexVersion
  }
}, null, 2));

function readJson(path) {
  if (!existsSync(path)) throw new Error(`Missing JSON file: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8") || "{}");
  } catch (error) {
    throw new Error(`Cannot parse JSON at ${path}: ${String(error?.message || error)}`);
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requiredVersion(path, value) {
  const version = typeof value?.version === "string" ? value.version.trim() : "";
  if (!version) throw new Error(`Missing version in manifest: ${path}`);
  return version;
}

function assertNoHardcodedTemplateVersion(path) {
  const content = readFileSync(path, "utf8");
  if (/TINYAI_OBS_PLUGIN_VERSION\s*[:=]/.test(content)) {
    throw new Error(`Remove hard-coded TINYAI_OBS_PLUGIN_VERSION from ${path}; runtime reads plugin.json.`);
  }
}
