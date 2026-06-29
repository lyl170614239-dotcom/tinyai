import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCopilotTurnSnapshots,
  copilotTurnEventId,
  CollectorClient
} from "../plugin-runtime/dist/index.js";

const longSecret = `api_key=${"x".repeat(70_000)}`;

test("builds one Copilot turn from chatSessions final state and transcript process data", () => {
  const snapshots = buildCopilotTurnSnapshots({
    chat_entries: [
      {
        kind: 0,
        v: {
          sessionId: "session-1",
          customTitle: "架构分析",
          creationDate: "2026-06-24T10:00:00.000Z",
          requests: [
            {
              requestId: "request-1",
              timestamp: "2026-06-24T10:00:01.000Z",
              modelId: "copilot/claude-haiku-4.5",
              message: { text: "给我分析一下系统架构" },
              response: [{ kind: "text", value: "最终架构回答来自 chatSessions" }],
              modelState: { value: 1, completedAt: "2026-06-24T10:00:10.000Z", responseId: "response-1" },
              result: {
                metadata: { promptTokens: 12, outputTokens: 5, resolvedModel: "claude-haiku-4.5" },
                timings: { totalElapsed: 9000 },
                details: "Claude Haiku 4.5 • 1.5 credits"
              }
            }
          ]
        }
      }
    ],
    transcript_entries: [
      { type: "session.start", data: { sessionId: "session-1", startTime: "2026-06-24T10:00:00.000Z" } },
      {
        type: "assistant.message",
        timestamp: "2026-06-24T10:00:03.000Z",
        data: {
          content: "中间流式内容，不应该成为最终回答",
          reasoningText: "可见推理：先读目录，再总结模块。",
          toolRequests: [{ id: "tool-1", function: { name: "read_file", arguments: { path: "README.md" } } }]
        }
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-06-24T10:00:05.000Z",
        data: { toolCallId: "tool-1", toolName: "read_file", output: { text: "README content" }, success: true }
      }
    ],
    chat_file: { path: "/tmp/chatSessions/session-1.jsonl", sha256: "chat-sha" },
    transcript_file: { path: "/tmp/transcripts/session-1.jsonl", sha256: "transcript-sha" }
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].request_id, "request-1");
  assert.equal(snapshots[0].response_id, "response-1");
  assert.equal(snapshots[0].assistant_message.text, "最终架构回答来自 chatSessions");
  assert.equal(snapshots[0].assistant_progress[0].text, "中间流式内容，不应该成为最终回答");
  assert.equal(snapshots[0].visible_reasoning[0].text, "可见推理：先读目录，再总结模块。");
  assert.equal(snapshots[0].tool_calls[0].tool_name, "read_file");
  assert.deepEqual(snapshots[0].tool_calls[0].arguments_raw, { path: "README.md" });
  assert.deepEqual(snapshots[0].tool_calls[0].result_raw, { text: "README content" });
  assert.notEqual(copilotTurnEventId(snapshots[0], "client-a"), copilotTurnEventId(snapshots[0], "client-b"));
});

