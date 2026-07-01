import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backfillRecentClaudeTurns } from "../plugin-runtime/dist/index.js";

test("Claude backfill uploads an interrupted turn and commits cursor only after accepted upload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-backfill-"));
  const cursorDir = join(dir, "cursors");
  const sessionFile = join(dir, "claude-session.jsonl");
  const lines = [
    {
      type: "user",
      uuid: "request-arch",
      sessionId: "claude-backfill-session",
      timestamp: "2026-07-01T10:16:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "看看系统架构" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-arch-tool",
      sessionId: "claude-backfill-session",
      timestamp: "2026-07-01T10:16:05.000Z",
      message: {
        id: "msg-assistant-arch-tool",
        role: "assistant",
        model: "claude-haiku-4-5",
        stop_reason: "tool_use",
        content: [{ type: "text", text: "我先探索项目结构，了解整体情况。" }]
      }
    },
    {
      type: "user",
      uuid: "interrupt-arch",
      sessionId: "claude-backfill-session",
      timestamp: "2026-07-01T10:16:48.523Z",
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }
    }
  ].map((item) => JSON.stringify(item)).join("\n") + "\n";
  await writeFile(sessionFile, lines, "utf8");

  const uploaded = [];
  const result = await backfillRecentClaudeTurns({
    workspacePath: dir,
    includeText: true,
    sessionFile,
    sessionId: "claude-backfill-session",
    cursorDir,
    initializeUnseenFilesAtEof: false,
    client: {
      async upload(_tool, events) {
        uploaded.push(...events);
        return {
          accepted: events.length,
          duplicates: 0,
          events: events.map((event) => ({ event_id: event.event_id, event_type: event.event_type, status: "accepted" }))
        };
      }
    }
  });

  assert.equal(result.uploaded_events, 1);
  assert.equal(result.committed_files, 1);
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].payload.turn.status, "failed");
  assert.equal(uploaded[0].payload.turn.interrupted, true);
  assert.equal(uploaded[0].payload.turn.finish_reason, "request_interrupted_by_user");

  const cursorStore = JSON.parse(await readFile(join(cursorDir, "claude-turn-cursors.json"), "utf8"));
  const records = Object.values(cursorStore);
  assert.equal(records.length, 1);
  assert.equal(records[0].read_offset, Buffer.byteLength(lines, "utf8"));
});

test("Claude backfill does not commit cursor when upload is queued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-backfill-queued-"));
  const cursorDir = join(dir, "cursors");
  const sessionFile = join(dir, "claude-session.jsonl");
  const lines = [
    {
      type: "user",
      uuid: "request-queued",
      sessionId: "claude-backfill-queued-session",
      timestamp: "2026-07-01T10:16:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "你好" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-queued",
      sessionId: "claude-backfill-queued-session",
      timestamp: "2026-07-01T10:16:05.000Z",
      message: {
        id: "msg-assistant-queued",
        role: "assistant",
        model: "claude-haiku-4-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "你好！" }]
      }
    }
  ].map((item) => JSON.stringify(item)).join("\n") + "\n";
  await writeFile(sessionFile, lines, "utf8");

  const result = await backfillRecentClaudeTurns({
    workspacePath: dir,
    includeText: true,
    sessionFile,
    sessionId: "claude-backfill-queued-session",
    cursorDir,
    initializeUnseenFilesAtEof: false,
    client: {
      async upload() {
        return { accepted: 0, duplicates: 0, queued: true };
      }
    }
  });

  assert.equal(result.uploaded_events, 1);
  assert.equal(result.committed_files, 0);
  assert.equal(result.queued, true);
  let cursorStore = {};
  try {
    cursorStore = JSON.parse(await readFile(join(cursorDir, "claude-turn-cursors.json"), "utf8"));
  } catch {
    cursorStore = {};
  }
  assert.equal(Object.values(cursorStore).length, 0);
});
