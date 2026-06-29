#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args["dry-run"]);
const scope = String(args.scope || "user");
const vscodeFlavor = String(args.flavor || "stable");
const defaultCollectorUrl = "http://10.161.248.133:18080";
const collectorUrl = String(
  args["collector-url"] ||
    process.env.TINYAI_OBS_COLLECTOR_URL ||
    process.env.OBS_COLLECTOR_URL ||
    process.env.TINYAI_COLLECTOR_URL ||
    defaultCollectorUrl
).replace(/\/$/, "");
const token = String(
  args.token ||
    process.env.TINYAI_OBS_TOKEN ||
    process.env.OBS_TOKEN ||
    process.env.TINYAI_OBS_COLLECTOR_TOKEN ||
    ""
);
const detectedGitName = gitConfig("user.name");
const detectedGitEmail = gitConfig("user.email");
const userName = String(
  args["user-name"] ||
    args.user ||
    process.env.TINYAI_OBS_USER_NAME ||
    process.env.TINYAI_OBS_USER_DISPLAY_NAME ||
    detectedGitName ||
    ""
).trim();
const userEmail = String(args["user-email"] || process.env.TINYAI_OBS_USER_EMAIL || detectedGitEmail || "").trim();
const userId = String(args["user-id"] || process.env.TINYAI_OBS_USER_ID || userEmail || slugIdentity(userName) || "").trim();
const team = String(args.team || process.env.TINYAI_OBS_TEAM || "").trim();

const settingsPath = resolveSettingsPath(scope, vscodeFlavor, args.workspace);
const settings = readJsonc(settingsPath);
const tinyaiSettings = {
  "tinyaiObservability.collectorUrl": collectorUrl,
  "tinyaiObservability.token": token,
  "tinyaiObservability.userName": userName,
  "tinyaiObservability.userId": userId,
  "tinyaiObservability.userEmail": userEmail,
  "tinyaiObservability.team": team,
  "tinyaiObservability.captureConversationText": boolArg("capture-conversation-text", true),
  "tinyaiObservability.captureVisibleReasoningText": boolArg("capture-visible-reasoning-text", false),
  "tinyaiObservability.autoCaptureCopilotLocalTranscripts": boolArg("auto-capture-copilot", true),
  "tinyaiObservability.autoCaptureRecentMinutes": numberArg("auto-capture-recent-minutes", 30)
};

const nextSettings = { ...settings, ...tinyaiSettings };
const report = {
  settingsPath,
  scope,
  vscodeFlavor,
  collectorUrl,
  tokenSource: token ? "argument-or-env" : "not-required",
  identity: {
    userName,
    userId,
    userEmail,
    team,
    source: userName === detectedGitName ? "git-config-or-env" : "argument-or-env"
  },
  dryRun,
  wroteSettings: false,
  collectorReachable: false,
  heartbeatAccepted: false,
  notes: []
};

if (!dryRun) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`);
  report.wroteSettings = true;
}

try {
  const pluginRes = await fetch(`${collectorUrl}/api/v1/plugins`);
  report.collectorReachable = pluginRes.ok;
  if (!pluginRes.ok) report.notes.push(`GET /api/v1/plugins returned ${pluginRes.status}`);
} catch (error) {
  report.notes.push(`collector GET failed: ${String(error?.message || error)}`);
}

if (!dryRun) {
  try {
  const heartbeat = makeHeartbeat();
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const postRes = await fetch(`${collectorUrl}/api/v1/events/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify(heartbeat)
  });
  report.heartbeatAccepted = postRes.ok;
  if (!postRes.ok) report.notes.push(`POST /api/v1/events/batch returned ${postRes.status}: ${await postRes.text()}`);
  } catch (error) {
    report.notes.push(`collector POST failed: ${String(error?.message || error)}`);
  }
} else {
  report.heartbeatAccepted = report.collectorReachable;
}

if (!token) report.notes.push("No token configured. This is allowed only for localhost collectors; remote collectors require HTTPS plus a bearer token.");
if (!userName) {
  report.notes.push("No user name configured. Pass --user-name \"你的名字\" so sessions can be grouped by teammate.");
}

console.log(JSON.stringify(report, null, 2));
if (!report.heartbeatAccepted) process.exitCode = 2;

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

function boolArg(name, fallback) {
  const value = args[name];
  if (value === undefined) return fallback;
  if (value === true) return true;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function numberArg(name, fallback) {
  const value = Number(args[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function gitConfig(key) {
  try {
    return execFileSync("git", ["config", "--get", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function slugIdentity(value) {
  return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._@-]/g, "");
}

function resolveSettingsPath(settingsScope, flavor, workspaceArg) {
  if (settingsScope === "workspace") {
    const workspace = resolve(String(workspaceArg || process.cwd()));
    return join(workspace, ".vscode", "settings.json");
  }

  const home = homedir();
  const app = flavor === "insiders" ? "Code - Insiders" : "Code";
  if (platform() === "darwin") return join(home, "Library", "Application Support", app, "User", "settings.json");
  if (platform() === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, app, "User", "settings.json");
  }
  return join(home, ".config", app, "User", "settings.json");
}

function readJsonc(file) {
  if (!existsSync(file)) return {};
  const content = readFileSync(file, "utf8").trim();
  if (!content) return {};
  try {
    return JSON.parse(stripJsonc(content));
  } catch (error) {
    throw new Error(`Cannot parse VS Code settings at ${file}: ${String(error?.message || error)}`);
  }
}

function stripJsonc(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1");
}

function makeHeartbeat() {
  const now = new Date().toISOString();
  const username = userName || process.env.USER || process.env.USERNAME || "unknown";
  const hostHash = createHash("sha256").update(hostname()).digest("hex").slice(0, 32);
  const seed = `${userId || userEmail || username}:${hostHash}:vscode-configure`;
  const clientId = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  const eventId = createHash("sha256").update(`${seed}:${now}`).digest("hex").slice(0, 32);
  const taskId = `vscode-config-${eventId}`.slice(0, 64);
  return {
    client_id: clientId,
    plugin_name: "tinyai-observability-vscode-configure",
    plugin_version: "0.1.0",
    username,
    user_id: userId || undefined,
    user_email: userEmail || undefined,
    user_display_name: userName || undefined,
    team: team || undefined,
    host_hash: hostHash,
    events: [
      {
        event_id: eventId,
        task_id: taskId,
        tool: "copilot",
        event_type: "plugin_heartbeat",
        occurred_at: now,
        source_confidence: "direct",
        username,
        user_id: userId || undefined,
        user_email: userEmail || undefined,
        user_display_name: userName || undefined,
        team: team || undefined,
        host_hash: hostHash,
        payload: {
          activation: "vscode_configure_skill",
          settings_scope: scope,
          settings_path_hash: createHash("sha256").update(settingsPath).digest("hex").slice(0, 32)
        }
      }
    ]
  };
}