test("replays chatSessions kind 2 array replacements by index", () => {
  const snapshots = buildCopilotTurnSnapshots({
    chat_entries: [
      {
        kind: 0,
        v: {
          sessionId: "session-replace",
          requests: [
            {
              requestId: "request-1",
              timestamp: "2026-06-24T10:00:00.000Z",
              message: { text: "第一轮" },
              response: [{ kind: "text", value: "第一轮回答" }],
              modelState: { value: 1, completedAt: "2026-06-24T10:00:01.000Z", responseId: "response-1" }
            }
          ]
        }
      },
      {
        kind: 2,
        k: ["requests"],
        v: [
          {
            requestId: "request-placeholder",
            timestamp: "2026-06-24T10:00:02.000Z",
            message: { text: "占位问题，不应该采集" },
            response: [],
            modelState: { value: 0 }
          }
        ]
      },
      {
        kind: 2,
        k: ["requests"],
        i: 1,
        v: [
          {
            requestId: "request-2",
            timestamp: "2026-06-24T10:00:02.000Z",
            message: { text: "继续写代码，写一个分子计算的" },
            response: [],
            modelState: { value: 0 }
          }
        ]
      },
      {
        kind: 2,
        k: ["requests", 1, "response"],
        v: [{ kind: "text", value: "已添加分子量计算函数" }]
      },
      {
        kind: 1,
        k: ["requests", 1, "modelState"],
        v: { value: 1, completedAt: "2026-06-24T10:00:03.000Z", responseId: "response-2" }
      }
    ]
  });

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].request_id, "request-2");
  assert.equal(snapshots[1].turn_index, 2);
  assert.equal(snapshots[1].user_message.text, "继续写代码，写一个分子计算的");
  assert.equal(snapshots[1].assistant_message.text, "已添加分子量计算函数");
});

test("turn_snapshot upload path keeps secrets and blobifies large tool raw content", () => {
  const client = new CollectorClient({ baseUrl: "http://localhost:18080", pluginName: "test", pluginVersion: "0.0.0" });
  const batch = client.makeBatch("copilot", [
    {
      event_id: "event-turn-123456",
      task_id: "task-turn-123456",
      session_id: "session-1",
      tool: "copilot",
      event_type: "turn_snapshot",
      occurred_at: "2026-06-24T10:00:10.000Z",
      payload: {
        session_id: "session-1",
        request_id: "request-1",
        response_id: "response-1",
        user_message: { text: "secret sk-1234567890123456789012345" },
        tool_calls: [{ tool_call_id: "tool-1", arguments_raw: longSecret, result_raw: longSecret }]
      },
      source_confidence: "derived",
      username: "tester"
    }
  ]);
  const payload = batch.events[0].payload;
  assert.equal(payload.user_message.text, "secret sk-1234567890123456789012345");
  assert.equal(payload.tool_calls[0].arguments_raw.blob_ref, "tool_calls[0].arguments_raw");
  assert.equal(payload.tool_calls[0].result_raw.blob_ref, "tool_calls[0].result_raw");
  assert.equal(payload.raw_event_blobs.length, 2);
  assert.equal(payload.raw_event_blobs[0].encoding, "gzip+base64");
  assert.ok(payload.raw_event_blobs[0].chunks.length >= 1);
});

test("code_change upload path blobifies large diff details instead of embedding huge JSON", () => {
  const client = new CollectorClient({ baseUrl: "http://localhost:18080", pluginName: "test", pluginVersion: "0.0.0" });
  const batch = client.makeBatch("copilot", [
    {
      event_id: "event-code-change-large",
      task_id: "task-code-change-large",
      session_id: "session-large",
      tool: "copilot",
      event_type: "code_change",
      occurred_at: "2026-06-24T10:00:10.000Z",
      payload: {
        session_id: "session-large",
        request_id: "request-large",
        response_id: "response-large",
        snapshot_kind: "copilot_turn_workspace_diff",
        files_changed: 1,
        lines_added: 1,
        lines_deleted: 0,
        diff_raw: `diff --git a/big.txt b/big.txt\n+${"x".repeat(70_000)}`,
        files: [
          {
            file_path: "big.txt",
            lines_added: 1,
            lines_deleted: 0,
            hunks: [{ old_start: 0, old_lines: 0, new_start: 1, new_lines: 1, lines: [{ line_type: "added", text: "x".repeat(70_000) }] }]
          }
        ]
      },
      source_confidence: "derived",
      username: "tester"
    }
  ]);
  const payload = batch.events[0].payload;
  assert.equal(payload.files.blob_ref, "files");
  assert.equal(payload.diff_raw.blob_ref, "diff_raw");
  assert.equal(payload.raw_event_blobs.length, 2);
  assert.ok(JSON.stringify(payload).length < 10_000);
});
