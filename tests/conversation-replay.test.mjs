import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  captureLatestClaudeConversation,
  captureLatestCodexConversation
} from "../plugin-runtime/dist/conversation.js";

test("Claude replay removes tool-only and duplicate entries but preserves repeated prompts in separate turns", async () => {
  const snapshot = await captureLatestClaudeConversation({
    includeText: true,
    sessionFile: resolve("tests/fixtures/claude-conversation.jsonl"),
    sessionId: "claude-test-session"
  });

  assert.equal(snapshot.session_id, "claude-test-session");
  assert.deepEqual(snapshot.messages.map((message) => [message.role, message.text]), [
    ["user", "继续"],
    ["assistant", "第一轮完成"],
    ["user", "继续"],
    ["assistant", "第二轮完成"]
  ]);
  assert.equal(snapshot.user_message_count, 2);
  assert.equal(snapshot.assistant_message_count, 2);
  assert.equal(snapshot.file_reads?.[0]?.path, "README.md");
  assert.ok(snapshot.process_steps?.every((step) => step.step_id));
});

test("Codex replay ignores empty event messages and binds the requested session file", async () => {
  const snapshot = await captureLatestCodexConversation({
    includeText: true,
    sessionFile: resolve("tests/fixtures/codex-conversation.jsonl")
  });

  assert.equal(snapshot.session_id, "codex-test-session");
  assert.deepEqual(snapshot.messages.map((message) => [message.role, message.text]), [
    ["user", "检查项目"],
    ["assistant", "检查完成"]
  ]);
  assert.equal(snapshot.tool_call_count, 1);
  assert.equal(snapshot.file_reads?.[0]?.path, "README.md");
  assert.equal(snapshot.model, "gpt-5.5");
  assert.equal(snapshot.request_usage?.[0]?.model, "gpt-5.5");
  assert.equal(snapshot.request_usage?.[0]?.prompt_tokens, 100);
  assert.equal(snapshot.request_usage?.[0]?.output_tokens, 20);
  assert.equal(snapshot.request_usage?.[0]?.elapsed_ms, 1234);
  assert.equal(snapshot.usage_totals?.prompt_tokens, 100);
  assert.equal(snapshot.usage_totals?.output_tokens, 20);
  assert.equal(snapshot.usage_totals?.elapsed_ms, 1234);
  assert.ok(snapshot.process_steps?.every((step) => step.step_id));
});

test("Codex replay uses the rollout file UUID as the stable session id when session_meta is absent", async () => {
  const snapshot = await captureLatestCodexConversation({
    includeText: true,
    sessionFile: resolve("tests/fixtures/rollout-2026-06-30T00-17-37-019f142c-088a-7ac2-9401-c7a425c16d90.jsonl")
  });

  assert.equal(snapshot.session_id, "019f142c-088a-7ac2-9401-c7a425c16d90");
});

test("Codex replay derives code edits from apply_patch input", async () => {
  const snapshot = await captureLatestCodexConversation({
    includeText: true,
    latestTurnOnly: true,
    sessionFile: resolve("tests/fixtures/codex-apply-patch.jsonl")
  });

  assert.equal(snapshot.session_id, "codex-apply-patch-session");
  assert.equal(snapshot.latest_turn_complete, true);
  assert.equal(snapshot.code_edits?.length, 1);
  assert.equal(snapshot.code_edits?.[0]?.file_path, "刘芸隆.md");
  assert.equal(snapshot.code_edits?.[0]?.lines_added, 3);
  assert.equal(snapshot.code_edits?.[0]?.lines_deleted, 0);
  assert.equal(snapshot.code_edits?.[0]?.hunks[0]?.lines[0]?.text, "# 刘芸隆的开心故事");
});

