import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  captureLatestClaudeConversation,
  captureLatestCodexConversation,
  codexTerminalTurnSnapshots
} from "../plugin-runtime/dist/conversation.js";
import { codexTurnSnapshotPayload } from "../plugin-runtime/dist/codex-turn.js";

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

test("Codex replay resolves relative apply_patch additions to absolute file lines", async () => {
  const dir = await mkdtemp(`${tmpdir()}/tinyai-codex-absolute-patch-`);
  const filePath = `${dir}/刘芸隆.md`;
  const prefix = Array.from({ length: 42 }, (_, index) => `前文第 ${index + 1} 行`);
  const added = [
    "又有一载，北境烽烟骤起，黑云压城，万骑踏雪而来。",
    "",
    "话音未落，他纵身跃下城头，足踏飞雪，刀锋横开三丈银芒。",
    "",
    "壮哉刘芸隆！侠骨仁心，光照四方。"
  ];
  await writeFile(filePath, `${[...prefix, ...added].join("\n")}\n`, "utf8");

  const sessionFile = `${dir}/codex-session.jsonl`;
  await writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-02T10:00:00.000Z", payload: { id: "codex-absolute-patch-session", cwd: dir } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-02T10:00:01.000Z", payload: { type: "user_message", id: "u-1", message: "添加更燃剧情" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-02T10:00:02.000Z", payload: { type: "task_started" } }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-02T10:00:03.000Z",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call-apply",
          name: "apply_patch",
          input: `*** Begin Patch\n*** Update File: 刘芸隆.md\n@@\n+${added.join("\n+")}\n*** End Patch\n`
        }
      }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-02T10:00:04.000Z", payload: { type: "agent_message", id: "a-1", message: "已添加。" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-02T10:00:05.000Z", payload: { type: "task_complete" } })
    ].join("\n") + "\n",
    "utf8"
  );

  const snapshot = await captureLatestCodexConversation({
    includeText: true,
    latestTurnOnly: true,
    sessionFile
  });

  const change = snapshot.code_edits?.[0];
  assert.equal(change?.line_number_basis, "absolute");
  assert.equal(change?.hunks[0]?.new_start, 43);
  assert.deepEqual(change?.hunks[0]?.lines.map((line) => line.new_line), [43, 44, 45, 46, 47]);
});

test("Codex replay resolves relative apply_patch replacements to absolute file lines", async () => {
  const dir = await mkdtemp(`${tmpdir()}/tinyai-codex-absolute-replace-`);
  const filePath = `${dir}/刘芸隆.md`;
  const prefix = Array.from({ length: 42 }, (_, index) => `前文第 ${index + 1} 行`);
  await writeFile(filePath, `${[...prefix, "新句子：刀光照彻北境。", "后文仍在。"].join("\n")}\n`, "utf8");

  const sessionFile = `${dir}/codex-session.jsonl`;
  await writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-02T11:00:00.000Z", payload: { id: "codex-absolute-replace-session", cwd: dir } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-02T11:00:01.000Z", payload: { type: "user_message", id: "u-1", message: "替换一句话" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-02T11:00:02.000Z", payload: { type: "task_started" } }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-02T11:00:03.000Z",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call-apply",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Update File: 刘芸隆.md\n@@\n-旧句子：风雪压城。\n+新句子：刀光照彻北境。\n 后文仍在。\n*** End Patch\n"
        }
      }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-02T11:00:04.000Z", payload: { type: "agent_message", id: "a-1", message: "已替换。" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-02T11:00:05.000Z", payload: { type: "task_complete" } })
    ].join("\n") + "\n",
    "utf8"
  );

  const snapshot = await captureLatestCodexConversation({
    includeText: true,
    latestTurnOnly: true,
    sessionFile
  });

  const change = snapshot.code_edits?.[0];
  assert.equal(change?.line_number_basis, "absolute");
  assert.equal(change?.hunks[0]?.new_start, 43);
  assert.equal(change?.hunks[0]?.old_start, 43);
  assert.equal(change?.hunks[0]?.lines.find((line) => line.line_type === "removed")?.old_line, 43);
  assert.equal(change?.hunks[0]?.lines.find((line) => line.line_type === "added")?.new_line, 43);
});

