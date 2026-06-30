import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { captureLatestClaudeTurnSnapshots } from "../plugin-runtime/dist/index.js";

test("Claude turn parser keeps visible thinking separate from final assistant text", async () => {
  const snapshots = await captureLatestClaudeTurnSnapshots({
    includeText: true,
    latestOnly: false,
    sessionFile: resolve("tests/fixtures/claude-thinking-then-text.jsonl"),
    sessionId: "claude-thinking-text-session"
  });

  assert.equal(snapshots.length, 1);
  const snapshot = snapshots[0];
  assert.equal(snapshot.user_message.text, "哈哈哈哈哈哈");
  assert.equal(snapshot.assistant_message?.text, "哈哈，看起来你心情不错！有什么我可以帮你的吗？");
  assert.equal(snapshot.messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(snapshot.messages.find((message) => message.role === "assistant")?.text, "哈哈，看起来你心情不错！有什么我可以帮你的吗？");
  assert.equal(snapshot.visible_reasoning.length, 1);
  assert.match(snapshot.visible_reasoning[0].text || "", /The user just sent/);
  assert.equal(snapshot.assistant_progress.length, 0);
  assert.ok(!snapshot.process_steps.some((step) => step.step_type === "assistant_progress" && step.text === snapshot.assistant_message?.text));
});

test("Claude turn parser does not advance past an incomplete user-only turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-turn-"));
  const sessionFile = join(dir, "claude-session.jsonl");
  const userLine = JSON.stringify({
    type: "user",
    uuid: "request-user-only",
    sessionId: "claude-incremental-session",
    timestamp: "2026-06-29T12:38:09.449Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "你好" }]
    }
  }) + "\n";
  await writeFile(sessionFile, userLine, "utf8");

  const userOnly = await captureLatestClaudeTurnSnapshots({
    includeText: true,
    latestOnly: false,
    sessionFile,
    sessionId: "claude-incremental-session"
  });
  assert.equal(userOnly.length, 1);
  assert.equal(userOnly[0].turn.status, "incomplete");
  assert.equal(userOnly[0].assistant_message, undefined);
  assert.equal(userOnly[0].source_files.claude_project_jsonl.next_offset, 0);

  await appendFile(sessionFile, JSON.stringify({
    type: "assistant",
    uuid: "assistant-response",
    sessionId: "claude-incremental-session",
    timestamp: "2026-06-29T12:38:14.449Z",
    message: {
      id: "msg-assistant-response",
      role: "assistant",
      model: "claude-opus-4-6",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 6 },
      content: [{ type: "text", text: "你好！有什么我可以帮你的吗？" }]
    }
  }) + "\n", "utf8");

  const completed = await captureLatestClaudeTurnSnapshots({
    includeText: true,
    latestOnly: false,
    sessionFile,
    sessionId: "claude-incremental-session",
    startOffset: userOnly[0].source_files.claude_project_jsonl.next_offset
  });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].turn.status, "completed");
  assert.equal(completed[0].user_message.text, "你好");
  assert.equal(completed[0].assistant_message?.text, "你好！有什么我可以帮你的吗？");
  assert.ok(completed[0].source_files.claude_project_jsonl.next_offset > userLine.length);
});

test("Claude turn parser removes IDE context from the real user prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-context-"));
  const sessionFile = join(dir, "claude-session.jsonl");
  await writeFile(sessionFile, [
    {
      type: "user",
      uuid: "context-only",
      sessionId: "claude-context-session",
      timestamp: "2026-06-29T15:20:00.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<ide_opened_file>/Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs/刘芸隆.md</ide_opened_file>"
          }
        ]
      }
    },
    {
      type: "user",
      uuid: "request-edit-liu",
      sessionId: "claude-context-session",
      timestamp: "2026-06-29T15:21:00.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<ide_opened_file>/Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs/刘芸隆.md</ide_opened_file>"
          },
          {
            type: "text",
            text: "<selected_text>这段只是编辑器选区，不是用户问题</selected_text>"
          },
          {
            type: "text",
            text: "给我修改这个项目中刘芸隆文档"
          }
        ]
      }
    },
    {
      type: "assistant",
      uuid: "assistant-edit-liu",
      sessionId: "claude-context-session",
      timestamp: "2026-06-29T15:21:06.000Z",
      message: {
        id: "msg-assistant-edit-liu",
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 8 },
        content: [{ type: "text", text: "我先定位刘芸隆相关文档，然后再修改。" }]
      }
    }
  ].map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

  const snapshots = await captureLatestClaudeTurnSnapshots({
    includeText: true,
    latestOnly: false,
    sessionFile,
    sessionId: "claude-context-session"
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].user_message.text, "给我修改这个项目中刘芸隆文档");
  assert.equal(snapshots[0].messages.filter((message) => message.role === "user").length, 1);
  assert.ok(!snapshots[0].user_message.text.includes("ide_opened_file"));
  assert.ok(!snapshots[0].user_message.text.includes("selected_text"));
  assert.equal(snapshots[0].process_steps.filter((step) => step.step_type === "context").length, 2);
  assert.match(snapshots[0].process_steps.find((step) => step.source_event_type === "ide_opened_file")?.text || "", /刘芸隆\.md/);
});

