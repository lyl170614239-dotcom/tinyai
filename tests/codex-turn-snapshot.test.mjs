import assert from "node:assert/strict";
import test from "node:test";

import { buildCodexTurnSnapshotEvent, codexTurnSnapshotPayload } from "../plugin-runtime/dist/codex-turn.js";

function sampleSnapshot() {
  return {
    session_id: "codex-session-1",
    session_file: "/tmp/codex-session-1.jsonl",
    cwd: "/workspace/demo",
    source: "codex_session_jsonl",
    message_count: 2,
    user_message_count: 1,
    assistant_message_count: 1,
    user_followup_count: 0,
    turn_started_count: 1,
    turn_completed_count: 1,
    turn_aborted_count: 0,
    task_repeat_attempts: 0,
    tool_call_count: 1,
    tool_result_count: 1,
    patch_apply_count: 1,
    patch_success_count: 1,
    include_text: true,
    latest_turn_complete: true,
    model: "gpt-5.5",
    resolved_model: "gpt-5.5",
    messages: [
      {
        role: "user",
        text: "你好",
        text_len: 2,
        text_hash: "user-hash",
        turn_index: 1,
        request_id: "request-1",
        response_id: "response-1"
      },
      {
        role: "assistant",
        text: "你好！",
        text_len: 3,
        text_hash: "assistant-hash",
        turn_index: 1,
        request_id: "request-1",
        response_id: "response-1"
      }
    ],
    process_steps: [
      {
        kind: "tool_call",
        tool_name: "exec_command",
        status: "complete",
        text: "ran command",
        text_len: 11,
        text_hash: "step-hash",
        turn_index: 1,
        request_id: "request-1",
        response_id: "response-1"
      }
    ],
    code_edits: [
      {
        file_path: "src/demo.ts",
        lines_added: 1,
        lines_deleted: 0,
        turn_index: 1,
        request_id: "request-1",
        response_id: "response-1",
        hunks: [
          {
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: 1,
            lines: [
              {
                line_type: "added",
                new_line: 1,
                text: "console.log('hello')",
                text_hash: "line-hash"
              }
            ]
          }
        ]
      }
    ],
    request_usage: [
      {
        request_id: "request-1",
        response_id: "response-1",
        request_index: 0,
        turn_index: 1,
        model: "gpt-5.5",
        prompt_tokens: 10,
        output_tokens: 5,
        completion_tokens: 5,
        elapsed_ms: 1000,
        occurred_at: "2026-06-29T00:00:00.000Z"
      }
    ],
    usage_totals: {
      prompt_tokens: 10,
      output_tokens: 5,
      completion_tokens: 5,
      elapsed_ms: 1000,
      copilot_credits: 0
    }
  };
}

test("Codex conversation capture is represented as one turn_snapshot payload", () => {
  const payload = codexTurnSnapshotPayload(sampleSnapshot(), {
    snapshotKind: "codex_mcp_auto_capture"
  });

  assert.equal(payload.schema_version, "codex.turn_snapshot.v1");
  assert.equal(payload.snapshot_kind, "codex_mcp_auto_capture");
  assert.equal(payload.session_id, "codex-session-1");
  assert.equal(payload.request_id, "request-1");
  assert.equal(payload.response_id, "response-1");
  assert.equal(payload.messages.length, 2);
  assert.equal(payload.process_steps.length, 1);
  assert.equal(payload.code_changes.length, 1);
  assert.equal(payload.code_changes[0].file_path, "src/demo.ts");
  assert.equal(payload.code_edits, undefined);
});

test("Codex turn snapshot event uses one stable turn_snapshot event id", () => {
  const first = buildCodexTurnSnapshotEvent(sampleSnapshot(), {
    taskId: "task-1",
    workspacePath: "/workspace/demo",
    snapshotKind: "codex_mcp_auto_capture"
  });
  const second = buildCodexTurnSnapshotEvent(sampleSnapshot(), {
    taskId: "task-1",
    workspacePath: "/workspace/demo",
    snapshotKind: "codex_mcp_auto_capture"
  });

  assert.equal(first.event_type, "turn_snapshot");
  assert.equal(first.tool, "codex");
  assert.equal(first.event_id, second.event_id);
  assert.equal(first.payload.code_changes.length, 1);
  assert.equal(first.payload.process_steps.length, 1);
  assert.equal(first.payload.messages.length, 2);
});

test("Codex turn payload keeps only the latest user and final answer as chat messages", () => {
  const snapshot = sampleSnapshot();
  snapshot.messages = [
    {
      role: "user",
      text: "# AGENTS.md instructions\n...",
      text_len: 24,
      text_hash: "bootstrap-hash",
      sequence: 1
    },
    {
      role: "user",
      text: "上一轮",
      text_len: 3,
      text_hash: "previous-user-hash",
      sequence: 2
    },
    {
      role: "assistant",
      text: "上一轮回答",
      text_len: 5,
      text_hash: "previous-assistant-hash",
      sequence: 3
    },
    {
      role: "user",
      text: "不开‘",
      text_len: 3,
      text_hash: "latest-user-hash",
      turn_index: 4,
      request_id: "request-4",
      response_id: "response-4",
      sequence: 4
    },
    {
      role: "assistant",
      text: "我先加载会话要求的启动技能。",
      text_len: 14,
      text_hash: "commentary-hash",
      turn_index: 4,
      request_id: "request-4",
      response_id: "response-4",
      sequence: 5
    },
    {
      role: "assistant",
      text: "我有点没读懂这句。",
      text_len: 10,
      text_hash: "final-hash",
      turn_index: 4,
      request_id: "request-4",
      response_id: "response-4",
      sequence: 6
    }
  ];
  snapshot.process_steps = [];
  snapshot.request_usage = [
    {
      request_id: "request-4",
      response_id: "response-4",
      request_index: 0,
      turn_index: 4,
      model: "gpt-5.5",
      prompt_tokens: 10,
      output_tokens: 5,
      completion_tokens: 5,
      elapsed_ms: 1000,
      occurred_at: "2026-06-29T00:00:00.000Z"
    }
  ];

  const payload = codexTurnSnapshotPayload(snapshot);

  assert.deepEqual(payload.messages.map((message) => [message.role, message.text]), [
    ["user", "不开‘"],
    ["assistant", "我有点没读懂这句。"]
  ]);
  assert.equal(payload.assistant_progress.length, 1);
  assert.equal(payload.assistant_progress[0].text, "我先加载会话要求的启动技能。");
});