test("Codex replay treats an interrupted latest turn as a terminal failed turn", async () => {
  const dir = await mkdtemp(`${tmpdir()}/tinyai-codex-aborted-`);
  const sessionFile = `${dir}/rollout-2026-07-01T21-37-57-019f1de6-8ef7-7731-b6b8-73806603e942.jsonl`;
  await writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-aborted-session", cwd: "/tmp/project" } }),
      JSON.stringify({
        timestamp: "2026-07-01T13:43:05.290Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-aborted" }
      }),
      JSON.stringify({
        timestamp: "2026-07-01T13:43:05.373Z",
        type: "event_msg",
        payload: { type: "user_message", message: "看看系统架构\n" }
      }),
      JSON.stringify({
        timestamp: "2026-07-01T13:43:13.803Z",
        type: "event_msg",
        payload: { type: "agent_message", phase: "commentary", message: "我会用 analyze-with-file 来做这次架构梳理。" }
      }),
      JSON.stringify({
        timestamp: "2026-07-01T13:43:19.701Z",
        type: "event_msg",
        payload: { type: "agent_message", phase: "commentary", message: "先把入口、插件、后端、前端和测试线索跑一遍。" }
      }),
      JSON.stringify({
        timestamp: "2026-07-01T13:43:20.955Z",
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: "turn-aborted", duration_ms: 15671 }
      })
    ].join("\n") + "\n",
    "utf8"
  );

  const snapshot = await captureLatestCodexConversation({
    includeText: true,
    latestTurnOnly: true,
    sessionFile
  });
  const payload = codexTurnSnapshotPayload(snapshot);

  assert.equal(snapshot.latest_turn_complete, false);
  assert.equal(snapshot.latest_turn_aborted, true);
  assert.equal(snapshot.latest_turn_terminal, true);
  assert.equal(snapshot.turn_aborted_count, 1);
  assert.deepEqual(snapshot.messages.map((message) => [message.turn_index, message.role, message.text]), [
    [1, "user", "看看系统架构\n"],
    [1, "assistant", "先把入口、插件、后端、前端和测试线索跑一遍。"]
  ]);
  assert.equal(snapshot.process_steps?.[0]?.kind, "assistant_progress");
  assert.equal(payload.turn.status, "failed");
  assert.equal(payload.turn.interrupted, true);
  assert.equal(payload.turn.finish_reason, "user_interrupted");
});

test("Codex incremental replay splits an aborted turn before a later completed turn", async () => {
  const previousCursorDir = process.env.TINYAI_OBS_CURSOR_DIR;
  const dir = await mkdtemp(`${tmpdir()}/tinyai-codex-aborted-window-`);
  process.env.TINYAI_OBS_CURSOR_DIR = dir;
  try {
    const sessionFile = `${dir}/rollout-2026-07-01T22-08-36-019f1e02-a18a-7ba0-94f1-fe56e1c0f779.jsonl`;
    const prefix = [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-window-session", cwd: "/tmp/project" } }),
      JSON.stringify({
        timestamp: "2026-07-01T14:08:40.353Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" }
      }),
      JSON.stringify({
        timestamp: "2026-07-01T14:08:44.418Z",
        type: "event_msg",
        payload: { type: "user_message", message: "你好\n" }
      }),
      JSON.stringify({
        timestamp: "2026-07-01T14:09:05.671Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "你好！我在这儿。" }
      }),
      JSON.stringify({
        timestamp: "2026-07-01T14:09:06.026Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1", duration_ms: 25776 }
      })
    ].join("\n") + "\n";
    const suffix = [
      JSON.stringify({
        timestamp: "2026-07-01T14:11:58.937Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-2" }
      }),
      JSON.stringify({
        timestamp: "2026-07-01T14:11:59.086Z",
        type: "event_msg",
        payload: { type: "user_message", message: "分析系统架构\n" }
      }),
      JSON.stringify({
        timestamp: "2026-07-01T14:12:10.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "我会先检查最近 workflow 和仓库入口。" }
      }),
      JSON.stringify({
        timestamp: "2026-07-01T14:12:20.797Z",
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: "turn-2", reason: "interrupted", duration_ms: 21861 }
      }),
      JSON.stringify({
        timestamp: "2026-07-01T14:13:32.749Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-3" }
      }),
      JSON.stringify({
        timestamp: "2026-07-01T14:13:32.778Z",
        type: "event_msg",
        payload: { type: "user_message", message: "你好\n" }
      }),
      JSON.stringify({
        timestamp: "2026-07-01T14:13:38.267Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "你好，我在。刚才那次架构分析被你中断了。" }
      }),
      JSON.stringify({
        timestamp: "2026-07-01T14:13:38.368Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-3", duration_ms: 5625 }
      })
    ].join("\n") + "\n";
    await writeFile(sessionFile, prefix + suffix, "utf8");
    const cursorOffset = Buffer.byteLength(prefix, "utf8");
    const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 32);
    await writeFile(
      `${dir}/codex-conversation-cursors.json`,
      JSON.stringify({
        [key]: {
          file_path: sessionFile,
          file_size: cursorOffset,
          read_offset: cursorOffset,
          updated_at: "2026-07-01T14:09:06.026Z",
          session_id: "codex-window-session",
          user_message_count: 1
        }
      }),
      "utf8"
    );

    const snapshot = await captureLatestCodexConversation({
      includeText: true,
      latestTurnOnly: false,
      sessionFile
    });
    const turnSnapshots = codexTerminalTurnSnapshots(snapshot);
    const payloads = turnSnapshots.map((turnSnapshot) => codexTurnSnapshotPayload(turnSnapshot));

    assert.equal(snapshot.user_message_count, 2);
    assert.equal(snapshot.turn_index_offset, 1);
    assert.equal(turnSnapshots.length, 2);
    assert.deepEqual(payloads.map((payload) => [payload.turn.turn_index, payload.turn.status, payload.user_message.text]), [
      [2, "failed", "分析系统架构\n"],
      [3, "completed", "你好\n"]
    ]);
    assert.equal(payloads[0].turn.interrupted, true);
    assert.equal(payloads[0].turn.finish_reason, "user_interrupted");
  } finally {
    if (previousCursorDir === undefined) delete process.env.TINYAI_OBS_CURSOR_DIR;
    else process.env.TINYAI_OBS_CURSOR_DIR = previousCursorDir;
  }
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