test("Claude turn parser keeps multiple real prompts in one session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-multiturn-"));
  const sessionFile = join(dir, "claude-session.jsonl");
  await writeFile(sessionFile, [
    {
      type: "user",
      uuid: "request-one",
      sessionId: "claude-multiturn-session",
      timestamp: "2026-06-29T16:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "你好" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-one",
      sessionId: "claude-multiturn-session",
      timestamp: "2026-06-29T16:00:05.000Z",
      message: {
        id: "msg-assistant-one",
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "你好！有什么我可以帮你的吗？" }]
      }
    },
    {
      type: "user",
      uuid: "request-two",
      sessionId: "claude-multiturn-session",
      timestamp: "2026-06-29T16:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "继续修改" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-two",
      sessionId: "claude-multiturn-session",
      timestamp: "2026-06-29T16:01:05.000Z",
      message: {
        id: "msg-assistant-two",
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "好的，我继续。" }]
      }
    }
  ].map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

  const snapshots = await captureLatestClaudeTurnSnapshots({
    includeText: true,
    latestOnly: false,
    sessionFile,
    sessionId: "claude-multiturn-session"
  });

  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots.map((item) => item.session_id), ["claude-multiturn-session", "claude-multiturn-session"]);
  assert.deepEqual(snapshots.map((item) => item.turn_index), [1, 2]);
  assert.deepEqual(snapshots.map((item) => item.user_message.text), ["你好", "继续修改"]);
  assert.deepEqual(snapshots.map((item) => item.assistant_message?.text), ["你好！有什么我可以帮你的吗？", "好的，我继续。"]);
});

test("Claude turn parser preserves global turn indexes for incremental segments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-incremental-index-"));
  const sessionFile = join(dir, "claude-session.jsonl");
  const entries = [
    {
      type: "user",
      uuid: "request-one",
      sessionId: "claude-incremental-index-session",
      timestamp: "2026-06-30T08:00:00.000Z",
      promptSource: "sdk",
      message: { role: "user", content: [{ type: "text", text: "第一轮" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-one",
      sessionId: "claude-incremental-index-session",
      timestamp: "2026-06-30T08:00:05.000Z",
      message: {
        id: "msg-assistant-one",
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "第一轮回复" }]
      }
    },
    {
      type: "user",
      uuid: "skill-injected-instructions",
      sessionId: "claude-incremental-index-session",
      timestamp: "2026-06-30T08:00:06.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "Base directory for this skill: /tmp/skills/install-tinyai-observability\n\n# Install TinyAI Observability"
          }
        ]
      }
    },
    {
      type: "user",
      uuid: "request-two",
      sessionId: "claude-incremental-index-session",
      timestamp: "2026-06-30T08:01:00.000Z",
      promptSource: "sdk",
      message: { role: "user", content: [{ type: "text", text: "第二轮" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-two",
      sessionId: "claude-incremental-index-session",
      timestamp: "2026-06-30T08:01:05.000Z",
      message: {
        id: "msg-assistant-two",
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "第二轮回复" }]
      }
    },
    {
      type: "user",
      uuid: "request-three",
      sessionId: "claude-incremental-index-session",
      timestamp: "2026-06-30T08:02:00.000Z",
      promptSource: "sdk",
      message: { role: "user", content: [{ type: "text", text: "sa 阿斯顿发" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-three",
      sessionId: "claude-incremental-index-session",
      timestamp: "2026-06-30T08:02:05.000Z",
      message: {
        id: "msg-assistant-three",
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "第三轮回复" }]
      }
    },
    {
      type: "user",
      uuid: "request-four",
      sessionId: "claude-incremental-index-session",
      timestamp: "2026-06-30T08:03:00.000Z",
      promptSource: "sdk",
      message: { role: "user", content: [{ type: "text", text: "的飒风" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-four",
      sessionId: "claude-incremental-index-session",
      timestamp: "2026-06-30T08:03:05.000Z",
      message: {
        id: "msg-assistant-four",
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "第四轮回复" }]
      }
    }
  ];
  const lines = entries.map((item) => JSON.stringify(item));
  await writeFile(sessionFile, `${lines.join("\n")}\n`, "utf8");
  const startOffset = Buffer.byteLength(`${lines.slice(0, 5).join("\n")}\n`, "utf8");

  const snapshots = await captureLatestClaudeTurnSnapshots({
    includeText: true,
    latestOnly: false,
    sessionFile,
    sessionId: "claude-incremental-index-session",
    startOffset
  });

  assert.deepEqual(snapshots.map((item) => item.user_message.text), ["sa 阿斯顿发", "的飒风"]);
  assert.deepEqual(snapshots.map((item) => item.turn_index), [3, 4]);
  assert.deepEqual(snapshots.map((item) => item.request_usage[0].request_index), [2, 3]);
});

