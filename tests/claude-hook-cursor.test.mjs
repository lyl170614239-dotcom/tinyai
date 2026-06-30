import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
async function runHook(stdin, env) {
  const child = spawn(process.execPath, [resolve("plugin-runtime/dist/hook.js")], {
    cwd: resolve("."),
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(stdin);
  const code = await new Promise((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("close", resolveExit);
  });
  assert.equal(code, 0, `hook exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function withCollector(handler) {
  const batches = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/v1/events/batch") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      batches.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        accepted: 1,
        duplicates: 0,
        failed: 0,
        task_count: 1,
        queued: false,
        events: batches.at(-1).events.map((event) => ({
          event_id: event.event_id,
          event_type: event.event_type,
          status: "accepted",
          reason: null
        }))
      }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  try {
    return await handler(`http://127.0.0.1:${address.port}`, batches);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

test("Claude hook captures the first completed turn when no cursor exists yet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-hook-cursor-"));
  const sessionFile = join(dir, "claude-session.jsonl");
  const cursorDir = join(dir, "cursors");
  const queuePath = join(dir, "queue-claude.jsonl");
  const sessionId = "claude-first-turn-session";
  await writeFile(sessionFile, [
    {
      type: "user",
      uuid: "request-first",
      sessionId,
      timestamp: "2026-06-30T09:09:56.669Z",
      message: { role: "user", content: [{ type: "text", text: "你好" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-first",
      sessionId,
      timestamp: "2026-06-30T09:10:07.819Z",
      message: {
        id: "msg-assistant-first",
        role: "assistant",
        model: "deepseek-v4-pro",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "你好！有什么可以帮你的吗？" }]
      }
    }
  ].map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

  await withCollector(async (collectorUrl, batches) => {
    await runHook(
      JSON.stringify({ session_id: sessionId, transcript_path: sessionFile }),
      {
        ...process.env,
        TINYAI_OBS_ENV_FILE: join(dir, "missing.env"),
        TINYAI_OBS_TOOL: "claude",
        TINYAI_OBS_EVENT_TYPE: "turn_snapshot",
        TINYAI_OBS_PLUGIN_VERSION: "test",
        TINYAI_OBS_COLLECTOR_URL: collectorUrl,
        TINYAI_OBS_COLLECTOR_URLS: "",
        TINYAI_OBS_TOKEN: "",
        TINYAI_OBS_CURSOR_DIR: cursorDir,
        TINYAI_OBS_CLAUDE_QUEUE: queuePath,
        TINYAI_OBS_CAPTURE_CONVERSATION_TEXT: "true"
      }
    );

    assert.equal(batches.length, 1);
    assert.equal(batches[0].events.length, 1);
    const event = batches[0].events[0];
    assert.equal(event.event_type, "turn_snapshot");
    assert.equal(event.payload.turn.turn_index, 1);
    assert.equal(event.payload.turn.request_id, "request-first");
    assert.equal(event.payload.user_message.text, "你好");
    const cursorStore = JSON.parse(await readFile(join(cursorDir, "claude-turn-cursors.json"), "utf8"));
    assert.equal(Object.values(cursorStore)[0].read_offset, event.payload.source_files.claude_project_jsonl.next_offset);
  });
});

test("Claude bash delta is attributed to the tool call turn from the session file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-hook-bash-"));
  const workspace = join(dir, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true });
  const sessionFile = join(dir, "claude-session.jsonl");
  const bashDeltaDir = join(dir, "bash-delta");
  const queuePath = join(dir, "queue-claude.jsonl");
  const sessionId = "claude-bash-turn-session";
  const command = "printf 'architecture\\n' > src/arch.md";
  await writeFile(sessionFile, [
    {
      type: "user",
      uuid: "request-one",
      sessionId,
      timestamp: "2026-06-30T09:59:04.960Z",
      cwd: workspace,
      message: { role: "user", content: [{ type: "text", text: "大师傅" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-one",
      sessionId,
      timestamp: "2026-06-30T09:59:14.185Z",
      cwd: workspace,
      message: {
        id: "response-one",
        role: "assistant",
        model: "deepseek-v4-pro",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "你好" }]
      }
    },
    {
      type: "user",
      uuid: "request-two",
      sessionId,
      timestamp: "2026-06-30T09:59:34.648Z",
      cwd: workspace,
      message: { role: "user", content: [{ type: "text", text: "看看系统架构" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-two",
      sessionId,
      timestamp: "2026-06-30T10:00:28.000Z",
      cwd: workspace,
      message: {
        id: "response-two",
        role: "assistant",
        model: "deepseek-v4-pro",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool-bash-two",
            name: "Bash",
            input: { command }
          }
        ]
      }
    }
  ].map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

  await withCollector(async (collectorUrl, batches) => {
    const env = {
      ...process.env,
      TINYAI_OBS_ENV_FILE: join(dir, "missing.env"),
      TINYAI_OBS_TOOL: "claude",
      TINYAI_OBS_PLUGIN_VERSION: "test",
      TINYAI_OBS_COLLECTOR_URL: collectorUrl,
      TINYAI_OBS_COLLECTOR_URLS: "",
      TINYAI_OBS_TOKEN: "",
      TINYAI_OBS_WORKSPACE: workspace,
      TINYAI_OBS_BASH_DELTA_DIR: bashDeltaDir,
      TINYAI_OBS_CLAUDE_QUEUE: queuePath
    };
    const stdin = JSON.stringify({
      session_id: sessionId,
      transcript_path: sessionFile,
      tool_name: "Bash",
      tool_use_id: "tool-bash-two",
      tool_input: { command }
    });
    await runHook(stdin, { ...env, TINYAI_OBS_EVENT_TYPE: "bash_pre_tool_use" });
    await writeFile(join(workspace, "src", "arch.md"), "architecture\n", "utf8");
    await runHook(stdin, { ...env, TINYAI_OBS_EVENT_TYPE: "bash_post_tool_use" });

    assert.equal(batches.length, 1);
    assert.equal(batches[0].events.length, 1);
    const event = batches[0].events[0];
    assert.equal(event.event_type, "code_change");
    assert.equal(event.payload.request_id, "request-two");
    assert.equal(event.payload.response_id, "response-two");
    assert.equal(event.payload.turn_index, 2);
    assert.equal(event.payload.tool_call_id, "tool-bash-two");
  });
});
