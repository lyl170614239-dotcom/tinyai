import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { CollectorClient } from "../plugin-runtime/dist/client.js";
import { readQueuedBatches } from "../plugin-runtime/dist/queue.js";

function event(payload) {
  return {
    event_id: "event-large-text",
    task_id: "task-large-text",
    tool: "copilot",
    event_type: "turn_snapshot",
    occurred_at: "2026-07-01T00:00:00.000Z",
    payload,
    source_confidence: "derived",
    username: "tester"
  };
}

test("blobifies large turn text fields before upload", () => {
  const largeText = "hello world ".repeat(7000);
  const client = new CollectorClient({
    tool: "copilot",
    baseUrl: "http://localhost:18080",
    pluginName: "test-plugin",
    pluginVersion: "test"
  });

  const batch = client.makeBatch("copilot", [
    event({
      user_message: { role: "user", text: largeText },
      assistant_message: { role: "assistant", text: largeText },
      messages: [{ role: "user", text: largeText }],
      assistant_progress: [{ step_type: "assistant_progress", text: largeText }],
      visible_reasoning: [{ step_type: "visible_reasoning", text: largeText }],
      process_steps: [{ step_type: "assistant_progress", text: largeText }],
      tool_calls: [{ tool_name: "Edit", arguments_raw: { prompt: largeText } }]
    })
  ]);

  const payload = batch.events[0].payload;
  assert.equal(payload.user_message.text, undefined);
  assert.equal(payload.user_message.text_preview, largeText.slice(0, 2000));
  assert.equal(payload.user_message.text_hash.length, 64);
  assert.equal(payload.user_message.text_blob_ref.blob_ref, "user_message.text");
  assert.equal(payload.assistant_message.text_blob_ref.blob_ref, "assistant_message.text");
  assert.equal(payload.messages[0].text_blob_ref.blob_ref, "messages[0].text");
  assert.equal(payload.assistant_progress[0].text_blob_ref.blob_ref, "assistant_progress[0].text");
  assert.equal(payload.visible_reasoning[0].text_blob_ref.blob_ref, "visible_reasoning[0].text");
  assert.equal(payload.process_steps[0].text_blob_ref.blob_ref, "process_steps[0].text");
  assert.equal(payload.tool_calls[0].arguments_raw.blob_ref, "tool_calls[0].arguments_raw");

  const blobKeys = payload.raw_event_blobs.map((blob) => blob.blob_key).sort();
  assert.deepEqual(blobKeys, [
    "assistant_message.text",
    "assistant_progress[0].text",
    "messages[0].text",
    "process_steps[0].text",
    "tool_calls[0].arguments_raw",
    "user_message.text",
    "visible_reasoning[0].text"
  ]);
});

test("queues failed uploads with error category metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-queue-test-"));
  const queuePath = join(dir, "queue-copilot.jsonl");
  const client = new CollectorClient({
    tool: "copilot",
    baseUrl: "http://localhost:18080",
    queuePath,
    pluginName: "test-plugin",
    pluginVersion: "test"
  });
  client.postBatch = async () => {
    throw new Error("collector upload failed: 413 request entity too large");
  };

  try {
    const result = await client.upload("copilot", [event({ messages: [] })]);
    assert.equal(result.queued, true);
    assert.equal(result.events[0].reason, "payload_too_large");

    const raw = await readFile(queuePath, "utf8");
    const line = JSON.parse(raw.trim());
    assert.equal(line.schema_version, "tinyai.queue.v2");
    assert.equal(line.error_category, "payload_too_large");
    assert.equal(line.retry_count, 0);

    const queued = await readQueuedBatches(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].events[0].event_id, "event-large-text");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
