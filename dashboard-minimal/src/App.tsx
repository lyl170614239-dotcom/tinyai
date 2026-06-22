import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Task = {
  task_id: string;
  tool: string;
  started_at: string | null;
  ended_at: string | null;
  result: string | null;
  event_count: number;
};

type Event = {
  event_id: string;
  task_id: string;
  tool: string;
  event_type: string;
  occurred_at: string;
  source_confidence: string;
  payload: Record<string, unknown> | null;
};

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
    event_count: number;
    spec_access_event_count: number;
    code_snapshot_count: number;
    commit_snapshot_count?: number;
    push_snapshot_count?: number;
    ai_committed_lines?: number;
    ai_pushed_lines?: number;
    pr_attribution_count?: number;
    pr_ai_lines?: number;
    pr_total_lines?: number;
    conversation_snapshot_count: number;
  };
  categories: MetricCategory[];
};

const apiBase = import.meta.env.VITE_OBS_API_BASE || "http://localhost:18080";

function formatValue(metric: Metric) {
  if (metric.value === null || metric.value === undefined) return "N/A";
  if (metric.unit === "count") return metric.value.toFixed(2);
  if (metric.unit === "table") return "details";
  return `${Math.round(metric.value * 1000) / 10}%`;
}

function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<string>("");
  const [events, setEvents] = useState<Event[]>([]);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);

  async function loadTasks() {
    const response = await fetch(`${apiBase}/api/v1/tasks/recent`);
    setTasks(await response.json());
  }

  async function loadMetrics() {
    const response = await fetch(`${apiBase}/api/v1/metrics/knowledge`);
    setMetrics(await response.json());
  }

  async function loadEvents(taskId: string) {
    setSelectedTask(taskId);
    const response = await fetch(`${apiBase}/api/v1/tasks/${taskId}/events`);
    setEvents(await response.json());
  }

  useEffect(() => {
    loadTasks().catch(console.error);
    loadMetrics().catch(console.error);
  }, []);

  async function refreshAll() {
    await Promise.all([loadTasks(), loadMetrics()]);
  }

  return (
    <main>
      <header>
        <div>
          <h1>TinyAI Observability</h1>
          <p>Knowledge usage, code adoption, and rework telemetry.</p>
        </div>
        <button onClick={refreshAll}>Refresh</button>
      </header>

      {metrics && (
        <section className="summary">
          <div>
            <strong>{metrics.summary.task_count}</strong>
            <span>Tasks</span>
          </div>
          <div>
            <strong>{metrics.summary.event_count}</strong>
            <span>Events</span>
          </div>
          <div>
            <strong>{metrics.summary.spec_access_event_count}</strong>
            <span>Spec Access</span>
          </div>
          <div>
            <strong>{metrics.summary.conversation_snapshot_count}</strong>
            <span>Conversations</span>
          </div>
          <div>
            <strong>{metrics.summary.ai_committed_lines ?? 0}</strong>
            <span>AI Commit Lines</span>
          </div>
          <div>
            <strong>{metrics.summary.ai_pushed_lines ?? 0}</strong>
            <span>AI Push Lines</span>
          </div>
          <div>
            <strong>{metrics.summary.pr_ai_lines ?? 0}</strong>
            <span>PR AI Lines</span>
          </div>
        </section>
      )}

      {metrics && (
        <section className="metrics">
          {metrics.categories.map((category) => (
            <section key={category.key} className="metric-group">
              <h2>{category.title}</h2>
              <div className="metric-list">
                {category.metrics.map((metric) => (
                  <article key={metric.id} className="metric">
                    <div>
                      <span>#{metric.id}</span>
                      <strong>{metric.name}</strong>
                    </div>
                    <b>{formatValue(metric)}</b>
                    <small>
                      {metric.confidence} · {metric.numerator ?? "-"} / {metric.denominator ?? "-"}
                    </small>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </section>
      )}

      <section className="grid">
        <div className="panel">
          <h2>Recent Tasks</h2>
          {tasks.length === 0 && <p className="empty">No plugin events received yet.</p>}
          {tasks.map((task) => (
            <button
              key={task.task_id}
              className={`task ${selectedTask === task.task_id ? "active" : ""}`}
              onClick={() => loadEvents(task.task_id)}
            >
              <span>{task.tool}</span>
              <strong>{task.task_id.slice(0, 8)}</strong>
              <small>{task.event_count} events</small>
            </button>
          ))}
        </div>

        <div className="panel">
          <h2>Event Trace</h2>
          {events.length === 0 && <p className="empty">Select a task to inspect its events.</p>}
          {events.map((event) => (
            <article key={event.event_id} className="event">
              <div className="event-row">
                <strong>{event.event_type}</strong>
                <span>{event.source_confidence}</span>
              </div>
              <time>{new Date(event.occurred_at).toLocaleString()}</time>
              <pre>{JSON.stringify(event.payload || {}, null, 2)}</pre>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