test("Codex incremental replay preserves absolute turn index after prior completed turns", async () => {
  const previousCursorDir = process.env.TINYAI_OBS_CURSOR_DIR;
  const dir = await mkdtemp(`${tmpdir()}/tinyai-codex-turn-index-`);
  process.env.TINYAI_OBS_CURSOR_DIR = dir;
  try {
    const sessionFile = `${dir}/rollout-2026-06-30T17-17-43-019f17d1-f412-7ba3-9b70-175d46f13b55.jsonl`;
    const lines = [
      { type: "session_meta", payload: { id: "codex-three-turn-session", cwd: "/tmp/project" } },
      {
        timestamp: "2026-06-30T09:17:44.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" }
      },
      {
        timestamp: "2026-06-30T09:17:45.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "你好\n" }
      },
      {
        timestamp: "2026-06-30T09:17:46.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "你好！" }
      },
      {
        timestamp: "2026-06-30T09:17:47.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1", duration_ms: 1000 }
      },
      {
        timestamp: "2026-06-30T09:18:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-2" }
      },
      {
        timestamp: "2026-06-30T09:18:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "你在说什么\n" }
      },
      {
        timestamp: "2026-06-30T09:18:02.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "我在回答你的问题。" }
      },
      {
        timestamp: "2026-06-30T09:18:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-2", duration_ms: 2000 }
      }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    const suffix = [
      {
        timestamp: "2026-06-30T09:19:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-3" }
      },
      {
        timestamp: "2026-06-30T09:19:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "给我在当前目录下面增加一个md文档和一个py脚本\n" }
      },
      {
        timestamp: "2026-06-30T09:19:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 30, output_tokens: 12 } }
        }
      },
      {
        timestamp: "2026-06-30T09:19:03.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "已经创建文档和脚本。" }
      },
      {
        timestamp: "2026-06-30T09:19:04.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-3", duration_ms: 3000 }
      }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await writeFile(sessionFile, lines + suffix, "utf8");
    const cursorOffset = Buffer.byteLength(lines, "utf8");
    const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 32);
    await writeFile(
      `${dir}/codex-conversation-cursors.json`,
      JSON.stringify({
        [key]: {
          file_path: sessionFile,
          file_size: cursorOffset,
          read_offset: cursorOffset,
          updated_at: "2026-06-30T09:18:04.000Z",
          session_id: "codex-three-turn-session"
        }
      }),
      "utf8"
    );

    const snapshot = await captureLatestCodexConversation({
      includeText: true,
      latestTurnOnly: true,
      sessionFile
    });

    assert.deepEqual(snapshot.messages.map((message) => [message.turn_index, message.role, message.text]), [
      [3, "user", "给我在当前目录下面增加一个md文档和一个py脚本\n"],
      [3, "assistant", "已经创建文档和脚本。"]
    ]);
    assert.equal(snapshot.request_usage?.[0]?.turn_index, 3);
    assert.equal(snapshot.turn_events?.[0]?.turn_id, "turn-3");
    assert.equal(snapshot.latest_turn_complete, true);
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
