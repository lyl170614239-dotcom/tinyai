import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { CollectorClient, uploadResultAllowsCursorCommit } from "../plugin-runtime/dist/client.js";
import { deadLetterQueuePath, enqueueBatch, readQueuedBatches } from "../plugin-runtime/dist/queue.js";

function event(payload, eventId = "event-large-text") {
  return {
    event_id: eventId,
    task_id: `task-${eventId}`,
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
    throw new Error("The operation was aborted due to timeout");
  };

  try {
    const result = await client.upload("copilot", [event({ messages: [] })]);
    assert.equal(result.queued, true);
    assert.equal(result.events[0].reason, "retryable");

    const raw = await readFile(queuePath, "utf8");
    const line = JSON.parse(raw.trim());
    assert.equal(line.schema_version, "tinyai.queue.v2");
    assert.equal(line.error_category, "retryable");
    assert.equal(line.retry_count, 0);

    const queued = await readQueuedBatches(queuePath);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].events[0].event_id, "event-large-text");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dead-letters permanent upload failures instead of retrying forever", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-dead-letter-test-"));
  const queuePath = join(dir, "queue-copilot.jsonl");
  const client = new CollectorClient({
    tool: "copilot",
    baseUrl: "http://localhost:18080",
    queuePath,
    pluginName: "test-plugin",
    pluginVersion: "test"
  });
  client.postBatch = async () => {
    throw new Error("collector upload failed: 422 {\"detail\":[{\"type\":\"literal_error\",\"loc\":[\"body\",\"events\",0,\"event_type\"],\"msg\":\"Input should be an allowed event type\",\"input\":\"bash_pre_tool_use\"}]}");
  };

  try {
    const result = await client.upload("copilot", [event({ messages: [] }, "event-schema-error")]);
    assert.equal(result.queued, false);
    assert.equal(result.failed, 1);
    assert.equal(result.events[0].reason, "schema_error");

    const queued = await readQueuedBatches(queuePath);
    assert.equal(queued.length, 0);
    const deadLetter = JSON.parse((await readFile(deadLetterQueuePath(queuePath), "utf8")).trim());
    assert.equal(deadLetter.status, "dead_letter");
    assert.equal(deadLetter.error_category, "schema_error");
    assert.equal(deadLetter.batch.events[0].event_id, "event-schema-error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("flushQueue processes at most one batch window and leaves the rest queued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-flush-limit-test-"));
  const queuePath = join(dir, "queue-copilot.jsonl");
  const client = new CollectorClient({
    tool: "copilot",
    baseUrl: "http://localhost:18080",
    queuePath,
    pluginName: "test-plugin",
    pluginVersion: "test"
  });
  client.postBatch = async (batch) => ({
    accepted: batch.events.length,
    duplicates: 0,
    failed: 0,
    events: batch.events.map((item) => ({ event_id: item.event_id, event_type: item.event_type, status: "accepted" }))
  });

  try {
    for (let index = 0; index < 101; index += 1) {
      const batch = client.makeBatch("copilot", [event({ messages: [] }, `event-flush-${index}`)]);
      await enqueueBatch(batch, queuePath);
    }
    const result = await client.flushQueue("copilot");
    const remaining = await readQueuedBatches(queuePath);

    assert.equal(result.sent, 100);
    assert.equal(result.remaining, 1);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].events[0].event_id, "event-flush-100");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("flushQueue shares one in-flight flush for the same queue path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-flush-lock-test-"));
  const queuePath = join(dir, "queue-copilot.jsonl");
  const client = new CollectorClient({
    tool: "copilot",
    baseUrl: "http://localhost:18080",
    queuePath,
    pluginName: "test-plugin",
    pluginVersion: "test"
  });
  let postCalls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  client.postBatch = async (batch) => {
    postCalls += 1;
    await gate;
    return {
      accepted: batch.events.length,
      duplicates: 0,
      failed: 0,
      events: batch.events.map((item) => ({ event_id: item.event_id, event_type: item.event_type, status: "accepted" }))
    };
  };

  try {
    await enqueueBatch(client.makeBatch("copilot", [event({ messages: [] }, "event-lock")]), queuePath);
    const first = client.flushQueue("copilot");
    const second = client.flushQueue("copilot");
    for (let attempt = 0; attempt < 20 && postCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(postCalls, 1);
    release();
    const results = await Promise.all([first, second]);

    assert.equal(results[0].sent, 1);
    assert.equal(results[1].sent, 1);
    assert.equal(postCalls, 1);
    assert.equal((await readQueuedBatches(queuePath)).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("upload result only allows cursor commit after accepted or duplicate events", () => {
  assert.equal(uploadResultAllowsCursorCommit({
    accepted: 1,
    duplicates: 0,
    failed: 0,
    events: [{ event_id: "e1", event_type: "turn_snapshot", status: "accepted" }]
  }), true);
  assert.equal(uploadResultAllowsCursorCommit({
    accepted: 0,
    duplicates: 1,
    failed: 0,
    events: [{ event_id: "e1", event_type: "turn_snapshot", status: "duplicate" }]
  }), true);
  assert.equal(uploadResultAllowsCursorCommit({
    accepted: 0,
    duplicates: 0,
    failed: 0,
    queued: true,
    events: [{ event_id: "e1", event_type: "turn_snapshot", status: "failed", reason: "retryable" }]
  }), false);
  assert.equal(uploadResultAllowsCursorCommit({
    accepted: 1,
    duplicates: 0,
    failed: 1,
    events: [
      { event_id: "e1", event_type: "turn_snapshot", status: "accepted" },
      { event_id: "e2", event_type: "turn_snapshot", status: "failed", reason: "schema_error" }
    ]
  }), false);
});
