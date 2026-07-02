import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

// ── Types ──────────────────────────────────────────────────────────────────

type Metric = {
  id: number;
  name: string;
  value: number | null;
  unit: string;
  numerator: number | null;
  denominator: number | null;
  confidence: string;
  method: string;
};

type MetricCategory = {
  key: string;
  title: string;
  metrics: Metric[];
  details?: Record<string, unknown>;
};

type MetricsResponse = {
  summary: {
    task_count: number;
    session_count?: number;
    turn_count?: number;
    message_count?: number;
    turn_snapshot_count?: number;
    event_count: number;
    spec_access_event_count: number;
    project_spec_access_count?: number;
    project_spec_read_count?: number;
    project_spec_edit_count?: number;
    project_spec_doc_hit_count?: number;
    project_spec_unique_doc_count?: number;
    project_spec_conversion_rate?: number | null;
    project_spec_low_conversion_doc_count?: number;
    project_spec_low_related_adoption_doc_count?: number;
    project_spec_related_adoption_doc_count?: number;
    code_snapshot_count: number;
    commit_snapshot_count?: number;
    ai_committed_lines?: number;
    ai_generated_added_lines?: number;
    ai_commit_current_added_lines?: number;
    pr_attribution_count?: number;
    pr_ai_lines?: number;
    pr_total_lines?: number;
    conversation_snapshot_count: number;
    username_filter: string | null;
    model_usage: Record<string, number>;
    request_usage_count?: number;
    prompt_tokens_total?: number;
    output_tokens_total: number;
    completion_tokens_total?: number;
    elapsed_ms_total?: number;
    copilot_credits_total?: number;
    agent_process_snapshot_count?: number;
    agent_activity_event_count?: number;
    file_read_event_count?: number;
  };
  categories: MetricCategory[];
};

type AiSessionSummary = {
  session_id: string;
  external_session_id: string | null;
  task_id: string | null;
  tool: string;
  status: string;
  title: string | null;
  model: string | null;
  username: string | null;
  user_id: string | null;
  user_display_name: string | null;
  team: string | null;
  started_at: string | null;
  last_activity_at: string | null;
};

type AiMessage = {
  id: number;
  message_index: number;
  turn_index: number;
  role: string;
  content: string | null;
  content_storage?: string | null;
  text_len: number;
  text_hash: string | null;
  blob_ref?: string | null;
  blob_encoding?: string | null;
  blob_original_bytes?: number | null;
  blob_compressed_bytes?: number | null;
  blob_sha256?: string | null;
  raw_event_id?: string | null;
  raw_path?: string | null;
  source_key?: string | null;
  occurred_at: string;
};

type RawEventBlobResponse = {
  raw_event_id: string;
  blob_key: string;
  encoding: string;
  value_type?: string | null;
  sha256: string;
  original_bytes: number;
  compressed_bytes: number;
  content: string;
};

type CodeChangeRawDetailResponse = {
  code_change_id: number;
  event_id?: string | null;
  source: string;
  blob_count: number;
  code_change: Record<string, unknown>;
};

type AiProcessStep = {
  id: number;
  step_id?: string | null;
  step_index: number;
  turn_index: number | null;
  request_id?: string | null;
  response_id?: string | null;
  tool_call_id?: string | null;
  actor_path?: string | null;
  actor_type?: string | null;
  parent_tool_call_id?: string | null;
  step_type: string;
  title: string | null;
  content: string | null;
  tool_name: string | null;
  status: string | null;
  raw_event_id?: string | null;
  raw_path?: string | null;
  occurred_at: string;
};

type AiCodeChange = {
  id: number;
  session_id?: string | null;
  task_id?: string | null;
  event_id?: string | null;
  turn_index: number | null;
  request_id?: string | null;
  response_id?: string | null;
  file_path: string | null;
  change_type: string;
  snapshot_kind?: string | null;
  diff_hash?: string | null;
  lines_added: number;
  lines_deleted: number;
  is_effective?: boolean;
  superseded_by_event_id?: string | null;
  occurred_at: string;
  diff_json?: Record<string, unknown> | null;
  submitter_username?: string | null;
  submitter_user_id?: string | null;
  submitter_display_name?: string | null;
  submitter_team?: string | null;
};

type CodeChangesResponse = {
  code_changes: AiCodeChange[];
  limit: number;
  kind: string;
  username_filter: string | null;
};

type AiSpecAccess = {
  id: number;
  turn_index: number | null;
  spec_scope: string;
  doc_path: string | null;
  access_type?: string | null;
  access_source?: string | null;
  matched_doc_count?: number;
  matched_docs?: string[] | null;
  via_catalog: boolean;
  confidence: string;
  occurred_at: string;
};

type ProjectSpecDocUsage = {
  doc_path: string;
  file_name?: string | null;
  read_count: number;
  edit_count: number;
  access_count: number;
  line_count?: number | null;
  size_bytes?: number | null;
  content_hash?: string | null;
  last_seen_at?: string | null;
  edit_locations?: Array<Record<string, unknown>>;
};

type AiRequestUsage = {
  id: number;
  turn_index: number | null;
  request_id: string;
  request_index: number;
  model: string | null;
  prompt_tokens: number | null;
  output_tokens: number | null;
  completion_tokens: number | null;
  elapsed_ms: number | null;
  copilot_credits: number | null;
  credits_source: string | null;
  occurred_at: string | null;
};

type AiTurn = {
  id: number;
  turn_index: number;
  status: string;
  created_at: string;
  completed_at: string | null;
  user_messages: AiMessage[];
  assistant_messages: AiMessage[];
  other_messages: AiMessage[];
  process_steps: AiProcessStep[];
  code_changes: AiCodeChange[];
  spec_accesses: AiSpecAccess[];
  request_usage: AiRequestUsage | null;
};

type AiSessionDetail = AiSessionSummary & {
  usage_totals: {
    prompt_tokens: number;
    output_tokens: number;
    completion_tokens: number;
    elapsed_ms: number;
    copilot_credits: number;
  };
  models_used: Record<string, number>;
  turns: AiTurn[];
  unassigned_process_steps: AiProcessStep[];
  unassigned_code_changes: AiCodeChange[];
  unassigned_spec_accesses: AiSpecAccess[];
  unassigned_request_usage: AiRequestUsage[];
};

type PluginClient = {
  client_id: string;
  tool: string;
  plugin_name: string | null;
  plugin_version: string | null;
  username: string | null;
  user_id: string | null;
  user_display_name: string | null;
  team: string | null;
  machine_id: string | null;
  model: string | null;
  last_seen_at: string;
};

type PluginClientGroup = {
  key: string;
  clients: PluginClient[];
  representative: PluginClient;
  last_seen_at: string;
  machine_id: string | null;
  plugin_versions: string[];
  tools: string[];
};

type DashboardView = "metrics" | "knowledge" | "code" | "sessions";

// ── Helpers ────────────────────────────────────────────────────────────────

function uniqueValues(values: string[]) {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function resolveApiBases() {
  const configured = String(import.meta.env.VITE_OBS_API_BASE || "").replace(/\/$/, "");
  const candidates = [configured];
  if (typeof window !== "undefined" && window.location.hostname) {
    candidates.push(`${window.location.protocol}//${window.location.hostname}:18080`);
  }
  return uniqueValues(candidates);
}

const apiBases = resolveApiBases();

async function apiFetch(path: string, init?: RequestInit) {
  let lastError: unknown;
  for (const base of apiBases) {
    const controller = new AbortController();
    const timeoutMs = Math.max(2500, Number(import.meta.env.VITE_OBS_API_TIMEOUT_MS || 10000) || 10000);
    let didTimeout = false;
    const timeout = window.setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = didTimeout ? new Error(`collector request timed out after ${timeoutMs}ms`) : error;
    } finally {
      window.clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("collector request failed");
}

function fmtValue(metric: Metric): string {
  if (metric.value === null || metric.value === undefined) return "—";
  if (metric.unit === "table") return "详情";
  if (metric.unit === "count") return metric.value.toLocaleString();
  if (metric.unit === "number") return metric.value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return `${Math.round(metric.value * 1000) / 10}%`;
}

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}+08:00`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(/\//g, "-");
}

function fmtDuration(milliseconds: number | null | undefined) {
  if (!milliseconds) return "0s";
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}m ${remaining}s`;
}

function fmtNumber(value: number | null | undefined) {
  return (value ?? 0).toLocaleString();
}