test("Claude turn parser keeps Agent prompt as tool evidence instead of a user message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-agent-prompt-"));
  const sessionFile = join(dir, "claude-session.jsonl");
  await writeFile(sessionFile, [
    {
      type: "user",
      uuid: "real-user-request",
      promptId: "prompt-architecture",
      sessionId: "claude-agent-session",
      timestamp: "2026-06-30T04:16:23.397Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<ide_opened_file>The user opened the file /Users/user/code/ai-observability/scripts/clear_tinyobs_data.py in the IDE. This may or may not be related to the current task.</ide_opened_file>"
          },
          {
            type: "text",
            text: "给我看看系统架构"
          }
        ]
      }
    },
    {
      type: "assistant",
      uuid: "assistant-agent-call",
      sessionId: "claude-agent-session",
      timestamp: "2026-06-30T04:16:28.000Z",
      message: {
        id: "assistant-agent-call",
        role: "assistant",
        model: "claude-opus-4-8",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me explore the project structure to understand the architecture." },
          {
            type: "tool_use",
            id: "call-agent-architecture",
            name: "agent",
            input: {
              prompt: [
                "I need to understand the system architecture of the ai-observability project at /Users/user/code/ai-observability.",
                "",
                "Please do a thorough exploration:"
              ].join("\n")
            }
          }
        ]
      }
    },
    {
      type: "user",
      uuid: "agent-tool-result",
      promptId: "prompt-architecture",
      sessionId: "claude-agent-session",
      timestamp: "2026-06-30T04:16:32.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-agent-architecture",
            content: "API Error: 400 The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed DeepSeek-V3.2.",
            is_error: true
          }
        ]
      },
      toolUseResult: {
        status: "failed",
        prompt: "I need to understand the system architecture of the ai-observability project at /Users/user/code/ai-observability.",
        agentId: "agent-architecture"
      }
    },
    {
      type: "assistant",
      uuid: "assistant-final",
      sessionId: "claude-agent-session",
      timestamp: "2026-06-30T04:17:08.000Z",
      message: {
        id: "assistant-final",
        role: "assistant",
        model: "claude-opus-4-8",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "## TinyAI Observability — 系统架构" }]
      }
    }
  ].map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

  const snapshots = await captureLatestClaudeTurnSnapshots({
    includeText: true,
    latestOnly: false,
    sessionFile,
    sessionId: "claude-agent-session"
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].user_message.text, "给我看看系统架构");
  assert.deepEqual(snapshots[0].messages.filter((message) => message.role === "user").map((message) => message.text), ["给我看看系统架构"]);
  assert.equal(snapshots[0].tool_calls[0].tool_name, "agent");
  assert.match(String(snapshots[0].tool_calls[0].arguments_raw?.prompt || ""), /system architecture/);
  assert.ok(!snapshots[0].messages.some((message) => message.text.includes("I need to understand the system architecture")));
  assert.ok(!snapshots[0].messages.some((message) => message.text.includes("ide_opened_file")));
});
