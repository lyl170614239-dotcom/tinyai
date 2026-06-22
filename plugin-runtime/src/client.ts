import type { EventBatch, ObservabilityEvent, ToolName } from "./event-schema.js";
import { clientId } from "./event-schema.js";
import { redact } from "./redactor.js";
import { enqueueBatch, readQueuedBatches, replaceQueue } from "./queue.js";

export interface CollectorClientOptions {
  baseUrl?: string;
  token?: string;
  pluginName?: string;
  pluginVersion?: string;
}

export class CollectorClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly pluginName: string;
  private readonly pluginVersion: string;

  constructor(options: CollectorClientOptions = {}) {
    this.baseUrl = options.baseUrl || process.env.TINYAI_OBS_COLLECTOR_URL || "http://localhost:18080";
    this.token = options.token || process.env.TINYAI_OBS_TOKEN || "dev-token";
    this.pluginName = options.pluginName || "tinyai-observability";
    this.pluginVersion = options.pluginVersion || process.env.TINYAI_OBS_PLUGIN_VERSION || "0.1.0";
  }

  makeBatch(tool: ToolName, events: ObservabilityEvent[]): EventBatch {
    return {
      client_id: clientId(tool),
      plugin_name: this.pluginName,
      plugin_version: this.pluginVersion,
      events: events.map((event) => ({
        ...event,
        payload: redact(event.payload, {
          allowFullConversationText: event.event_type === "conversation_snapshot" && event.payload?.include_text === true
        }) as Record<string, unknown>
      }))
    };
  }

  async upload(tool: ToolName, events: ObservabilityEvent[]): Promise<void> {
    const batch = this.makeBatch(tool, events);
    try {
      await this.postBatch(batch);
    } catch {
      await enqueueBatch(batch);
    }
  }

  async flushQueue(): Promise<{ sent: number; remaining: number }> {
    const queued = await readQueuedBatches();
    const remaining: EventBatch[] = [];
    let sent = 0;
    for (const batch of queued) {
      try {
        await this.postBatch(batch);
        sent += batch.events.length;
      } catch {
        remaining.push(batch);
      }
    }
    await replaceQueue(remaining);
    return { sent, remaining: remaining.length };
  }

  private async postBatch(batch: EventBatch): Promise<void> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/v1/events/batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`
      },
      body: JSON.stringify(batch)
    });
    if (!response.ok) {
      throw new Error(`collector upload failed: ${response.status} ${await response.text()}`);
    }
  }
}