function numericValue(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function parseDate(value: string | null | undefined) {
  if (!value) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}+08:00`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function minutesSince(value: string | null | undefined) {
  const date = parseDate(value);
  if (!date) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - date.getTime()) / 60000);
}

function shortId(value: string | null | undefined, length = 12) {
  if (!value) return "—";
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function statusTone(status: string | null | undefined): "good" | "warn" | "bad" | "blue" | "default" {
  if (!status) return "default";
  if (["completed", "success", "active", "online"].includes(status)) return "good";
  if (["failed", "error", "offline"].includes(status)) return "bad";
  if (["idle", "pending", "unassigned"].includes(status)) return "warn";
  return "blue";
}

function statusLabel(status: string | null | undefined) {
  const value = String(status || "");
  const labels: Record<string, string> = {
    completed: "已完成",
    success: "成功",
    active: "活跃",
    online: "在线",
    failed: "失败",
    error: "错误",
    offline: "离线",
    idle: "空闲",
    pending: "待处理",
    processing: "处理中",
    in_progress: "进行中",
    unassigned: "未归属",
  };
  return labels[value] || value || "未知";
}

function totalTokens(summary: MetricsResponse["summary"] | undefined) {
  if (!summary) return 0;
  return (summary.prompt_tokens_total ?? 0) + (summary.output_tokens_total ?? 0) + (summary.completion_tokens_total ?? 0);
}

function fmtCredits(value?: number | null) {
  return `${fmtNumber(value ?? 0)} credits`;
}

function hasRequestUsage(usage: AiRequestUsage | null | undefined) {
  if (!usage) return false;
  return Boolean(
    usage.model
    || (usage.prompt_tokens ?? 0) > 0
    || (usage.output_tokens ?? 0) > 0
    || (usage.completion_tokens ?? 0) > 0
    || (usage.elapsed_ms ?? 0) > 0
    || (usage.copilot_credits ?? 0) > 0
  );
}

function hasSessionUsage(detail: AiSessionDetail) {
  const totals = detail.usage_totals;
  return Boolean(
    detail.model
    || Object.keys(detail.models_used || {}).length > 0
    || (totals?.prompt_tokens ?? 0) > 0
    || (totals?.output_tokens ?? 0) > 0
    || (totals?.completion_tokens ?? 0) > 0
    || (totals?.elapsed_ms ?? 0) > 0
    || (totals?.copilot_credits ?? 0) > 0
  );
}

function averageLatency(summary: MetricsResponse["summary"] | undefined) {
  const count = summary?.request_usage_count ?? 0;
  return count > 0 ? Math.round((summary?.elapsed_ms_total ?? 0) / count) : 0;
}

function countToolSteps(detail: AiSessionDetail | null) {
  if (!detail) return 0;
  return detail.turns.reduce((count, turn) => (
    count + turn.process_steps.filter((step) => step.tool_name || step.tool_call_id || step.step_type.includes("tool")).length
  ), 0) + detail.unassigned_process_steps.filter((step) => step.tool_name || step.tool_call_id || step.step_type.includes("tool")).length;
}

function allMetrics(metrics: MetricsResponse | null) {
  return metrics?.categories.flatMap((category) => category.metrics.map((metric) => ({
    ...metric,
    categoryKey: category.key,
    category: category.title,
  }))) ?? [];
}

function metricsByIds(metrics: MetricsResponse | null, ids: number[]) {
  const idSet = new Set(ids);
  return allMetrics(metrics).filter((metric) => idSet.has(metric.id));
}

function selectedSessionCodeChangeCount(detail: AiSessionDetail | null) {
  if (!detail) return 0;
  return detail.turns.reduce((count, turn) => count + sessionEvidenceCodeChanges(turn.code_changes || []).length, 0)
    + sessionEvidenceCodeChanges(detail.unassigned_code_changes || []).length;
}

function sessionEvidenceCodeChanges(changes: AiCodeChange[]) {
  return changes.filter((change) => !isCommitCodeChange(change));
}

function confidenceTone(c: string): "good" | "warn" | "bad" | "default" {
  if (c === "direct") return "good";
  if (c === "derived") return "default";
  return "warn";
}

function identityLabel(item: Partial<AiSessionSummary>) {
  return item.user_display_name || item.user_id || item.username || "";
}

function personName(item: { user_display_name?: string | null; username?: string | null; user_id?: string | null }) {
  if (item.user_display_name) return item.user_display_name;
  if (item.username && item.username !== "unknown" && item.username !== "user") return item.username;
  return item.user_id || "未知用户";
}

function personIdentityNote(item: { user_id?: string | null; team?: string | null }) {
  if (item.team && item.user_id) return `${item.team} · ${item.user_id}`;
  if (item.team) return item.team;
  if (item.user_id) return `ID ${item.user_id}`;
  return "未配置用户 ID";
}

function pluginPersonKey(client: PluginClient) {
  return (client.user_id || client.user_display_name || client.username || client.client_id || "unknown").trim().toLowerCase();
}

function latestClient(clients: PluginClient[]) {
  return clients.reduce((latest, client) => {
    const latestTime = parseDate(latest.last_seen_at)?.getTime() ?? 0;
    const clientTime = parseDate(client.last_seen_at)?.getTime() ?? 0;
    return clientTime > latestTime ? client : latest;
  }, clients[0]);
}

function groupPluginClients(clients: PluginClient[]): PluginClientGroup[] {
  const byPerson = new Map<string, PluginClient[]>();
  for (const client of clients) {
    const key = pluginPersonKey(client);
    byPerson.set(key, [...(byPerson.get(key) || []), client]);
  }

  const groups: PluginClientGroup[] = [];
  for (const [personKey, personClients] of byPerson.entries()) {
    const knownMachines = uniqueValues(personClients.map((client) => client.machine_id || "").filter(Boolean));
    if (knownMachines.length <= 1) {
      const representative = latestClient(personClients);
      groups.push({
        key: `${personKey}:${knownMachines[0] || "unknown-machine"}`,
        clients: personClients,
        representative,
        last_seen_at: representative.last_seen_at,
        machine_id: knownMachines[0] || null,
        plugin_versions: uniqueValues(personClients.map((client) => client.plugin_version || "").filter(Boolean)),
        tools: uniqueValues(personClients.map((client) => client.tool || "").filter(Boolean)),
      });
      continue;
    }

    const byMachine = new Map<string, PluginClient[]>();
    for (const client of personClients) {
      const machineKey = client.machine_id || `unknown:${client.client_id}`;
      byMachine.set(machineKey, [...(byMachine.get(machineKey) || []), client]);
    }
    for (const [machineKey, machineClients] of byMachine.entries()) {
      const representative = latestClient(machineClients);
      groups.push({
        key: `${personKey}:${machineKey}`,
        clients: machineClients,
        representative,
        last_seen_at: representative.last_seen_at,
        machine_id: representative.machine_id,
        plugin_versions: uniqueValues(machineClients.map((client) => client.plugin_version || "").filter(Boolean)),
        tools: uniqueValues(machineClients.map((client) => client.tool || "").filter(Boolean)),
      });
    }
  }

  return groups.sort((a, b) => (parseDate(b.last_seen_at)?.getTime() ?? 0) - (parseDate(a.last_seen_at)?.getTime() ?? 0));
}

function pluginDisplayName(client: PluginClient) {
  return client.plugin_name || client.tool || "未知插件";
}

function toolDisplayName(tool: string | null | undefined) {
  const value = String(tool || "").toLowerCase();
  const labels: Record<string, string> = {
    copilot: "Copilot",
    claude: "Claude",
    codex: "Codex",
    git: "Git commit",
  };
  return labels[value] || tool || "未知工具";
}

function pluginGroupStatus(group: PluginClientGroup) {
  return minutesSince(group.last_seen_at) <= 30 ? "online" : "offline";
}

function pluginGroupFilterValue(group: PluginClientGroup) {
  const client = group.representative;
  return client.username || client.user_id || client.user_display_name || "";
}

function PluginLoginPanel({
  groups,
  selectedUser,
  onSelectUser,
}: {
  groups: PluginClientGroup[];
  selectedUser: string;
  onSelectUser: (username: string) => void;
}) {
  return (
    <section className="plugin-login-panel">
      <div className="plugin-login-head">
        <div>
          <h3>用户登录插件</h3>
          <p>{groups.length ? `${fmtNumber(groups.length)} 个登录采集端` : "等待插件心跳"}</p>
        </div>
        <Badge tone={groups.some((group) => pluginGroupStatus(group) === "online") ? "good" : "warn"}>
          {groups.filter((group) => pluginGroupStatus(group) === "online").length} 在线
        </Badge>
      </div>
      <div className="plugin-login-list">
        {groups.length === 0 ? (
          <div className="plugin-login-empty">暂无插件登录记录</div>
        ) : groups.slice(0, 6).map((group) => {
          const client = group.representative;
          const filterValue = pluginGroupFilterValue(group);
          const active = Boolean(filterValue && selectedUser === filterValue);
          const online = pluginGroupStatus(group) === "online";
          return (
            <button
              className={`plugin-login-item ${active ? "active" : ""}`}
              key={group.key}
              onClick={() => filterValue && onSelectUser(filterValue)}
              disabled={!filterValue}
              title={identityLabel(client) || client.client_id}
            >
              <span className={`plugin-login-dot ${online ? "online" : "offline"}`} />
              <span className="plugin-login-main">
                <strong>{personName(client)}</strong>
                <small>{personIdentityNote(client)}</small>
              </span>
              <span className="plugin-login-meta">
                <span>{pluginDisplayName(client)}</span>
                <small>
                  {group.tools.map(toolDisplayName).join(" / ") || toolDisplayName(client.tool)}
                  {group.plugin_versions.length ? ` · v${group.plugin_versions.join(" / v")}` : ""}
                </small>
                <small>{online ? "在线" : "离线"} · {fmtTime(group.last_seen_at)}</small>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function readableValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => readableValue(item)).filter(Boolean).join(" ") || fallback;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["name", "toolName", "displayName", "label", "title", "id", "kind", "command"]) {
      const text = readableValue(record[key]);
      if (text) return text;
    }
    const text = readableValue(record.value) || readableValue(record.message) || readableValue(record.input);
    if (text) return text;
  }
  return fallback;
}

function cleanDisplayPath(value: unknown) {
  let text = readableValue(value);
  const markdownLink = /\[[^\]]*\]\(([^)]+)\)/.exec(text);
  if (markdownLink) text = markdownLink[1];
  text = text
    .replace(/^\]\(/, "")
    .replace(/^file:\/\//, "")
    .replace(/#.*/, "")
    .replace(/[),.;:\s]+$/, "");
  return text;
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Badge({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "good" | "bad" | "warn" | "blue" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function SummaryCard({
  label,
  value,
  hint,
  tone = "default",
  className = "",
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "default" | "primary" | "success" | "warning" | "danger";
  className?: string;
}) {
  return (
    <div className={`card card-${tone} ${className}`.trim()}>
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      {hint && <div className="card-hint">{hint}</div>}
    </div>
  );
}

function AttributionSummaryCard({
  label,
  note,
  parts,
  total,
  hint,
  tone = "default",
}: {
  label: string;
  note?: string;
  parts?: Array<{ label: string; value: React.ReactNode; tone?: "add" | "remove" | "edit" }>;
  total?: React.ReactNode;
  hint?: string;
  tone?: "default" | "primary" | "success" | "warning" | "danger";
}) {
  return (
    <div className={`card card-${tone} attribution-card`}>
      <div className="attribution-card-head">
        <div>
          <div className="attribution-title">{label}</div>
          {note && <div className="attribution-note">{note}</div>}
        </div>
      </div>
      {total !== undefined && <div className="attribution-total">{total}</div>}
      {parts && parts.length > 0 && (
        <div className="attribution-parts">
          {parts.map((part) => (
            <div className={`attribution-part attribution-part-${part.tone || "default"}`} key={part.label}>
              <span>{part.label}</span>
              <strong>{part.value}</strong>
            </div>
          ))}
        </div>
      )}
      {hint && <div className="attribution-hint">{hint}</div>}
    </div>
  );
}

function ModuleSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="module">
      <div className="module-header">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </section>
  );
}

function messageContent(message: AiMessage) {
  if (message.content && message.content.trim()) return message.content;
  return "";
}

function hasMessageContent(message: AiMessage) {
  return Boolean(message.content && message.content.trim());
}

function messageMissingContentSummary(message: AiMessage) {
  const parts: string[] = [];
  if (message.text_len > 0) parts.push(`${fmtNumber(message.text_len)} 字符`);
  if (message.text_hash) parts.push(`hash ${message.text_hash.slice(0, 12)}`);
  return parts.length ? parts.join(" · ") : "正文未入库";
}

function isBlobPreviewMessage(message: AiMessage) {
  return message.content_storage === "blob_preview" && Boolean(message.raw_event_id && message.blob_ref);
}

function messageBlobSummary(message: AiMessage) {
  const parts: string[] = [];
  if (message.text_len > 0) parts.push(`原文 ${fmtNumber(message.text_len)} 字`);
  if (message.blob_original_bytes) parts.push(`${fmtNumber(message.blob_original_bytes)} bytes`);
  if (message.blob_compressed_bytes) parts.push(`压缩 ${fmtNumber(message.blob_compressed_bytes)} bytes`);
  return parts.join(" · ");
}

async function fetchMessageBlob(message: AiMessage) {
  if (!message.raw_event_id || !message.blob_ref) throw new Error("missing blob reference");
  const res = await apiFetch(
    `/api/v1/raw-events/${encodeURIComponent(message.raw_event_id)}/blobs/${encodeURIComponent(message.blob_ref)}`
  );
  const body = (await res.json()) as RawEventBlobResponse;
  return body.content || "";
}

function messageLineCount(content: string) {
  return content.split(/\r?\n/).length;
}

function shouldCollapseMessage(content: string, role: "user" | "assistant") {
  if (role !== "assistant") return false;
  return content.length > 520 || messageLineCount(content) > 8;
}

function messagePreview(content: string) {
  const compact = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
  const source = compact || content.trim();
  return source.length > 220 ? `${source.slice(0, 220)}…` : source;
}

function fileNameFromPath(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || path;
}

function compactDisplayPath(path: string, keepSegments = 6) {
  const clean = cleanDisplayPath(path);
  const parts = clean.split(/[\\/]/).filter(Boolean);
  if (parts.length <= keepSegments) return clean;
  return `…/${parts.slice(-keepSegments).join("/")}`;
}

function toolActionLabel(step: AiProcessStep) {
  const content = step.content || "";
  const actionMatch = /^(读取文件|修改文件|创建文件|编辑文件|应用补丁)：/.exec(content);
  if (actionMatch) return actionMatch[1];
  const tool = step.tool_name || step.step_type;
  const labels: Record<string, string> = {
    exec_command: "运行命令",
    read_file: "读取文件",
    replace_string_in_file: "修改文件",
    insert_edit_into_file: "修改文件",
    create_file: "创建文件",
    write_file: "写入文件",
    apply_patch: "应用补丁",
    run_in_terminal: "运行命令",
    grep_search: "搜索文本",
    list_dir: "查看目录",
    list_directory: "查看目录",
    file_search: "查找文件",
    semantic_search: "语义搜索",
    codebase_search: "代码搜索",
    unknown_tool: "工具输出",
  };
  return labels[tool] || tool || "工具调用";
}

function tryParseJsonRecord(value: string) {
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function compactOneLine(value: string, maxLength = 180) {
  const text = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function commandTextFromContent(content: string) {
  const parsed = tryParseJsonRecord(content);
  const cmd = parsed?.cmd ?? parsed?.command;
  if (Array.isArray(cmd)) return cmd.map((part) => String(part)).join(" ");
  if (typeof cmd === "string") return cmd;
  return "";
}

function displayToolName(step: AiProcessStep) {
  const tool = step.tool_name || step.step_type || "";
  if (tool === "exec_command" || tool === "run_in_terminal") return "命令";
  if (tool === "unknown_tool") return "输出";
  return tool || "工具";
}

function looksLikePath(value: string) {
  return /^(\.{0,2}\/|~\/|\/|[A-Za-z]:[\\/])/.test(value) || value.includes("/") || value.includes("\\");
}

function parseToolDisplay(step: AiProcessStep) {
  const content = (step.content || "").trim();
  const action = toolActionLabel(step);
  const commandText = commandTextFromContent(content);
  if (commandText) {
    return {
      kind: "command" as const,
      action,
      target: commandText,
      primary: compactOneLine(commandText, 120),
      secondary: compactOneLine(commandText, 220),
      range: "",
      detail: "",
      status: step.status,
    };
  }
  if ((step.tool_name || step.step_type) === "unknown_tool" && content) {
    return {
      kind: "output" as const,
      action,
      target: content,
      primary: "执行输出",
      secondary: compactOneLine(content, 220),
      range: "",
      detail: "",
      status: step.status,
    };
  }
  const chineseMatch = /^(读取文件|修改文件|创建文件|编辑文件|应用补丁)：(.+)$/.exec(content);
  const genericMatch = /^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/.exec(content);
  const rawTarget = chineseMatch?.[2] || genericMatch?.[2] || "";
  const parts = rawTarget.split(" · ").map((part) => part.trim()).filter(Boolean);
  const target = cleanDisplayPath(parts[0]);
  const range = parts.slice(1).find((part) => /行|line/i.test(part));
  const explicitStatus = parts.slice(1).find((part) => /complete|completed|requested|failed|error|success|pending/i.test(part));

  if (target && looksLikePath(target)) {
    const fileName = fileNameFromPath(target);
    const isDirectoryTool = /list_dir|list_directory/i.test(step.tool_name || "");
    return {
      kind: "path" as const,
      action,
      target,
      primary: fileName,
      secondary: compactDisplayPath(target),
      range,
      detail: isDirectoryTool ? "目录" : range,
      status: explicitStatus,
    };
  }

  const redundantContent = !content || content === step.tool_name || content === step.step_type || content === `${step.tool_name} · ${step.status || ""}`;
  return {
    kind: "generic" as const,
    action,
    target: redundantContent ? "" : content,
    primary: action,
    secondary: redundantContent ? "" : content,
    range: "",
    detail: explicitStatus,
    status: explicitStatus,
  };
}

function TurnMessageBlock({
  message,
  role,
  label,
}: {
  message: AiMessage;
  role: "user" | "assistant";
  label: string;
}) {
  const [fullContent, setFullContent] = useState<string>("");
  const [fullOpen, setFullOpen] = useState(false);
  const [blobLoading, setBlobLoading] = useState(false);
  const [blobError, setBlobError] = useState("");
  const content = messageContent(message);
  const hasInlineContent = hasMessageContent(message);
  const blobPreview = isBlobPreviewMessage(message);
  if (!content && !message.text_len && !message.text_hash) return null;
  const collapsible = shouldCollapseMessage(content, role);
  const lines = messageLineCount(content);
  async function toggleFullBlob() {
    if (fullOpen) {
      setFullOpen(false);
      return;
    }
    setBlobError("");
    if (!fullContent) {
      setBlobLoading(true);
      try {
        const nextContent = await fetchMessageBlob(message);
        setFullContent(nextContent);
      } catch (error) {
        setBlobError(error instanceof Error ? error.message : String(error));
        return;
      } finally {
        setBlobLoading(false);
      }
    }
    setFullOpen(true);
  }
  if (!hasInlineContent) {
    return (
      <div className={`turn-message turn-${role} turn-message-missing`} key={message.id}>
        <div className="turn-message-head">
          <div className="turn-role">{label}</div>
          <span className="message-size">{messageMissingContentSummary(message)}</span>
        </div>
        <div className="missing-message-note">
          这条历史消息没有正文内容，只采集到了长度和 hash；无法生成正文预览。新采集到的长文本会在这里显示摘要，完整原文仍按原始事件/Blob 策略保存。
        </div>
      </div>
    );
  }
  if (blobPreview) {
    return (
      <div className={`turn-message turn-${role} turn-message-blob`} key={message.id}>
        <div className="turn-message-head">
          <div className="turn-role">{label}</div>
          <span className="message-size">{messageBlobSummary(message)}</span>
        </div>
        <div className="turn-content">{content}</div>
        <div className="message-blob-actions">
          <button className="btn btn-compact" type="button" onClick={toggleFullBlob} disabled={blobLoading}>
            {blobLoading ? "加载中..." : fullOpen ? "收起完整内容" : "查看完整内容"}
          </button>
          {message.blob_ref && <span className="message-blob-ref">{message.blob_ref}</span>}
          {blobError && <span className="message-blob-error">{blobError}</span>}
        </div>
        {fullOpen && fullContent && (
          <div className="message-blob-full">
            <div className="turn-content message-full">{fullContent}</div>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={`turn-message turn-${role} ${collapsible ? "turn-message-collapsible" : ""}`} key={message.id}>
      <div className="turn-message-head">
        <div className="turn-role">{label}</div>
        {collapsible && <span className="message-size">{fmtNumber(content.length)} 字 · {fmtNumber(lines)} 行</span>}
      </div>
      {collapsible ? (
        <details className="message-collapse">
          <summary>
            <span className="message-preview">{messagePreview(content)}</span>
            <span className="message-toggle">
              <span className="message-toggle-open">展开完整回答</span>
              <span className="message-toggle-close">收起回答</span>
            </span>
          </summary>
          <div className="turn-content message-full">{content}</div>
        </details>
      ) : (
        <div className="turn-content">{content}</div>
      )}
    </div>
  );
}

function StepSummary({ step }: { step: AiProcessStep }) {
  const isTool = Boolean(step.tool_name || step.tool_call_id || step.step_type.includes("tool"));
  const isReasoning = /reasoning|thinking/i.test(step.step_type);
  const toolDisplay = isTool ? parseToolDisplay(step) : null;
  const className = `turn-step ${isTool ? "turn-step-tool-call" : ""} ${toolDisplay ? "turn-step-file-tool" : ""} ${isReasoning ? "turn-step-reasoning" : ""}`;
  const meta = [
    step.actor_path && `执行方 ${step.actor_path}`,
    step.tool_call_id && `调用 ${shortId(step.tool_call_id, 10)}`,
    step.request_id && `请求 ${shortId(step.request_id, 10)}`,
  ].filter(Boolean).join(" · ");
  return (
    <div className={className}>
      <span className="turn-step-kind">{isTool ? "工具" : step.step_type}</span>
      {isTool && <span className="turn-step-tool">{displayToolName(step)}</span>}
      <span className="turn-step-content">
        {toolDisplay ? (
          <span className="tool-file-summary">
            <span className="tool-file-main">
              <span className="tool-action">{toolDisplay.action}</span>
              {toolDisplay.kind === "path" && (
                <span className="tool-file-name" title={toolDisplay.target}>{toolDisplay.primary}</span>
              )}
              {(toolDisplay.kind === "command" || toolDisplay.kind === "output" || toolDisplay.kind === "generic") && toolDisplay.primary && (
                <span className="tool-command-preview" title={toolDisplay.target || toolDisplay.primary}>{toolDisplay.primary}</span>
              )}
              {toolDisplay.range && <span className="tool-range">{toolDisplay.range}</span>}
              {!toolDisplay.range && toolDisplay.detail && <span className="tool-range">{toolDisplay.detail}</span>}
            </span>
            {toolDisplay.secondary && (
              <span className="tool-file-path" title={toolDisplay.target || toolDisplay.secondary}>{toolDisplay.secondary}</span>
            )}
          </span>
        ) : (
          step.content || step.title || meta || "已记录过程"
        )}
        {meta && (step.content || step.title) && <small>{meta}</small>}
      </span>
      {step.status && <Badge tone={statusTone(step.status)}>{statusLabel(step.status)}</Badge>}
    </div>
  );
}

function processStepLabel(step: AiProcessStep) {
  if (step.tool_name || step.tool_call_id || step.step_type.includes("tool")) return toolActionLabel(step);
  return step.title || step.step_type || "过程";
}

function ActivitySummaryChips({
  steps,
  codeChanges,
  specAccesses,
}: {
  steps: AiProcessStep[];
  codeChanges: AiCodeChange[];
  specAccesses: AiSpecAccess[];
}) {
  const toolSteps = steps.filter((step) => step.tool_name || step.tool_call_id || step.step_type.includes("tool"));
  const reasoningSteps = steps.filter((step) => /reasoning|thinking/i.test(step.step_type));
  const visibleTools = uniqueStrings(toolSteps.map((step) => processStepLabel(step))).slice(0, 6);
  return (
    <div className="activity-chips">
      {toolSteps.length > 0 && <span className="activity-chip tool">工具 {toolSteps.length}</span>}
      {reasoningSteps.length > 0 && <span className="activity-chip reasoning">可见思考 {reasoningSteps.length}</span>}
      {codeChanges.length > 0 && <span className="activity-chip code">代码变更 {codeChanges.length}</span>}
      {specAccesses.length > 0 && <span className="activity-chip spec">规范访问 {specAccesses.length}</span>}
      {visibleTools.map((tool) => <span className="activity-chip muted" key={tool}>{shortId(tool, 24)}</span>)}
    </div>
  );
}

function TurnActivityDetails({
  steps,
  codeChanges,
  specAccesses,
  defaultOpen = false,
}: {
  steps: AiProcessStep[];
  codeChanges: AiCodeChange[];
  specAccesses: AiSpecAccess[];
  defaultOpen?: boolean;
}) {
  const [showAllSteps, setShowAllSteps] = useState(false);
  const previewLimit = 8;
  const visibleSteps = showAllSteps ? steps : steps.slice(0, previewLimit);
  const hiddenStepCount = Math.max(steps.length - visibleSteps.length, 0);
  if (steps.length === 0 && codeChanges.length === 0 && specAccesses.length === 0) return null;
  return (
    <details className="turn-details activity-details" open={defaultOpen}>
      <summary>
        <span className="activity-summary-title">过程与动作</span>
        <span className="activity-summary-counts">
          {steps.length} 步 · {codeChanges.length} 个代码变更 · {specAccesses.length} 次规范访问
        </span>
      </summary>
      <div className="activity-panel">
        <ActivitySummaryChips steps={steps} codeChanges={codeChanges} specAccesses={specAccesses} />
        <div className="turn-detail-body compact-steps">
          {visibleSteps.map((step) => <StepSummary step={step} key={step.id} />)}
          {hiddenStepCount > 0 && (
            <button className="show-more-steps" type="button" onClick={() => setShowAllSteps(true)}>
              查看剩余 {hiddenStepCount} 步
            </button>
          )}
          <CodeChangeGroups changes={codeChanges} compact />
          {specAccesses.map((access) => <SpecAccessSummary access={access} key={`spec-${access.id}`} />)}
        </div>
      </div>
    </details>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function codeRaw(change: AiCodeChange) {
  const diff = asRecord(change.diff_json);
  if (diff) {
    if (Array.isArray(diff.hunks) || Array.isArray(diff.changes)) return diff;
  }
  return diff || {};
}

function isCommitCodeChange(change: AiCodeChange) {
  return change.change_type === "commit_snapshot" || change.snapshot_kind === "commit_snapshot" || change.diff_json?.event_type === "commit_snapshot";
}

function isAiEvidenceCodeChange(change: AiCodeChange) {
  const kind = String(change.snapshot_kind || change.diff_json?.snapshot_kind || change.change_type || "").toLowerCase();
  return (
    kind.startsWith("copilot_turn_")
    || kind.startsWith("claude_turn_")
    || kind.startsWith("codex_turn_")
    || kind.startsWith("codex_tool_")
    || kind === "codex_mcp_auto_capture"
    || kind.includes("editor_delta")
    || kind.includes("workspace_diff")
    || kind.includes("tool_patch")
    || kind.includes("tool_edit")
  );
}

function aiEvidenceDefaultAttribution(change: AiCodeChange) {
  if (isCommitCodeChange(change) || !isAiEvidenceCodeChange(change)) return {};
  return {
    defaultAddedClassification: "ai_current",
    defaultRemovedClassification: "ai_evidence_removed",
  };
}

function splitCodeChanges(changes: AiCodeChange[]) {
  const commitSnapshots = changes.filter(isCommitCodeChange);
  const aiEvidenceChanges = changes.filter((change) => !isCommitCodeChange(change) && isAiEvidenceCodeChange(change));
  const otherChanges = changes.filter((change) => !isCommitCodeChange(change) && !isAiEvidenceCodeChange(change));
  return { commitSnapshots, aiEvidenceChanges, otherChanges };
}

function lineNumber(line: Record<string, unknown>) {
  const value = line.line_type === "removed" ? line.old_line : line.new_line;
  return typeof value === "number" ? String(value) : "";
}

function attributionLabel(value: unknown) {
  const text = String(value || "");
  if (text === "ai_current") return "AI 当前";
  if (text === "ai_current_moved") return "AI 移动";
  if (text === "ai_evidence_removed") return "AI 删除";
  if (text === "ai_assisted_human_edited") return "AI 辅助后人工改写";
  if (text === "human_removed_ai_origin") return "人工删除 AI 来源";
  if (text === "human_current") return "人工当前（未命中 AI 证据）";
  return "";
}

function commitAttributionCounts(change: AiCodeChange, rawInput?: Record<string, unknown>) {
  const raw = rawInput || codeRaw(change);
  const attributionStatus = readableValue(raw.attribution_status, "");
  const generated = raw.generated_artifact === true || raw.excluded_from_ai_attribution === true;
  if (attributionStatus === "pending") {
    return {
      aiAdded: 0,
      aiDeleted: 0,
      aiModified: 0,
      humanAdded: 0,
      humanDeleted: 0,
      humanCurrentAdded: 0,
      humanCurrentDeleted: 0,
      humanCurrentModified: 0,
      aiAssistedHumanEditedAdded: 0,
      aiAssistedHumanEditedModified: 0,
      aiOriginDeletedByHuman: 0,
      standaloneAiOriginDeletedByHuman: 0,
      humanDedupedChanges: 0,
      pendingAdded: change.lines_added,
      pendingDeleted: change.lines_deleted,
      generatedAdded: 0,
      generatedDeleted: 0,
      attributionStatus,
      generated,
    };
  }
  if (generated || attributionStatus === "skipped") {
    return {
      aiAdded: 0,
      aiDeleted: 0,
      aiModified: 0,
      humanAdded: 0,
      humanDeleted: 0,
      humanCurrentAdded: 0,
      humanCurrentDeleted: 0,
      humanCurrentModified: 0,
      aiAssistedHumanEditedAdded: 0,
      aiAssistedHumanEditedModified: 0,
      aiOriginDeletedByHuman: 0,
      standaloneAiOriginDeletedByHuman: 0,
      humanDedupedChanges: 0,
      pendingAdded: 0,
      pendingDeleted: 0,
      generatedAdded: change.lines_added,
      generatedDeleted: change.lines_deleted,
      attributionStatus: attributionStatus || "skipped",
      generated,
    };
  }
  const aiAdded = numericValue(raw.ai_lines_added, 0);
  const aiDeleted = numericValue(raw.ai_lines_deleted, 0);
  const aiModified = numericValue(raw.ai_lines_modified, 0);
  const humanAdded = numericValue(raw.human_lines_added, Math.max(change.lines_added - aiAdded, 0));
  const humanDeleted = numericValue(raw.human_lines_deleted, Math.max(change.lines_deleted - aiDeleted, 0));
  const humanCurrentAdded = numericValue(raw.human_current_lines_added, humanAdded);
  const humanCurrentDeleted = numericValue(raw.human_current_lines_deleted, 0);
  const humanCurrentModified = numericValue(raw.human_current_lines_modified, 0);
  const aiAssistedHumanEditedAdded = numericValue(raw.ai_assisted_human_edited_lines_added, 0);
  const aiAssistedHumanEditedModified = numericValue(raw.ai_assisted_human_edited_lines_modified, 0);
  const aiOriginDeletedByHuman = numericValue(raw.ai_origin_lines_deleted_by_human, 0);
  const standaloneAiOriginDeletedByHuman = Math.max(aiOriginDeletedByHuman - aiAssistedHumanEditedModified, 0);
  const humanDedupedChanges = Math.max(humanAdded + humanDeleted - numericValue(raw.human_lines_modified, 0), 0);
  return {
    aiAdded,
    aiDeleted,
    aiModified,
    humanAdded,
    humanDeleted,
    humanCurrentAdded,
    humanCurrentDeleted,
    humanCurrentModified,
    aiAssistedHumanEditedAdded,
    aiAssistedHumanEditedModified,
    aiOriginDeletedByHuman,
    standaloneAiOriginDeletedByHuman,
    humanDedupedChanges,
    pendingAdded: numericValue(raw.unattributed_lines_added, 0),
    pendingDeleted: numericValue(raw.unattributed_lines_deleted, 0),
    generatedAdded: 0,
    generatedDeleted: 0,
    attributionStatus: attributionStatus || "complete",
    generated,
  };
}

type CommitGroup = {
  key: string;
  commitSha: string;
  branch: string | null;
  occurredAt: string;
  submitters: string[];
  sessionIds: string[];
  evidenceEventIds: string[];
  fileCount: number;
  files: AiCodeChange[];
  linesAdded: number;
  linesDeleted: number;
  linesModified: number;
  aiCurrentAdded: number;
  aiCurrentDeleted: number;
  aiCurrentModified: number;
  humanCurrentAdded: number;
  humanCurrentDeleted: number;
  humanCurrentModified: number;
  aiAssistedHumanEditedAdded: number;
  aiAssistedHumanEditedModified: number;
  aiOriginDeletedByHuman: number;
  pendingAdded: number;
  pendingDeleted: number;
  generatedAdded: number;
  generatedDeleted: number;
  matchedEvidenceCount: number;
  hasBlobOrTruncated: boolean;
};

function commitShaForChange(change: AiCodeChange) {
  const raw = codeRaw(change);
  return readableValue(raw.commit_sha || raw.commitSha || raw.sha || raw.head_sha || raw.headSha, change.event_id || `change-${change.id}`);
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter(Boolean).map(String)));
}

function submitterName(change: AiCodeChange) {
  const raw = codeRaw(change);
  return readableValue(
    change.submitter_username ||
      change.submitter_user_id ||
      raw.submitter_username ||
      raw.username ||
      raw.user_id ||
      change.submitter_display_name ||
      raw.submitter_display_name,
    ""
  );
}

function matchedAiEventIds(change: AiCodeChange) {
  const raw = codeRaw(change);
  const values = asArray(raw.matched_ai_change_event_ids).map((item) => readableValue(item)).filter(Boolean);
  return uniqueStrings(values);
}

function hasLargeBlobReference(change: AiCodeChange) {
  const raw = codeRaw(change);
  return Boolean(
    raw.line_attribution_truncated ||
    raw.diff_truncated ||
    raw.product_detail_policy === "line_attribution_summary_only" ||
    raw.blob_ref ||
    raw.blob_refs ||
    raw.blobs ||
    raw.raw_event_blobs
  );
}

function groupCommitChanges(changes: AiCodeChange[]): CommitGroup[] {
  const groups = new Map<string, CommitGroup>();
  changes.filter(isCommitCodeChange).forEach((change) => {
    const raw = codeRaw(change);
    const commitSha = commitShaForChange(change);
    const key = commitSha || change.event_id || String(change.id);
    const counts = commitAttributionCounts(change, raw);
    const lineSummary = asRecord(raw.line_attribution_summary);
    const linesModified = numericValue(raw.lines_modified ?? lineSummary?.lines_modified, 0);
    const branch = readableValue(raw.branch || raw.ref || raw.base_branch || raw.target_branch, "");
    const matchedIds = matchedAiEventIds(change);
    const existing = groups.get(key);
    const next: CommitGroup = existing || {
      key,
      commitSha,
      branch: branch || null,
      occurredAt: change.occurred_at,
      submitters: [],
      sessionIds: [],
      evidenceEventIds: [],
      fileCount: 0,
      files: [],
      linesAdded: 0,
      linesDeleted: 0,
      linesModified: 0,
      aiCurrentAdded: 0,
      aiCurrentDeleted: 0,
      aiCurrentModified: 0,
      humanCurrentAdded: 0,
      humanCurrentDeleted: 0,
      humanCurrentModified: 0,
      aiAssistedHumanEditedAdded: 0,
      aiAssistedHumanEditedModified: 0,
      aiOriginDeletedByHuman: 0,
      pendingAdded: 0,
      pendingDeleted: 0,
      generatedAdded: 0,
      generatedDeleted: 0,
      matchedEvidenceCount: 0,
      hasBlobOrTruncated: false,
    };
    next.branch = next.branch || branch || null;
    if (new Date(change.occurred_at).getTime() > new Date(next.occurredAt).getTime()) {
      next.occurredAt = change.occurred_at;
    }
    next.files.push(change);
    next.fileCount = next.files.length;
    next.linesAdded += change.lines_added;
    next.linesDeleted += change.lines_deleted;
    next.linesModified += linesModified;
    next.submitters = uniqueStrings([...next.submitters, submitterName(change)]);
    next.aiCurrentAdded += counts.aiAdded;
    next.aiCurrentDeleted += counts.aiDeleted;
    next.aiCurrentModified += counts.aiModified;
    next.humanCurrentAdded += counts.humanCurrentAdded;
    next.humanCurrentDeleted += counts.humanCurrentDeleted;
    next.humanCurrentModified += counts.humanCurrentModified;
    next.aiAssistedHumanEditedAdded += counts.aiAssistedHumanEditedAdded;
    next.aiAssistedHumanEditedModified += counts.aiAssistedHumanEditedModified;
    next.aiOriginDeletedByHuman += counts.standaloneAiOriginDeletedByHuman;
    next.pendingAdded += counts.pendingAdded;
    next.pendingDeleted += counts.pendingDeleted;
    next.generatedAdded += counts.generatedAdded;
    next.generatedDeleted += counts.generatedDeleted;
    next.sessionIds = uniqueStrings([...next.sessionIds, change.session_id]);
    next.evidenceEventIds = uniqueStrings([...next.evidenceEventIds, ...matchedIds]);
    next.matchedEvidenceCount = next.evidenceEventIds.length;
    next.hasBlobOrTruncated = next.hasBlobOrTruncated || hasLargeBlobReference(change);
    groups.set(key, next);
  });
  return Array.from(groups.values()).sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());
}

function sumCommitGroups(groups: CommitGroup[]) {
  return groups.reduce((acc, group) => {
    acc.files += group.fileCount;
    acc.linesAdded += group.linesAdded;
    acc.linesDeleted += group.linesDeleted;
    acc.linesModified += group.linesModified;
    acc.aiCurrentAdded += group.aiCurrentAdded;
    acc.aiCurrentDeleted += group.aiCurrentDeleted;
    acc.aiCurrentModified += group.aiCurrentModified;
    acc.humanCurrentAdded += group.humanCurrentAdded;
    acc.humanCurrentDeleted += group.humanCurrentDeleted;
    acc.humanCurrentModified += group.humanCurrentModified;
    acc.aiAssistedHumanEditedAdded += group.aiAssistedHumanEditedAdded;
    acc.aiAssistedHumanEditedModified += group.aiAssistedHumanEditedModified;
    acc.aiOriginDeletedByHuman += group.aiOriginDeletedByHuman;
    acc.evidence += group.matchedEvidenceCount;
    return acc;
  }, {
    files: 0,
    linesAdded: 0,
    linesDeleted: 0,
    linesModified: 0,
    aiCurrentAdded: 0,
    aiCurrentDeleted: 0,
    aiCurrentModified: 0,
    humanCurrentAdded: 0,
    humanCurrentDeleted: 0,
    humanCurrentModified: 0,
    aiAssistedHumanEditedAdded: 0,
    aiAssistedHumanEditedModified: 0,
    aiOriginDeletedByHuman: 0,
    evidence: 0,
  });
}

function DiffLine({ line }: { line: Record<string, unknown> }) {
  const lineType = String(line.line_type || "");
  const isRemoved = lineType === "removed";
  const isAdded = lineType === "added";
  const text = readableValue(line.text, "");
  const attribution = attributionLabel(line.classification);
  return (
    <div className={`diff-line ${isAdded ? "diff-added" : ""} ${isRemoved ? "diff-removed" : ""}`}>
      <span className="diff-sign">{isRemoved ? "-" : isAdded ? "+" : " "}</span>
      <span className="diff-line-no">{lineNumber(line)}</span>
      {attribution && <span className={`diff-attribution diff-attribution-${line.classification}`}>{attribution}</span>}
      <code>{text}</code>
    </div>
  );
}

function applyDefaultAttribution(
  line: Record<string, unknown>,
  defaultAddedClassification?: string,
  defaultRemovedClassification?: string,
) {
  if (line.classification) return line;
  const lineType = String(line.line_type || "");
  if (lineType === "added" && defaultAddedClassification) return { ...line, classification: defaultAddedClassification };
  if (lineType === "removed" && defaultRemovedClassification) return { ...line, classification: defaultRemovedClassification };
  return line;
}

function HunkLines({
  lines,
  index,
  emptyText,
  defaultAddedClassification,
  defaultRemovedClassification,
}: {
  lines: Record<string, unknown>[];
  index: number;
  emptyText: string;
  defaultAddedClassification?: string;
  defaultRemovedClassification?: string;
}) {
  if (lines.length === 0) return <div className="diff-empty">{emptyText}</div>;
  return (
    <>
      {lines.map((line, lineIndex) => (
        <DiffLine
          line={applyDefaultAttribution(line, defaultAddedClassification, defaultRemovedClassification)}
          key={`${index}-${lineIndex}`}
        />
      ))}
    </>
  );
}

function HunkView({
  hunk,
  index,
  splitRemoved = false,
  defaultAddedClassification,
  defaultRemovedClassification,
}: {
  hunk: Record<string, unknown>;
  index: number;
  splitRemoved?: boolean;
  defaultAddedClassification?: string;
  defaultRemovedClassification?: string;
}) {
  const lines = asArray(hunk.lines).map(asRecord).filter(Boolean) as Record<string, unknown>[];
  const removedLines = lines.filter((line) => String(line.line_type || "") === "removed");
  const activeLines = splitRemoved ? lines.filter((line) => String(line.line_type || "") !== "removed") : lines;
  const oldStart = readableValue(hunk.old_start);
  const oldLines = readableValue(hunk.old_lines);
  const newStart = readableValue(hunk.new_start);
  const newLines = readableValue(hunk.new_lines);
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-head">
        @@ -{oldStart || "?"},{oldLines || "?"} +{newStart || "?"},{newLines || "?"} @@
      </div>
      {splitRemoved && removedLines.length > 0 && (
        <div className="diff-subhead">修改后 / 新增 / 上下文行</div>
      )}
      <HunkLines
        lines={activeLines}
        index={index}
        emptyText="这个 hunk 没有采集到可展示的当前行"
        defaultAddedClassification={defaultAddedClassification}
        defaultRemovedClassification={defaultRemovedClassification}
      />
      {splitRemoved && removedLines.length > 0 && (
        <>
          <div className="diff-subhead diff-subhead-removed">已删除旧行，不属于当前文件内容</div>
          <HunkLines
            lines={removedLines}
            index={index + 10000}
            emptyText="这个 hunk 没有删除行"
            defaultAddedClassification={defaultAddedClassification}
            defaultRemovedClassification={defaultRemovedClassification}
          />
        </>
      )}
    </div>
  );
}

function CommitAttributionDiffView({ change }: { change: AiCodeChange }) {
  const raw = codeRaw(change);
  const attribution = asRecord(raw.line_attribution);
  const hunks = asArray(attribution?.hunks).map(asRecord).filter(Boolean) as Record<string, unknown>[];
  const counts = commitAttributionCounts(change, raw);
  const attributionTruncated = Boolean(raw.line_attribution_truncated || attribution?.full_line_attribution === false);
  const attributionLimit = numericValue(attribution?.full_line_attribution_limit, 5000);
  const rawAdded = numericValue(attribution?.raw_total_added_lines ?? raw.raw_total_added_lines, change.lines_added);
  const rawDeleted = numericValue(attribution?.raw_total_deleted_lines ?? raw.raw_total_deleted_lines, change.lines_deleted);
  const ignoredBlank = numericValue(attribution?.ignored_blank_lines ?? raw.ignored_blank_lines, 0);
  const displayHunks = hunks.filter((hunk) => asArray(hunk.lines).length > 0);

  return (
    <div className="code-diff">
      <div className="diff-empty">
        提交 diff 行级归因视图：这里展示的是本次提交的变更片段，不是最终文件全文；未变化的代码行不会出现在 diff 中。
        {" "}原始变更 +{fmtNumber(rawAdded)} -{fmtNumber(rawDeleted)}
        {ignoredBlank ? ` · 空白行 ${fmtNumber(ignoredBlank)} 行不参与 AI/人工指标` : ""}
        {" "}AI 当前新增 +{fmtNumber(counts.aiAdded)}
        {counts.aiDeleted ? ` · 删除 AI 来源 -${fmtNumber(counts.aiDeleted)}` : ""}
        {counts.aiModified ? ` · AI 来源修改 ${fmtNumber(counts.aiModified)}` : ""}
        {" · "}人工当前（未命中 AI 证据） +{fmtNumber(counts.humanCurrentAdded)} -{fmtNumber(counts.humanCurrentDeleted)} 改{fmtNumber(counts.humanCurrentModified)}
        {counts.aiAssistedHumanEditedModified ? ` · AI 辅助后人工改写 改${fmtNumber(counts.aiAssistedHumanEditedModified)}` : ""}
        {!counts.aiAssistedHumanEditedModified && counts.aiAssistedHumanEditedAdded ? ` · AI 辅助后人工改写 +${fmtNumber(counts.aiAssistedHumanEditedAdded)}` : ""}
        {counts.standaloneAiOriginDeletedByHuman ? ` · 人工删除 AI 来源 -${fmtNumber(counts.standaloneAiOriginDeletedByHuman)}` : ""}
      </div>
      {displayHunks.length > 0 ? (
        displayHunks.map((hunk, index) => <HunkView hunk={hunk} index={index} splitRemoved key={`commit-hunk-${index}`} />)
      ) : attributionTruncated ? (
        <>
          <div className="diff-empty">
            这个提交超过 {fmtNumber(attributionLimit)} 行阈值，行级证据已摘要化。完整提交 diff 可通过 blob 详情接口按需读取。
          </div>
          <RawCodeChangeDetail change={change} />
        </>
      ) : (
        <div className="diff-empty">这个提交没有匹配到 AI 行证据，按人工当前计入；判定原因是未命中 AI 证据。</div>
      )}
    </div>
  );
}

function AddedLinesView({
  changeRecord,
  defaultAddedClassification,
  defaultRemovedClassification,
}: {
  changeRecord: Record<string, unknown>;
  defaultAddedClassification?: string;
  defaultRemovedClassification?: string;
}) {
  const addedLines = asArray(changeRecord.added_lines).map(asRecord).filter(Boolean) as Record<string, unknown>[];
  const removedCount = Number(changeRecord.removed_line_count || 0);
  const removedAttribution = attributionLabel(defaultRemovedClassification);
  if (addedLines.length === 0 && removedCount === 0) return null;
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-head">
        {cleanDisplayPath(changeRecord.file_path) || "文件变更"} · 新增 {addedLines.length} 行 · 删除 {removedCount} 行
      </div>
      {addedLines.map((line, index) => (
        <DiffLine line={{ ...line, line_type: "added", classification: line.classification || defaultAddedClassification }} key={`added-${index}`} />
      ))}
      {removedCount > 0 && (
        <div className="diff-line diff-removed">
          <span className="diff-sign">-</span>
          <span className="diff-line-no">?</span>
          {removedAttribution && (
            <span className={`diff-attribution diff-attribution-${defaultRemovedClassification}`}>
              {removedAttribution}
            </span>
          )}
          <code>删除了 {removedCount} 行，删除内容未采集</code>
        </div>
      )}
    </div>
  );
}

function lineRangeText(start: number, count: number) {
  if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) return "";
  const end = start + count - 1;
  return start === end ? fmtNumber(start) : `${fmtNumber(start)}-${fmtNumber(end)}`;
}

function compactLineRanges(ranges: string[]) {
  if (ranges.length <= 2) return ranges.join("、");
  return `${ranges.slice(0, 2).join("、")} 等 ${fmtNumber(ranges.length)} 段`;
}

function uniqueNumbers(values: number[]) {
  return Array.from(new Set(values.filter((value) => Number.isFinite(value) && value > 0))).sort((left, right) => left - right);
}

function compactNumberRanges(values: number[]) {
  const sorted = uniqueNumbers(values);
  if (sorted.length === 0) return "";
  const ranges: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (let index = 1; index < sorted.length; index += 1) {
    const value = sorted[index];
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    ranges.push(start === previous ? fmtNumber(start) : `${fmtNumber(start)}-${fmtNumber(previous)}`);
    start = value;
    previous = value;
  }
  ranges.push(start === previous ? fmtNumber(start) : `${fmtNumber(start)}-${fmtNumber(previous)}`);
  return compactLineRanges(ranges);
}

function hunkLineNumbers(hunks: Record<string, unknown>[], key: "new_line" | "old_line") {
  const numbers: number[] = [];
  hunks.forEach((hunk) => {
    asArray(hunk.lines)
      .map(asRecord)
      .filter(Boolean)
      .forEach((line) => {
        const value = numericValue(line?.[key], 0);
        if (value > 0) numbers.push(value);
      });
  });
  return uniqueNumbers(numbers);
}

function hunkHeaderLineTotal(hunks: Record<string, unknown>[], key: "new_lines" | "old_lines") {
  return hunks.reduce((total, hunk) => total + Math.max(0, numericValue(hunk[key], 0)), 0);
}

function hunkHeaderRanges(hunks: Record<string, unknown>[], startKey: "new_start" | "old_start", countKey: "new_lines" | "old_lines") {
  return hunks
    .map((hunk) => lineRangeText(numericValue(hunk[startKey], 0), numericValue(hunk[countKey], 0)))
    .filter(Boolean);
}

function lineNumbersAreAbsolute(record: Record<string, unknown>) {
  const stats = asRecord(record.line_stats);
  const basis = String(record.line_number_basis || record.lineNumberBasis || stats?.line_number_basis || "").toLowerCase();
  return basis === "absolute" || record.line_numbers_are_absolute === true || record.lineNumbersAreAbsolute === true;
}

function rawDetailLineSummary(change: AiCodeChange, changeRecord: Record<string, unknown>) {
  const added = numericValue(changeRecord.lines_added, change.lines_added);
  const deleted = numericValue(changeRecord.lines_deleted, change.lines_deleted);
  const hunks = asArray(changeRecord.hunks)
    .map(asRecord)
    .filter(Boolean) as Record<string, unknown>[];
  const newLineNumbers = hunkLineNumbers(hunks, "new_line");
  const oldLineNumbers = hunkLineNumbers(hunks, "old_line");
  const newLineTotal = newLineNumbers.length || hunkHeaderLineTotal(hunks, "new_lines");
  const oldLineTotal = oldLineNumbers.length || hunkHeaderLineTotal(hunks, "old_lines");
  const newRangeText = compactNumberRanges(newLineNumbers) || compactLineRanges(hunkHeaderRanges(hunks, "new_start", "new_lines"));
  const oldRangeText = compactNumberRanges(oldLineNumbers) || compactLineRanges(hunkHeaderRanges(hunks, "old_start", "old_lines"));
  const absolute = lineNumbersAreAbsolute(changeRecord);
  const newLineLabel = absolute ? "新文件实际行数" : "新文件采集行数";
  const oldLineLabel = absolute ? "旧文件实际行数" : "旧文件采集行数";
  const lineLabel = absolute ? "实际行号" : "采集行号";
  const parts = [`变更 +${fmtNumber(added)} -${fmtNumber(deleted)}`];
  if (newLineTotal > 0) {
    parts.push(`${newLineLabel} ${fmtNumber(newLineTotal)} 行${newRangeText ? `（${lineLabel} ${newRangeText}）` : ""}`);
  }
  if (oldLineTotal > 0) {
    parts.push(`${oldLineLabel} ${fmtNumber(oldLineTotal)} 行${oldRangeText ? `（${lineLabel} ${oldRangeText}）` : ""}`);
  }
  if (newLineTotal === 0 && oldLineTotal === 0) {
    parts.push(`${absolute ? "实际" : "采集"}新增 ${fmtNumber(added)} 行`);
    if (deleted > 0) parts.push(`${absolute ? "实际" : "采集"}删除 ${fmtNumber(deleted)} 行`);
  }
  return parts.join(" · ");
}

function rawDetailCanRender(changeRecord: Record<string, unknown>) {
  return asArray(changeRecord.hunks).length > 0 || asArray(changeRecord.changes).length > 0;
}

function RawCodeChangeDetail({ change }: { change: AiCodeChange }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<CodeChangeRawDetailResponse | null>(null);

  async function toggleRawDetail() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (detail || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/v1/code-changes/${change.id}/raw-detail`);
      setDetail(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const rawChange = asRecord(detail?.code_change);
  const hunks = asArray(rawChange?.hunks).map(asRecord).filter(Boolean) as Record<string, unknown>[];
  const editorChanges = asArray(rawChange?.changes).map(asRecord).filter(Boolean) as Record<string, unknown>[];
  const renderable = rawChange ? rawDetailCanRender(rawChange) : false;
  const lineSummary = rawChange ? rawDetailLineSummary(change, rawChange) : "";
  const source = detail?.source ? String(detail.source) : "";
  const blobCount = numericValue(detail?.blob_count, 0);
  const defaultAttribution = aiEvidenceDefaultAttribution(change);

  return (
    <div className="raw-detail-panel">
      <button className="btn btn-compact" type="button" onClick={toggleRawDetail} disabled={loading}>
        {loading ? "加载完整详情..." : open ? "收起完整详情" : "查看完整详情"}
      </button>
      {open && (
        <div className="raw-detail-body">
          {error ? (
            <div className="raw-detail-error">完整详情加载失败：{error}</div>
          ) : loading ? (
            <div className="raw-detail-muted">正在从 raw_event_blobs 还原完整代码证据...</div>
          ) : detail && rawChange ? (
            <>
              <div className="raw-detail-meta">
                来源 {source || "stored"} · Blob {fmtNumber(blobCount)} 个 · {lineSummary}
              </div>
              {renderable ? (
                <>
                  {hunks.map((hunk, index) => (
                    <HunkView
                      hunk={hunk}
                      index={index}
                      key={`raw-hunk-${change.id}-${index}`}
                      {...defaultAttribution}
                    />
                  ))}
                  {editorChanges.map((record, index) => (
                    <AddedLinesView
                      changeRecord={record}
                      key={`raw-edit-${change.id}-${index}`}
                      {...defaultAttribution}
                    />
                  ))}
                </>
              ) : (
                <div className="raw-detail-muted">完整详情已还原，但没有可渲染的 hunk / editor delta 行。</div>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

function CodeDiffView({ change }: { change: AiCodeChange }) {
  if (isCommitCodeChange(change)) {
    return <CommitAttributionDiffView change={change} />;
  }
  const raw = codeRaw(change);
  if (raw.line_detail_truncated || raw.line_detail_policy === "summary_only") {
    const summary = asRecord(raw.line_attribution_summary);
    const limit = numericValue(raw.line_detail_limit ?? summary?.full_line_attribution_limit, 5000);
    const totalLines = Math.max(0, numericValue(change.lines_added, 0)) + Math.max(0, numericValue(change.lines_deleted, 0));
    const reason =
      totalLines > limit
        ? `超过 ${fmtNumber(limit)} 行阈值`
        : "详情体积较大";
    return (
      <div className="code-diff">
        <div className="diff-empty">
          这条 AI 会话代码证据因{reason}，行级详情已摘要化。新增 {fmtNumber(change.lines_added)} 行，删除 {fmtNumber(change.lines_deleted)} 行；提交全量 diff 以 commit_snapshot / raw_event_blobs 为准。
        </div>
        <RawCodeChangeDetail change={change} />
      </div>
    );
  }
  const hunks = asArray(raw.hunks).map(asRecord).filter(Boolean) as Record<string, unknown>[];
  const editorChanges = asArray(raw.changes).map(asRecord).filter(Boolean) as Record<string, unknown>[];
  const defaultAttribution = aiEvidenceDefaultAttribution(change);
  if (hunks.length === 0 && editorChanges.length === 0) {
    return <div className="diff-empty">这条变更没有采集到具体代码行，只记录了文件和增删行数</div>;
  }
  return (
    <div className="code-diff">
      {hunks.map((hunk, index) => (
        <HunkView
          hunk={hunk}
          index={index}
          key={`hunk-${index}`}
          {...defaultAttribution}
        />
      ))}
      {editorChanges.map((record, index) => (
        <AddedLinesView changeRecord={record} key={`edit-${index}`} {...defaultAttribution} />
      ))}
    </div>
  );
}

function CodeChangeSummary({ change }: { change: AiCodeChange }) {
  const filePath =
    cleanDisplayPath(change.file_path) ||
    cleanDisplayPath(change.diff_json?.file_path) ||
    "未知文件";
  const lineStats = asRecord(change.diff_json?.line_stats);
  const capturedLines = numericValue(lineStats?.captured_line_count ?? change.diff_json?.captured_line_count);
  const summaryLines = numericValue(lineStats?.summary_total_line_count, change.lines_added + change.lines_deleted);
  const complete = Boolean(lineStats?.line_level_complete ?? change.diff_json?.line_level_complete);
  const truncated = Boolean(lineStats?.diff_truncated ?? change.diff_json?.diff_truncated);
  const hasLineStats = Boolean(lineStats);
  const isCommit = isCommitCodeChange(change);
  const isAiEvidence = isAiEvidenceCodeChange(change);
  const counts = commitAttributionCounts(change, asRecord(change.diff_json) || undefined);
  const hasAiOverallRatio = change.diff_json?.ai_overall_change_ratio !== undefined && change.diff_json?.ai_overall_change_ratio !== null;
  const aiOverallRatio = numericValue(change.diff_json?.ai_overall_change_ratio, 0);
  const matchedEvents = Array.isArray(change.diff_json?.matched_ai_change_event_ids)
    ? change.diff_json?.matched_ai_change_event_ids.length
    : 0;
  return (
    <details className="code-change-details">
      <summary className="turn-step">
        <span className="turn-step-kind">代码</span>
        <span className="turn-step-tool">{change.change_type}</span>
        <span className="turn-step-content">
          {filePath} · 总量 +{change.lines_added} -{change.lines_deleted}
          {isAiEvidence && !isCommit && (
            <small>
              AI 会话代码证据 · 新增行默认视为 AI 生成/编辑 · 最终采纳看 commit 归因
            </small>
          )}
          {isCommit && (
            <small>
              提交归因 AI当前新增 +{fmtNumber(counts.aiAdded)}
              {counts.aiDeleted ? ` · 删除AI来源 -${fmtNumber(counts.aiDeleted)}` : ""}
              {counts.aiModified ? ` · AI来源修改 ${fmtNumber(counts.aiModified)}` : ""}
              {" · "}
              人工当前（未命中 AI 证据） +{fmtNumber(counts.humanCurrentAdded)} -{fmtNumber(counts.humanCurrentDeleted)} 改{fmtNumber(counts.humanCurrentModified)}
              {counts.aiAssistedHumanEditedModified ? ` · AI辅助后人工改写 改${fmtNumber(counts.aiAssistedHumanEditedModified)}` : ""}
              {!counts.aiAssistedHumanEditedModified && counts.aiAssistedHumanEditedAdded ? ` · AI辅助后人工改写 +${fmtNumber(counts.aiAssistedHumanEditedAdded)}` : ""}
              {counts.standaloneAiOriginDeletedByHuman ? ` · 人工删除AI来源 -${fmtNumber(counts.standaloneAiOriginDeletedByHuman)}` : ""}
              {hasAiOverallRatio ? ` · AI 占比 ${(aiOverallRatio * 100).toFixed(1)}%` : ""}
              {matchedEvents ? ` · 命中 ${matchedEvents} 条 AI 证据` : " · 未命中 AI 证据"}
            </small>
          )}
          {hasLineStats && (
            <small>
              行证据 {fmtNumber(capturedLines)}/{fmtNumber(summaryLines)}
              {" · "}
              {complete ? "完整" : "部分"}
              {truncated ? " · 已截断" : ""}
            </small>
          )}
        </span>
      </summary>
      <CodeDiffView change={change} />
    </details>
  );
}

function CodeChangeGroups({ changes, compact = false }: { changes: AiCodeChange[]; compact?: boolean }) {
  const { commitSnapshots, aiEvidenceChanges, otherChanges } = splitCodeChanges(changes);
  if (changes.length === 0) return null;
  return (
    <div className="code-change-groups">
      {commitSnapshots.length > 0 && (
        <details className="code-change-group" open>
          <summary>
            <span>提交归因结果</span>
            <Badge tone="good">{commitSnapshots.length}</Badge>
          </summary>
          <p>最终提交进入 git 的代码归因。指标主视图以这里为准。</p>
          <div className="turn-detail-body">
            {commitSnapshots.map((change) => <CodeChangeSummary change={change} key={`commit-code-${change.id}`} />)}
          </div>
        </details>
      )}

      {aiEvidenceChanges.length > 0 && (
        <details className="code-change-group">
          <summary>
            <span>AI 生成证据</span>
            <Badge tone="blue">{aiEvidenceChanges.length}</Badge>
          </summary>
          <p>插件采集到的 AI 工具生成/编辑证据，用于归因匹配；它不代表最终提交已经采纳。</p>
          <div className="turn-detail-body">
            {aiEvidenceChanges.map((change) => <CodeChangeSummary change={change} key={`ai-evidence-code-${change.id}`} />)}
          </div>
        </details>
      )}

      {otherChanges.length > 0 && (
        <details className="code-change-group" open={!compact}>
          <summary>
            <span>其他代码事件</span>
            <Badge tone="warn">{otherChanges.length}</Badge>
          </summary>
          <p>没有归入提交结果或 Copilot 生成证据的代码事件，通常用于排查采集链路。</p>
          <div className="turn-detail-body">
            {otherChanges.map((change) => <CodeChangeSummary change={change} key={`other-code-${change.id}`} />)}
          </div>
        </details>
      )}
    </div>
  );
}

function CommitAttributionCard({ group, defaultOpen = false }: { group: CommitGroup; defaultOpen?: boolean }) {
  const aiTotal = group.aiCurrentAdded + group.aiCurrentDeleted + group.aiCurrentModified;
  const humanTotal = group.humanCurrentAdded + group.humanCurrentDeleted + group.humanCurrentModified;
  const assistedTotal = group.aiAssistedHumanEditedAdded + group.aiAssistedHumanEditedModified;
  const denominator = aiTotal + humanTotal + assistedTotal + group.aiOriginDeletedByHuman;
  const aiRatio = denominator > 0 ? `${((aiTotal / denominator) * 100).toFixed(1)}%` : "0.0%";
  const pendingTotal = group.pendingAdded + group.pendingDeleted;
  const generatedTotal = group.generatedAdded + group.generatedDeleted;
  return (
    <details className="commit-card" open={defaultOpen}>
      <summary className="commit-card-summary">
        <div className="commit-main">
          <span className="commit-sha">{shortId(group.commitSha, 16)}</span>
          <strong>{group.fileCount} 个文件 · 总量 +{fmtNumber(group.linesAdded)} -{fmtNumber(group.linesDeleted)} 改{fmtNumber(group.linesModified)}</strong>
          <span>
            {fmtTime(group.occurredAt)}
            {group.branch ? ` · ${group.branch}` : ""}
            {group.submitters.length ? ` · 提交人 ${group.submitters.join(" / ")}` : ""}
            {group.sessionIds.length ? ` · 来源 ${group.sessionIds.length} 个会话` : ""}
          </span>
        </div>
        <div className="commit-summary-metrics">
          <span className="commit-pill ai">AI 当前 +{fmtNumber(group.aiCurrentAdded)} -{fmtNumber(group.aiCurrentDeleted)} 改{fmtNumber(group.aiCurrentModified)}</span>
          <span className="commit-pill human">人工当前（未命中 AI 证据） +{fmtNumber(group.humanCurrentAdded)} -{fmtNumber(group.humanCurrentDeleted)} 改{fmtNumber(group.humanCurrentModified)}</span>
          <span className="commit-pill assisted">AI 辅助后人工改写 {fmtNumber(assistedTotal)}</span>
          <span className="commit-pill">AI 占比 {aiRatio}</span>
          {pendingTotal > 0 && <span className="commit-pill blob">归因中 +{fmtNumber(group.pendingAdded)} -{fmtNumber(group.pendingDeleted)}</span>}
          {generatedTotal > 0 && <span className="commit-pill blob">生成物已排除 +{fmtNumber(group.generatedAdded)} -{fmtNumber(group.generatedDeleted)}</span>}
          {group.matchedEvidenceCount > 0 && <span className="commit-pill">命中 {group.matchedEvidenceCount} 条 AI 证据</span>}
          {group.hasBlobOrTruncated && <span className="commit-pill blob">有大文件 blob</span>}
        </div>
      </summary>
      <div className="commit-card-body">
        <div className="commit-explain">
          <strong>归因口径</strong>
          <span>这里以提交为主维度。会话只作为 AI 证据来源追踪，不决定主列表范围。</span>
        </div>
        <div className="commit-file-grid">
          {group.files.map((change) => {
            const counts = commitAttributionCounts(change, asRecord(change.diff_json) || undefined);
            const filePath = cleanDisplayPath(change.file_path) || cleanDisplayPath(change.diff_json?.file_path) || "未知文件";
            return (
              <div className="commit-file-row" key={`commit-file-${change.id}`}>
                <strong>{filePath}</strong>
                <span>总量 +{fmtNumber(change.lines_added)} -{fmtNumber(change.lines_deleted)}</span>
                {counts.attributionStatus === "pending" ? (
                  <span>归因中，不计入 AI/人工占比</span>
                ) : counts.generated ? (
                  <span>生成物已排除，不计入 AI/人工占比</span>
                ) : (
                  <>
                    <span>AI 当前 +{fmtNumber(counts.aiAdded)} -{fmtNumber(counts.aiDeleted)} 改{fmtNumber(counts.aiModified)}</span>
                    <span>人工当前（未命中 AI 证据） +{fmtNumber(counts.humanCurrentAdded)} -{fmtNumber(counts.humanCurrentDeleted)} 改{fmtNumber(counts.humanCurrentModified)}</span>
                    {(counts.aiAssistedHumanEditedAdded || counts.aiAssistedHumanEditedModified) ? (
                      <span>AI 辅助后人工改写 +{fmtNumber(counts.aiAssistedHumanEditedAdded)} 改{fmtNumber(counts.aiAssistedHumanEditedModified)}</span>
                    ) : <span>AI 辅助后人工改写 0</span>}
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div className="turn-detail-body">
          {group.files.map((change) => <CodeChangeSummary change={change} key={`commit-detail-${change.id}`} />)}
        </div>
      </div>
    </details>
  );
}

function SpecAccessSummary({ access }: { access: AiSpecAccess }) {
  return (
    <div className="turn-step">
      <span className="turn-step-kind">规范</span>
      <span className="turn-step-content">{access.spec_scope} · {access.doc_path || "未知文档"}</span>
      <Badge tone={confidenceTone(access.confidence)}>{access.confidence}</Badge>
    </div>
  );
}

function RequestUsageLine({ usage }: { usage: AiRequestUsage }) {
  if (!hasRequestUsage(usage)) return null;
  return (
    <div className="request-usage-line">
      {usage.model && <Badge tone="blue">{usage.model}</Badge>}
      {(usage.prompt_tokens ?? 0) > 0 && <span>输入 Token {fmtNumber(usage.prompt_tokens)}</span>}
      {(usage.output_tokens ?? 0) > 0 && <span>输出 Token {fmtNumber(usage.output_tokens)}</span>}
      {(usage.completion_tokens ?? 0) > 0 && <span>补全 Token {fmtNumber(usage.completion_tokens)}</span>}
      {(usage.elapsed_ms ?? 0) > 0 && <span>耗时 {fmtDuration(usage.elapsed_ms)}</span>}
      {(usage.copilot_credits ?? 0) > 0 && <span>Copilot 消耗 {fmtCredits(usage.copilot_credits)}</span>}
    </div>
  );
}

function SessionUsageCards({ detail }: { detail: AiSessionDetail }) {
  const totals = detail.usage_totals;
  const cards: Array<{ label: string; value: string }> = [];
  if (detail.model) cards.push({ label: "模型", value: detail.model });
  if ((totals?.prompt_tokens ?? 0) > 0) cards.push({ label: "输入 Token", value: fmtNumber(totals?.prompt_tokens) });
  if ((totals?.output_tokens ?? 0) > 0) cards.push({ label: "输出 Token", value: fmtNumber(totals?.output_tokens) });
  if ((totals?.completion_tokens ?? 0) > 0) cards.push({ label: "补全 Token", value: fmtNumber(totals?.completion_tokens) });
  if ((totals?.elapsed_ms ?? 0) > 0) cards.push({ label: "耗时", value: fmtDuration(totals?.elapsed_ms) });
  if ((totals?.copilot_credits ?? 0) > 0) cards.push({ label: "Copilot 消耗", value: fmtCredits(totals?.copilot_credits) });
  if (cards.length === 0) return null;
  return (
    <div className="session-usage">
      {cards.map((card) => (
        <div key={card.label}><span>{card.label}</span><strong>{card.value}</strong></div>
      ))}
    </div>
  );
}

function SessionTimeline({ detail }: { detail: AiSessionDetail | null }) {
  if (!detail) {
    return <div className="empty">选择一个会话查看完整对话</div>;
  }
  const unassignedProcessSteps = detail.unassigned_process_steps || [];
  const unassignedCodeChanges = sessionEvidenceCodeChanges(detail.unassigned_code_changes || []);
  const unassignedSpecAccesses = detail.unassigned_spec_accesses || [];
  const hasUnassignedActivity = unassignedProcessSteps.length > 0 || unassignedCodeChanges.length > 0 || unassignedSpecAccesses.length > 0;
  const turnsWithSessionEvidence = detail.turns.map((turn) => ({
    ...turn,
    code_changes: sessionEvidenceCodeChanges(turn.code_changes || []),
  }));
  if (!detail.turns.length && !hasUnassignedActivity) {
    return <div className="empty">这个会话还没有解析出的对话轮次</div>;
  }
  return (
    <div className="session-detail">
      <div className="session-summary">
        <div>
          <h3>{detail.title || `${detail.tool} 会话`}</h3>
          <p>
            {detail.turns.length} 轮对话
            {unassignedCodeChanges.length > 0 && ` · ${unassignedCodeChanges.length} 个未归属代码变更`}
            {unassignedProcessSteps.length > 0 && ` · ${unassignedProcessSteps.length} 个未归属过程`}
            {" · "}最近活动 {fmtTime(detail.last_activity_at)}
          </p>
        </div>
        <Badge tone={detail.status === "completed" ? "good" : "blue"}>{statusLabel(detail.status)}</Badge>
      </div>
      {hasSessionUsage(detail) && <SessionUsageCards detail={detail} />}
      {Object.keys(detail.models_used || {}).length > 0 && (
        <div className="session-models">
          {Object.entries(detail.models_used).map(([model, count]) => (
            <Badge key={model} tone="blue">{model} · {count} 次</Badge>
          ))}
        </div>
      )}

      <div className="turn-list">
        {turnsWithSessionEvidence.map((turn) => {
          const orderedMessages = [...turn.user_messages, ...turn.assistant_messages]
            .sort((left, right) => {
              const leftIndex = Number.isFinite(left.message_index) ? left.message_index : left.id;
              const rightIndex = Number.isFinite(right.message_index) ? right.message_index : right.id;
              return leftIndex - rightIndex || left.id - right.id;
            });
          return (
            <article className="turn-card" key={turn.id}>
              <div className="turn-head">
                <div>
                  <span className="turn-index">第 {turn.turn_index} 轮</span>
                  <span className="turn-time">{fmtTime(turn.created_at)}</span>
                </div>
                <Badge tone={turn.status === "completed" ? "good" : "warn"}>{statusLabel(turn.status)}</Badge>
              </div>
              {turn.request_usage && <RequestUsageLine usage={turn.request_usage} />}

              {orderedMessages.map((message) => (
                <TurnMessageBlock
                  message={message}
                  role={message.role === "assistant" ? "assistant" : "user"}
                  label={message.role === "assistant" ? "AI" : "用户"}
                  key={message.id}
                />
              ))}
              <TurnActivityDetails
                steps={turn.process_steps}
                codeChanges={turn.code_changes}
                specAccesses={turn.spec_accesses}
              />
            </article>
          );
        })}
        {hasUnassignedActivity && (
          <article className="turn-card">
            <div className="turn-head">
              <div>
                <span className="turn-index">未归属动作</span>
                <span className="turn-time">没有匹配到具体对话轮次</span>
              </div>
              <Badge tone="warn">未归属</Badge>
            </div>
            <TurnActivityDetails
              steps={unassignedProcessSteps}
              codeChanges={unassignedCodeChanges}
              specAccesses={unassignedSpecAccesses}
              defaultOpen={detail.turns.length === 0}
            />
          </article>
        )}
      </div>
    </div>
  );
}

function OverviewContent({
  summary,
  sessions,
  pluginClients,
  activePluginCount,
  turnSnapshotCount,
  aiSessionCount,
  avgLatencyMs,
}: {
  summary: MetricsResponse["summary"] | undefined;
  sessions: AiSessionSummary[];
  pluginClients: PluginClient[];
  activePluginCount: number;
  turnSnapshotCount: number;
  aiSessionCount: number;
  avgLatencyMs: number;
}) {
  return (
    <div className="view-stack">
      <section className="view-hero">
        <div>
          <span className="eyebrow">概览</span>
          <h2>采集状态总览</h2>
        <p>先看系统是否在稳定采集，再进入具体会话或指标细节。</p>
        </div>
        <Badge tone={activePluginCount > 0 ? "good" : "warn"}>{activePluginCount > 0 ? "采集中" : "等待中"}</Badge>
      </section>

      <div className="kpi-grid view-kpis">
        <SummaryCard label="单轮快照" value={fmtNumber(turnSnapshotCount)} hint={`${fmtNumber(summary?.message_count)} 条消息`} tone="primary" />
        <SummaryCard label="AI 会话" value={fmtNumber(aiSessionCount)} hint={`${fmtNumber(summary?.task_count)} 个任务`} />
        <SummaryCard label="活跃采集端" value={fmtNumber(activePluginCount)} hint={`${groupPluginClients(pluginClients).length} 个注册采集端`} tone="success" />
        <SummaryCard label="平均耗时" value={fmtDuration(avgLatencyMs)} hint={`${summary?.request_usage_count ?? 0} 次请求`} />
      </div>

      <div className="overview-grid">
        <ModuleSection title="最近会话" description="最近进入采集链路的 AI 会话">
          <div className="compact-list">
            {sessions.length === 0 ? <div className="empty compact">暂无会话数据</div> : sessions.slice(0, 5).map((session) => (
              <div className="compact-row" key={session.session_id}>
                <div>
                  <strong>{session.title || `${session.tool} 会话`}</strong>
                  <span>{session.tool} · {session.model || "未知模型"}</span>
                </div>
                <Badge tone={statusTone(session.status)}>{statusLabel(session.status)}</Badge>
              </div>
            ))}
          </div>
        </ModuleSection>

        <ModuleSection title="采集摘要" description="默认只展示摘要，排障数据放入对应模块">
          <div className="metric-strip tight">
            <SummaryCard label="原始事件" value={summary?.event_count ?? 0} />
            <SummaryCard label="Token / Copilot 消耗" value={fmtNumber(totalTokens(summary))} hint={fmtCredits(summary?.copilot_credits_total)} />
            <SummaryCard label="规范访问" value={summary?.spec_access_event_count ?? 0} />
            <SummaryCard label="代码快照" value={summary?.code_snapshot_count ?? 0} />
          </div>
        </ModuleSection>
      </div>
    </div>
  );
}

function SessionWorkspace({
  sessions,
  selectedSession,
  selectedUser,
  sessionDetail,
  loadSessionDetail,
}: {
  sessions: AiSessionSummary[];
  selectedSession: string;
  selectedUser: string;
  sessionDetail: AiSessionDetail | null;
  loadSessionDetail: (sessionId: string) => Promise<void>;
}) {
  return (
    <div className="session-workspace">
      <section className="workspace-list">
        <div className="workspace-section-head">
          <div>
          <h2>会话证据</h2>
          <p>{selectedUser ? selectedUser : "全部用户"} 的最近 AI 会话证据链</p>
          </div>
          <Badge>{sessions.length}</Badge>
        </div>
        <div className="workspace-list-body">
          {sessions.length === 0 ? (
            <div className="empty">暂无会话数据</div>
          ) : sessions.map(session => (
            <button
              key={session.session_id}
              className={`task-item ${selectedSession === session.session_id ? "active" : ""}`}
              onClick={() => loadSessionDetail(session.session_id)}
            >
              <div className="session-item-top">
                <span className="task-tool">{session.tool}</span>
                <Badge tone={statusTone(session.status)}>{statusLabel(session.status)}</Badge>
              </div>
              <span className="session-title">{session.title || `${session.tool} 会话`}</span>
              <span className="session-meta">
                {identityLabel(session) && !selectedUser ? `${identityLabel(session)} · ` : ""}
                {session.model || "未知模型"}
              </span>
              <span className="session-footer">
                <span className="task-id">{shortId(session.session_id, 18)}</span>
                <span className="task-count">{fmtTime(session.last_activity_at)}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="workspace-detail">
        <div className="workspace-section-head">
          <div>
          <h2>证据时间线</h2>
          <p>点击指标排障时，用这里核对用户问题、AI 回答、工具调用和 usage</p>
          </div>
          {selectedSession && <span className="selected-session-id">{shortId(selectedSession, 24)}</span>}
        </div>
        <div className="workspace-detail-body">
          <SessionTimeline detail={sessionDetail} />
        </div>
      </section>
    </div>
  );
}

function MetricsContent({
  summary,
  metrics,
  toolCallCount,
  activePluginCount,
  turnSnapshotCount,
  aiSessionCount,
  avgLatencyMs,
}: {
  summary: MetricsResponse["summary"] | undefined;
  metrics: MetricsResponse | null;
  toolCallCount: number;
  activePluginCount: number;
  turnSnapshotCount: number;
  aiSessionCount: number;
  avgLatencyMs: number;
}) {
  const metricCount = allMetrics(metrics).length;
  return (
    <div className="view-stack">
      <section className="view-hero">
        <div>
          <span className="eyebrow">指标</span>
          <h2>指标总览</h2>
          <p>监控系统默认看指标。这里展示后端返回的全部指标、分类、分子分母和可信度。</p>
        </div>
        <Badge tone="blue">{metricCount} 个指标</Badge>
      </section>

      <ModuleSection title="监控摘要" description="先判断采集规模、链路活跃、成本和响应情况">
        <div className="metric-strip">
          <SummaryCard label="单轮快照" value={fmtNumber(turnSnapshotCount)} hint={`${fmtNumber(summary?.message_count)} 条消息`} tone="primary" />
          <SummaryCard label="AI 会话" value={fmtNumber(aiSessionCount)} hint={`${fmtNumber(summary?.task_count)} 个任务`} />
          <SummaryCard label="活跃采集端" value={fmtNumber(activePluginCount)} hint="30 分钟内活跃" tone="success" />
          <SummaryCard label="平均耗时" value={fmtDuration(avgLatencyMs)} hint={`${summary?.request_usage_count ?? 0} 次请求`} />
          <SummaryCard label="工具调用" value={fmtNumber(toolCallCount)} hint="当前会话已归属工具调用" />
          <SummaryCard
            label="Token / Copilot 消耗"
            value={fmtNumber(totalTokens(summary))}
            hint={fmtCredits(summary?.copilot_credits_total)}
            tone="warning"
            className="card-wide card-long-number"
          />
          <SummaryCard label="原始事件" value={summary?.event_count ?? 0} />
          <SummaryCard label="规范访问" value={summary?.spec_access_event_count ?? 0} />
        </div>
      </ModuleSection>

      {metrics && metrics.categories.map(cat => (
        <ModuleSection key={cat.key} title={cat.title} description={`${cat.metrics.length} 个指标`}>
          <div className="metrics-grid">
            {cat.metrics.map(metric => (
              <div key={metric.id} className="metric-group">
                <div className="metric-row">
                  <span className="metric-name">{metric.name}</span>
                  <span className="metric-value">{fmtValue(metric)}</span>
                </div>
                <div className="metric-row metric-row-sub">
                  <span className="metric-sub">#{metric.id} · {metric.confidence}</span>
                  <span className="metric-sub">{metric.numerator ?? "—"} / {metric.denominator ?? "—"}</span>
                </div>
                <div className="metric-method">{metric.method}</div>
              </div>
            ))}
          </div>
        </ModuleSection>
      ))}
    </div>
  );
}

function KnowledgeContent({
  summary,
  metrics,
  sessionDetail,
}: {
  summary: MetricsResponse["summary"] | undefined;
  metrics: MetricsResponse | null;
  sessionDetail: AiSessionDetail | null;
}) {
  const projectKnowledgeCategory = metrics?.categories.find((category) => category.key === "project_knowledge_usage");
  const projectMetrics = projectKnowledgeCategory?.metrics ?? [];
  const projectDetails = asRecord(projectKnowledgeCategory?.details);
  const projectDocs = asArray(projectDetails?.project_doc_usage)
    .map(asRecord)
    .filter(Boolean)
    .map((doc) => ({
      doc_path: String(doc?.doc_path || ""),
      file_name: doc?.file_name ? String(doc.file_name) : null,
      read_count: numericValue(doc?.read_count, 0),
      edit_count: numericValue(doc?.edit_count, 0),
      access_count: numericValue(doc?.access_count, 0),
      conversion_rate: doc?.conversion_rate === null || doc?.conversion_rate === undefined ? null : numericValue(doc.conversion_rate, 0),
      efficiency_bucket: doc?.efficiency_bucket ? String(doc.efficiency_bucket) : null,
      related_turn_count: numericValue(doc?.related_turn_count, 0),
      related_ai_evidence_event_count: numericValue(doc?.related_ai_evidence_event_count, 0),
      related_ai_generated_added_lines: numericValue(doc?.related_ai_generated_added_lines, 0),
      related_ai_accepted_added_lines: numericValue(doc?.related_ai_accepted_added_lines, 0),
      related_adoption_rate: doc?.related_adoption_rate === null || doc?.related_adoption_rate === undefined ? null : numericValue(doc.related_adoption_rate, 0),
      related_commit_count: numericValue(doc?.related_commit_count, 0),
      related_unallocated_accepted_lines: numericValue(doc?.related_unallocated_accepted_lines, 0),
      related_efficiency_bucket: doc?.related_efficiency_bucket ? String(doc.related_efficiency_bucket) : null,
      related_adoption_note: doc?.related_adoption_note ? String(doc.related_adoption_note) : null,
      content_hash: doc?.content_hash ? String(doc.content_hash) : null,
      last_seen_at: doc?.last_seen_at ? String(doc.last_seen_at) : null,
      edit_locations: asArray(doc?.edit_locations).map(asRecord).filter(Boolean) as Record<string, unknown>[],
    }))
    .filter((doc) => doc.doc_path);
  const sessionSpecDocs = Array.from(
    (sessionDetail?.turns || []).reduce((map, turn) => {
      for (const access of turn.spec_accesses || []) {
        const docs = Array.isArray(access.matched_docs) && access.matched_docs.length > 0
          ? access.matched_docs
          : access.doc_path
            ? [access.doc_path]
            : [];
        const accessType = String(access.access_type || "access").toLowerCase();
        for (const docPath of docs) {
          if (!docPath || docPath === "openspec/specs") continue;
          const key = `${turn.turn_index}:${accessType}:${docPath}`;
          const existing = map.get(docPath) || { doc_path: docPath, read_count: 0, edit_count: 0, access_count: 0, seen: new Set<string>() };
          if (existing.seen.has(key)) continue;
          existing.seen.add(key);
          existing.access_count += 1;
          if (accessType === "read") existing.read_count += 1;
          else if (accessType === "edit") existing.edit_count += 1;
          map.set(docPath, existing);
        }
      }
      return map;
    }, new Map<string, { doc_path: string; read_count: number; edit_count: number; access_count: number; seen: Set<string> }>())
      .values()
  ).sort((left, right) => (right.read_count + right.edit_count) - (left.read_count + left.edit_count) || left.doc_path.localeCompare(right.doc_path));
  return (
    <div className="view-stack">
      <section className="view-hero">
        <div>
          <span className="eyebrow">知识库</span>
          <h2>知识库使用覆盖</h2>
          <p>关注 AI 是否读取规范、是否命中 catalog，以及 fallback 是否过多。</p>
        </div>
      </section>

      <div className="metric-strip">
        <SummaryCard label="知识库命中次数" value={summary?.project_spec_access_count ?? summary?.spec_access_event_count ?? 0} />
        <SummaryCard label="读取次数" value={summary?.project_spec_read_count ?? 0} />
        <SummaryCard label="命中文档次数" value={summary?.project_spec_doc_hit_count ?? 0} />
        <SummaryCard label="命中文档数" value={summary?.project_spec_unique_doc_count ?? 0} />
        <SummaryCard label="访问到修改转化" value={summary?.project_spec_conversion_rate == null ? "—" : `${(summary.project_spec_conversion_rate * 100).toFixed(1)}%`} />
        <SummaryCard label="高频低转化文档" value={summary?.project_spec_low_conversion_doc_count ?? 0} tone="warning" />
        <SummaryCard label="有关联采纳文档" value={summary?.project_spec_related_adoption_doc_count ?? 0} hint="读文档后同轮 AI 生成代码，并在 commit 中命中" />
        <SummaryCard label="高频低关联采纳" value={summary?.project_spec_low_related_adoption_doc_count ?? 0} tone="warning" hint="读得多，但关联采纳率偏低" />
      </div>

      <ModuleSection title="项目知识库命中" description="区分访问动作次数和文档命中次数：一次批量读取算一次知识库命中，但会累加多个命中文档">
        {projectMetrics.length === 0 ? (
          <div className="empty compact">暂无项目知识库命中指标</div>
        ) : (
          <div className="metrics-grid">
            {projectMetrics.map(metric => (
              <div key={metric.id} className="metric-group">
                <div className="metric-row">
                  <span className="metric-name">{metric.name}</span>
                  <span className="metric-value">{fmtValue(metric)}</span>
                </div>
                <div className="metric-row metric-row-sub">
                  <span className="metric-sub">{metric.category}</span>
                  <span className="metric-sub">{metric.numerator ?? "—"} / {metric.denominator ?? "—"}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </ModuleSection>

      <ModuleSection title="知识库文档明细" description="读取/文档修改是文档自身指标；关联 AI 生成/采纳是“读过该文档的同一轮对话”后续代码采纳表现，不能跨文档累加">
        {projectDocs.length === 0 ? (
          <div className="empty compact">暂无知识库文档清单。请 reload VS Code 后重新触发一次 Copilot 对话。</div>
        ) : (
          <div className="spec-doc-table">
            <div className="spec-doc-row spec-doc-head">
              <span>文档</span>
              <span>读取</span>
              <span>文档修改</span>
              <span>转化</span>
              <span>关联AI生成</span>
              <span>关联AI采纳</span>
              <span>关联采纳率</span>
              <span>知识库诊断</span>
              <span>最近修改位置</span>
            </div>
            {projectDocs.map((doc) => {
              const locations = Array.isArray(doc.edit_locations) ? doc.edit_locations : [];
              const firstLocation = asRecord(locations[0]);
              const relatedRate = doc.related_adoption_rate == null ? "—" : `${(doc.related_adoption_rate * 100).toFixed(1)}%`;
              const relatedBucket = doc.related_efficiency_bucket || "暂无关联";
              const relatedTone =
                relatedBucket === "高频低关联采纳"
                  ? "warn"
                  : relatedBucket === "高频高关联采纳"
                    ? "good"
                    : "default";
              return (
                <details className="spec-doc-item" key={doc.doc_path}>
                  <summary>
                    <span className="spec-doc-title">
                      <strong>{doc.file_name || doc.doc_path.split("/").pop()}</strong>
                      <small>{doc.doc_path}</small>
                    </span>
                    <span>{fmtNumber(doc.read_count || 0)} 次</span>
                    <span>{fmtNumber(doc.edit_count || 0)} 次</span>
                    <span>{doc.conversion_rate == null ? "—" : `${(doc.conversion_rate * 100).toFixed(1)}%`}{doc.efficiency_bucket ? ` · ${doc.efficiency_bucket}` : ""}</span>
                    <span>{fmtNumber(doc.related_ai_generated_added_lines)}</span>
                    <span>
                      {fmtNumber(doc.related_ai_accepted_added_lines)}
                      {doc.related_unallocated_accepted_lines > 0 && (
                        <small className="inline-muted"> +{fmtNumber(doc.related_unallocated_accepted_lines)} 未分配</small>
                      )}
                    </span>
                    <span>{relatedRate}</span>
                    <span><Badge tone={relatedTone}>{relatedBucket === "高频低关联采纳" ? "优先优化" : relatedBucket}</Badge></span>
                    <span>{firstLocation?.summary ? String(firstLocation.summary) : "暂无修改"}</span>
                  </summary>
                  <div className="spec-doc-detail">
                    {(doc.last_seen_at || doc.content_hash) && (
                      <div className="spec-doc-meta">
                        {doc.last_seen_at && <span>最后扫描 {fmtTime(doc.last_seen_at)}</span>}
                        {doc.content_hash && <span>SHA {doc.content_hash.slice(0, 12)}…</span>}
                      </div>
                    )}
                    <div className="spec-related-note">
                      <strong>关联采纳</strong>
                      <span>关联轮次 {fmtNumber(doc.related_turn_count)} · AI 证据 {fmtNumber(doc.related_ai_evidence_event_count)} · Commit {fmtNumber(doc.related_commit_count)}</span>
                      <span>{doc.related_adoption_note || "关联分析，不代表文档直接贡献代码。"}</span>
                    </div>
                    <div className="spec-related-note spec-edit-note">
                      <strong>文档修改</strong>
                      <span>读取 {fmtNumber(doc.read_count)} 次 · 修改 {fmtNumber(doc.edit_count)} 次 · 转化 {doc.conversion_rate == null ? "—" : `${(doc.conversion_rate * 100).toFixed(1)}%`}</span>
                      <span>这里统计的是这个 specs 文档本身被 AI 编辑的位置；和“关联 AI 生成/采纳”不是同一个口径。</span>
                    </div>
                    {locations.length === 0 ? (
                      <div className="empty compact">这个文档暂无可展示的修改位置</div>
                    ) : (
                      <div className="spec-location-list">
                        {locations.map((location, index) => (
                          <div className="spec-location" key={`${doc.doc_path}-${index}`}>
                            <span className="spec-location-main">{String(location.summary || "修改位置未解析")}</span>
                            <span className="spec-location-meta">{String(location.snapshot_kind || "code_change")} · {fmtTime(String(location.occurred_at || ""))}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </ModuleSection>

      <ModuleSection title="当前会话规范访问" description="按文档聚合当前选中会话里的读取/修改，避免同一文档重复刷屏">
        {sessionSpecDocs.length === 0 ? (
          <div className="empty compact">当前会话暂无规范访问记录</div>
        ) : (
          <div className="session-spec-list">
            {sessionSpecDocs.map((doc) => (
              <div className="session-spec-row" key={doc.doc_path}>
                <span className="session-spec-path">{doc.doc_path}</span>
                <span>读取 {fmtNumber(doc.read_count)}</span>
                <span>修改 {fmtNumber(doc.edit_count)}</span>
              </div>
            ))}
          </div>
        )}
      </ModuleSection>
    </div>
  );
}

function CodeAttributionContent({
  summary,
  metrics,
  codeChanges,
}: {
  summary: MetricsResponse["summary"] | undefined;
  metrics: MetricsResponse | null;
  codeChanges: AiCodeChange[];
}) {
  const commitGroups = groupCommitChanges(codeChanges);
  const commitTotals = sumCommitGroups(commitGroups);
  const attributionMetrics = metricsByIds(metrics, [18, 21, 22, 28, 29, 30, 31, 32, 23, 24, 25, 26, 27, 35, 36, 37, 38]);
  const currentContribution = commitTotals.aiCurrentAdded + commitTotals.aiCurrentDeleted + commitTotals.aiCurrentModified;
  const humanContribution = commitTotals.humanCurrentAdded + commitTotals.humanCurrentDeleted + commitTotals.humanCurrentModified;
  const assistedContribution = commitTotals.aiAssistedHumanEditedAdded + commitTotals.aiAssistedHumanEditedModified;
  const contributionDenominator = currentContribution + humanContribution + assistedContribution + commitTotals.aiOriginDeletedByHuman;
  const aiRatio = contributionDenominator > 0 ? `${((currentContribution / contributionDenominator) * 100).toFixed(1)}%` : "0.0%";
  return (
    <div className="view-stack">
      <section className="view-hero">
        <div>
          <span className="eyebrow">代码归因</span>
          <h2>代码归因</h2>
          <p>这里按用户 / workspace 的全局提交归因展示，不再依赖当前选中的会话。</p>
        </div>
      </section>

      <div className="metric-strip">
        <SummaryCard label="代码变更事件" value={summary?.code_snapshot_count ?? 0} />
        <SummaryCard label="Commit 数" value={fmtNumber(commitGroups.length)} hint={`${fmtNumber(commitTotals.files)} 个文件`} />
        <AttributionSummaryCard
          label="AI 当前贡献"
          note="已命中 AI 证据"
          tone="primary"
          parts={[
            { label: "新增", value: `+${fmtNumber(commitTotals.aiCurrentAdded)}`, tone: "add" },
            { label: "删除", value: `-${fmtNumber(commitTotals.aiCurrentDeleted)}`, tone: "remove" },
            { label: "改写", value: fmtNumber(commitTotals.aiCurrentModified), tone: "edit" },
          ]}
        />
        <AttributionSummaryCard
          label="人工当前"
          note="未命中 AI 证据"
          parts={[
            { label: "新增", value: `+${fmtNumber(commitTotals.humanCurrentAdded)}`, tone: "add" },
            { label: "删除", value: `-${fmtNumber(commitTotals.humanCurrentDeleted)}`, tone: "remove" },
            { label: "改写", value: fmtNumber(commitTotals.humanCurrentModified), tone: "edit" },
          ]}
        />
        <AttributionSummaryCard
          label="AI 辅助后人工改写"
          note="AI 生成后被人工调整"
          total={fmtNumber(assistedContribution)}
          hint={`新增 +${fmtNumber(commitTotals.aiAssistedHumanEditedAdded)} · 改写 ${fmtNumber(commitTotals.aiAssistedHumanEditedModified)}`}
          tone="warning"
        />
        <SummaryCard label="人工删除 AI 来源" value={fmtNumber(commitTotals.aiOriginDeletedByHuman)} />
        <SummaryCard label="AI 代码占比" value={aiRatio} hint={`${fmtNumber(commitTotals.evidence)} 条 AI 证据命中`} tone="success" />
      </div>

      <ModuleSection title="全局 Commit 归因列表" description="按 commit 聚合展示最终进入 git 的代码贡献；会话只作为证据来源追踪。">
        {commitGroups.length === 0 ? (
          <div className="empty compact">暂无 commit_snapshot 归因数据</div>
        ) : (
          <div className="commit-list">
            {commitGroups.map((group, index) => (
              <CommitAttributionCard group={group} defaultOpen={index === 0} key={group.key} />
            ))}
          </div>
        )}
      </ModuleSection>

      <ModuleSection title="归因与成本指标" description="后端定义的 commit / push / PR 归因指标，以及从文章借鉴的提交采纳和 Token 成本指标。">
        {attributionMetrics.length === 0 ? (
          <div className="empty compact">暂无代码归因指标</div>
        ) : (
          <div className="metrics-grid">
            {attributionMetrics.map(metric => (
              <div key={metric.id} className="metric-group">
                <div className="metric-row">
                  <span className="metric-name">{metric.name}</span>
                  <span className="metric-value">{fmtValue(metric)}</span>
                </div>
                <div className="metric-row metric-row-sub">
                  <span className="metric-sub">{metric.category}</span>
                  <span className="metric-sub">{metric.numerator ?? "—"} / {metric.denominator ?? "—"}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </ModuleSection>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────

export default function App() {
  const [sessions, setSessions] = useState<AiSessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<string>("");
  const [sessionDetail, setSessionDetail] = useState<AiSessionDetail | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [globalCodeChanges, setGlobalCodeChanges] = useState<AiCodeChange[]>([]);
  const [pluginClients, setPluginClients] = useState<PluginClient[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [selectedUser, setSelectedUser] = useState<string>("");
  const [activeView, setActiveView] = useState<DashboardView>("metrics");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>("");

  async function loadUsers() {
    const res = await apiFetch("/api/v1/users");
    setUsers(await res.json());
  }

  async function loadSessions(username = "") {
    const qs = username ? `?username=${encodeURIComponent(username)}` : "";
    const res = await apiFetch(`/api/v1/sessions/recent${qs}`);
    const nextSessions: AiSessionSummary[] = await res.json();
    setSessions(nextSessions);
    if (!nextSessions.length) {
      setSelectedSession("");
      setSessionDetail(null);
      return;
    }
    if (nextSessions[0] && (!selectedSession || !nextSessions.some(session => session.session_id === selectedSession))) {
      await loadSessionDetail(nextSessions[0].session_id);
    }
  }

  async function loadMetrics(username = "") {
    const qs = username ? `?username=${encodeURIComponent(username)}` : "";
    const res = await apiFetch(`/api/v1/metrics/knowledge${qs}`);
    setMetrics(await res.json());
  }

  async function loadGlobalCodeChanges(username = "") {
    const qs = username ? `&username=${encodeURIComponent(username)}` : "";
    const res = await apiFetch(`/api/v1/code-changes?kind=commit&limit=500&summary=true${qs}`);
    const body: CodeChangesResponse = await res.json();
    setGlobalCodeChanges(body.code_changes || []);
  }

  async function loadRuntime() {
    try {
      const res = await apiFetch("/api/v1/plugins");
      setPluginClients(await res.json());
    } catch (error) {
      console.error(error);
      setPluginClients([]);
    }
  }

  async function loadSessionDetail(sessionId: string) {
    setSelectedSession(sessionId);
    const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/detail`);
    setSessionDetail(await res.json());
  }

  async function refresh() {
    setLoading(true);
    setLoadError("");
    try {
      await Promise.all([loadUsers(), loadSessions(selectedUser), loadMetrics(selectedUser), loadGlobalCodeChanges(selectedUser), loadRuntime()]);
    } catch (error) {
      console.error(error);
      setLoadError(`无法连接 collector：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function handleUserChange(u: string) {
    setSelectedUser(u);
    setSelectedSession("");
    setSessionDetail(null);
    setLoadError("");
    Promise.all([loadSessions(u), loadMetrics(u), loadGlobalCodeChanges(u), loadRuntime()]).catch((error) => {
      console.error(error);
      setLoadError(`无法连接 collector：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  const summary = metrics?.summary;
  const pluginClientGroups = groupPluginClients(pluginClients);
  const activePluginCount = pluginClientGroups.filter((group) => minutesSince(group.last_seen_at) <= 30).length;
  const turnSnapshotCount = summary?.turn_snapshot_count ?? summary?.turn_count ?? summary?.conversation_snapshot_count ?? 0;
  const aiSessionCount = summary?.session_count ?? sessions.length;
  const toolCallCount = countToolSteps(sessionDetail);
  const avgLatencyMs = averageLatency(summary);
  const navItems: Array<{ key: DashboardView; label: string; description: string; count?: number }> = [
    { key: "metrics", label: "指标总览", description: "全部监控指标", count: allMetrics(metrics).length },
    { key: "knowledge", label: "知识库指标", description: "覆盖/合规/命中", count: summary?.spec_access_event_count ?? 0 },
    { key: "code", label: "代码归因指标", description: "采纳与提交", count: summary?.code_snapshot_count ?? 0 },
    { key: "sessions", label: "会话证据", description: "对话和工具链路", count: sessions.length },
  ];

  function renderActiveView() {
    if (activeView === "metrics") {
      return (
        <MetricsContent
          summary={summary}
          metrics={metrics}
          toolCallCount={toolCallCount}
          activePluginCount={activePluginCount}
          turnSnapshotCount={turnSnapshotCount}
          aiSessionCount={aiSessionCount}
          avgLatencyMs={avgLatencyMs}
        />
      );
    }
    if (activeView === "knowledge") {
      return <KnowledgeContent summary={summary} metrics={metrics} sessionDetail={sessionDetail} />;
    }
    if (activeView === "code") {
      return <CodeAttributionContent summary={summary} metrics={metrics} codeChanges={globalCodeChanges} />;
    }
    return (
      <SessionWorkspace
        sessions={sessions}
        selectedSession={selectedSession}
        selectedUser={selectedUser}
        sessionDetail={sessionDetail}
        loadSessionDetail={loadSessionDetail}
      />
    );
  }

  return (
    <div className="page dashboard-page">
      <header className="header hero-panel">
        <div className="header-title">
          <span className="eyebrow">TinyAI Observability</span>
          <h1>AI 采集监控台</h1>
          <p>
            当前视角：{selectedUser ? selectedUser : "全部用户"}
            {summary && ` · ${turnSnapshotCount} 个轮次 · ${summary.event_count} 个原始事件`}
          </p>
        </div>
        <div className="header-controls">
          <select value={selectedUser} onChange={e => handleUserChange(e.target.value)}>
            <option value="">全部用户</option>
            {users.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          <button className={`btn btn-primary`} onClick={refresh} disabled={loading}>
            {loading ? "加载中…" : "刷新"}
          </button>
        </div>
      </header>

      {loadError && (
        <div className="error-banner">
          {loadError} · 已尝试：{apiBases.join("，")}
        </div>
      )}

      <div className="dashboard-grid">
        <aside className="panel nav-panel">
          <div className="panel-header">
            <div>
              <h2>控制台</h2>
              <p>选择要查看的数据层</p>
            </div>
          </div>
          <div className="nav-panel-body">
            <nav className="nav-list" aria-label="控制台模块">
              {navItems.map((item) => (
                  <button
                    key={item.key}
                    className={`nav-item ${activeView === item.key ? "active" : ""}`}
                    onClick={() => setActiveView(item.key)}
                  >
                    <div>
                      <strong>{item.label}</strong>
                      <span>{item.description}</span>
                    </div>
                    {item.count !== undefined && <span className="nav-count">{fmtNumber(item.count)}</span>}
                  </button>
                ))}
            </nav>
            <PluginLoginPanel
              groups={pluginClientGroups}
              selectedUser={selectedUser}
              onSelectUser={handleUserChange}
            />
          </div>
        </aside>

        <main className="panel content-panel">
          <div className="panel-header">
            <div>
              <h2>{navItems.find((item) => item.key === activeView)?.label}</h2>
              <p>{navItems.find((item) => item.key === activeView)?.description}</p>
            </div>
          </div>
          <div className="panel-body">
            {renderActiveView()}
          </div>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