test("Codex replay recovers latest turn context when cursor starts after the user message", async () => {
  const previousCursorDir = process.env.TINYAI_OBS_CURSOR_DIR;
  const dir = await mkdtemp(`${tmpdir()}/tinyai-codex-cursor-`);
  process.env.TINYAI_OBS_CURSOR_DIR = dir;
  try {
    const sessionFile = `${dir}/rollout-2026-06-30T14-44-58-019f1746-1bb0-7281-b6cc-487a7020ddd0.jsonl`;
    const prefix = [
      JSON.stringify({ type: "session_meta", payload: { id: "cursor-session", cwd: "/tmp/project" } }),
      JSON.stringify({
        timestamp: "2026-06-30T06:45:06.668Z",
        type: "event_msg",
        payload: { type: "user_message", message: "修改李白md，添加他的故事\n" }
      })
    ].join("\n") + "\n";
    const suffix = [
      JSON.stringify({
        timestamp: "2026-06-30T06:46:03.734Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "我准备修改李白.md。" }
      }),
      JSON.stringify({
        timestamp: "2026-06-30T06:46:21.351Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Update File: 李白.md\n@@\n-旧\n+新\n*** End Patch\n"
        }
      }),
      JSON.stringify({
        timestamp: "2026-06-30T06:46:36.447Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "已修改李白.md。" }
      }),
      JSON.stringify({
        timestamp: "2026-06-30T06:46:36.559Z",
        type: "event_msg",
        payload: { type: "task_complete", duration_ms: 92376 }
      })
    ].join("\n") + "\n";
    await writeFile(sessionFile, prefix + suffix, "utf8");
    const info = await stat(sessionFile);
    const cursorOffset = Buffer.byteLength(prefix, "utf8");
    const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 32);
    await mkdir(dir, { recursive: true });
    await writeFile(
      `${dir}/codex-conversation-cursors.json`,
      JSON.stringify({
        [key]: {
          file_path: sessionFile,
          file_size: cursorOffset,
          read_offset: cursorOffset,
          updated_at: "2026-06-30T06:45:07.394Z",
          session_id: "cursor-session"
        }
      }),
      "utf8"
    );

    const snapshot = await captureLatestCodexConversation({
      includeText: true,
      latestTurnOnly: true,
      sessionFile
    });

    assert.equal(info.size > cursorOffset, true);
    assert.equal(snapshot.latest_turn_complete, true);
    assert.deepEqual(snapshot.messages.map((message) => [message.role, message.text]), [
      ["user", "修改李白md，添加他的故事\n"],
      ["assistant", "已修改李白.md。"]
    ]);
    assert.equal(snapshot.code_edits?.[0]?.file_path, "李白.md");
  } finally {
    if (previousCursorDir === undefined) delete process.env.TINYAI_OBS_CURSOR_DIR;
    else process.env.TINYAI_OBS_CURSOR_DIR = previousCursorDir;
  }
});

test("Codex replay excludes bootstrap context from real chat turn numbering", async () => {
  const dir = await mkdtemp(`${tmpdir()}/tinyai-codex-bootstrap-`);
  const sessionFile = `${dir}/rollout-2026-06-30T15-40-05-019f1778-9185-7540-8559-1c43fe78955e.jsonl`;
  await writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session_meta", payload: { id: "bootstrap-session", cwd: "/tmp/project" } }),
      JSON.stringify({
        timestamp: "2026-06-30T07:40:06.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>internal setup</INSTRUCTIONS>" },
            { type: "input_text", text: "<environment_context><cwd>/tmp/project</cwd></environment_context>" }
          ]
        }
      }),
      JSON.stringify({
        timestamp: "2026-06-30T07:41:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "push吧\n" }
      }),
      JSON.stringify({
        timestamp: "2026-06-30T07:41:03.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch\n"
        }
      }),
      JSON.stringify({
        timestamp: "2026-06-30T07:41:10.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "已处理 push。" }
      }),
      JSON.stringify({
        timestamp: "2026-06-30T07:41:12.000Z",
        type: "event_msg",
        payload: { type: "task_complete", duration_ms: 12000 }
      })
    ].join("\n") + "\n",
    "utf8"
  );

  const snapshot = await captureLatestCodexConversation({
    includeText: true,
    latestTurnOnly: true,
    sessionFile
  });

  assert.deepEqual(snapshot.messages.map((message) => [message.turn_index, message.role, message.text]), [
    [1, "user", "push吧\n"],
    [1, "assistant", "已处理 push。"]
  ]);
  assert.equal(snapshot.request_usage?.[0]?.turn_index, 1);
  assert.equal(snapshot.code_edits?.[0]?.turn_index, 1);
});

test("Codex replay gives separate real turns distinct message ids", async () => {
  const dir = await mkdtemp(`${tmpdir()}/tinyai-codex-message-ids-`);
  async function captureTurn(sessionFile, userText, assistantText, timestamp) {
    await writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "message-id-session", cwd: "/tmp/project" } }),
        JSON.stringify({
          timestamp: "2026-06-30T07:40:06.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "# AGENTS.md instructions\n\ninternal setup" }]
          }
        }),
        JSON.stringify({
          timestamp,
          type: "event_msg",
          payload: { type: "user_message", message: userText }
        }),
        JSON.stringify({
          timestamp,
          type: "event_msg",
          payload: { type: "agent_message", message: assistantText }
        }),
        JSON.stringify({
          timestamp,
          type: "event_msg",
          payload: { type: "task_complete", duration_ms: 1000 }
        })
      ].join("\n") + "\n",
      "utf8"
    );
    return captureLatestCodexConversation({
      includeText: true,
      latestTurnOnly: true,
      sessionFile
    });
  }

  const first = await captureTurn(`${dir}/first.jsonl`, "第一问\n", "第一答", "2026-06-30T07:41:00.000Z");
  const second = await captureTurn(`${dir}/second.jsonl`, "第二问\n", "第二答", "2026-06-30T07:42:00.000Z");

  assert.notEqual(first.messages[0].message_id, second.messages[0].message_id);
  assert.notEqual(first.messages[1].message_id, second.messages[1].message_id);
});
