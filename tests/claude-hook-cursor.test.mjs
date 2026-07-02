import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function withCollector(fn) {
  const batches = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/api/v1/events/batch") {
        res.writeHead(404).end();
        return;
      }
      const batch = JSON.parse(body);
      batches.push(batch);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        accepted: batch.events.length,
        duplicates: 0,
        events: batch.events.map((event) => ({
          event_id: event.event_id,
          event_type: event.event_type,
          status: "accepted"
        }))
      }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await fn(`http://127.0.0.1:${address.port}`, batches);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function runHook(eventType, payload, env) {
  const child = spawn(process.execPath, [resolve("plugin-runtime/dist/hook.js")], {
    cwd: env.TINYAI_OBS_WORKSPACE,
    env: {
      ...process.env,
      ...env,
      TINYAI_OBS_EVENT_TYPE: eventType,
      TINYAI_OBS_TOOL: "claude",
      TINYAI_OBS_AUTO_INSTALL_GIT_HOOKS: "false",
      TINYAI_OBS_CAPTURE_CONVERSATION_TEXT: "true",
      TINYAI_OBS_ENABLE_CLAUDE_WORKSPACE_DIFF_FALLBACK: "false"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end(JSON.stringify(payload));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolveExit) => child.on("exit", resolveExit));
  assert.equal(code, 0, stderr);
}

test("Claude task_start cursor does not skip an existing first user turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-hook-cursor-"));
  const sessionFile = join(dir, "claude-session.jsonl");
  const sessionId = "claude-first-turn-session";
  const cursorDir = join(dir, "cursors");
  const queuePath = join(dir, "queue.jsonl");
  const env = {
    TINYAI_OBS_WORKSPACE: dir,
    TINYAI_OBS_CURSOR_DIR: cursorDir,
    TINYAI_OBS_QUEUE: queuePath,
    TINYAI_OBS_ENV_FILE: join(dir, "missing.env")
  };
  const hookPayload = {
    session_id: sessionId,
    transcript_path: sessionFile
  };

  const firstUser = JSON.stringify({
    type: "user",
    uuid: "request-first-turn",
    sessionId,
    timestamp: "2026-07-02T09:00:00.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "第一轮问题" }]
    }
  }) + "\n";
  await writeFile(sessionFile, firstUser, "utf8");

  await withCollector(async (collectorUrl, batches) => {
    const hookEnv = {
      ...env,
      TINYAI_OBS_COLLECTOR_URL: collectorUrl
    };
    await runHook("task_start", hookPayload, hookEnv);
    await appendFile(sessionFile, JSON.stringify({
      type: "assistant",
      uuid: "assistant-first-turn",
      sessionId,
      timestamp: "2026-07-02T09:00:03.000Z",
      message: {
        id: "msg-assistant-first-turn",
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 6 },
        content: [{ type: "text", text: "第一轮回答" }]
      }
    }) + "\n", "utf8");

    await runHook("turn_snapshot", hookPayload, hookEnv);

    const turnEvents = batches
      .flatMap((batch) => batch.events)
      .filter((event) => event.event_type === "turn_snapshot");
    assert.equal(turnEvents.length, 1);
    assert.equal(turnEvents[0].payload.turn_index, 1);
    assert.equal(turnEvents[0].payload.user_message.text, "第一轮问题");
    assert.equal(turnEvents[0].payload.assistant_message.text, "第一轮回答");
    assert.equal(turnEvents[0].payload.capture_cursor.startOffset, 0);
  });
});
