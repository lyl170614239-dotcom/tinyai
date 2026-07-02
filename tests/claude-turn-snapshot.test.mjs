import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, appendFile, mkdir, writeFile } from "node:fs/promises";
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

test("Claude turn parser finalizes a user-interrupted turn instead of dropping it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-interrupted-"));
  const sessionFile = join(dir, "claude-session.jsonl");
  const entries = [
    {
      type: "user",
      uuid: "request-architecture",
      sessionId: "claude-interrupted-session",
      timestamp: "2026-07-01T08:56:09.835Z",
      message: { role: "user", content: [{ type: "text", text: "看看系统架构" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-thinking",
      sessionId: "claude-interrupted-session",
      timestamp: "2026-07-01T08:56:15.867Z",
      message: {
        id: "msg-architecture",
        role: "assistant",
        model: "deepseek-v4-pro",
        stop_reason: "tool_use",
        content: [{ type: "thinking", thinking: "I should inspect the repository structure." }]
      }
    },
    {
      type: "assistant",
      uuid: "assistant-tool-use",
      sessionId: "claude-interrupted-session",
      timestamp: "2026-07-01T08:56:18.018Z",
      message: {
        id: "msg-architecture",
        role: "assistant",
        model: "deepseek-v4-pro",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me explore the codebase." },
          { type: "tool_use", id: "call-list-files", name: "Bash", input: { command: "rg --files" } }
        ]
      }
    },
    {
      type: "user",
      uuid: "tool-result",
      sessionId: "claude-interrupted-session",
      timestamp: "2026-07-01T08:56:21.092Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-list-files", content: "README.md\nplugin-runtime/src/hook.ts", is_error: false }]
      }
    },
    {
      type: "user",
      uuid: "interrupted-marker",
      sessionId: "claude-interrupted-session",
      timestamp: "2026-07-01T08:56:21.957Z",
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }
    }
  ];
  await writeFile(sessionFile, entries.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

  const snapshots = await captureLatestClaudeTurnSnapshots({
    includeText: true,
    latestOnly: false,
    sessionFile,
    sessionId: "claude-interrupted-session"
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].user_message.text, "看看系统架构");
  assert.equal(snapshots[0].turn.status, "failed");
  assert.equal(snapshots[0].turn.interrupted, true);
  assert.equal(snapshots[0].turn.interrupt_reason, "request_interrupted_by_user");
  assert.equal(snapshots[0].turn.finish_reason, "request_interrupted_by_user");
  assert.equal(snapshots[0].tool_calls.length, 1);
  assert.ok(snapshots[0].visible_reasoning.length > 0);
  assert.equal(snapshots[0].messages.some((message) => message.text.includes("Request interrupted")), false);
  assert.ok(snapshots[0].source_files.claude_project_jsonl.next_offset > 0);
});

test("Claude turn parser does not report rejected edit tool use as a code change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-rejected-edit-"));
  const sessionFile = join(dir, "claude-session.jsonl");
  const entries = [
    {
      type: "user",
      uuid: "request-edit",
      sessionId: "claude-rejected-edit-session",
      timestamp: "2026-07-01T11:05:38.955Z",
      message: { role: "user", content: [{ type: "text", text: "修改刘芸隆md，添加离别的故事" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-edit-tool",
      sessionId: "claude-rejected-edit-session",
      timestamp: "2026-07-01T11:05:59.353Z",
      message: {
        id: "msg-edit",
        role: "assistant",
        model: "deepseek-v4-pro",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "我来修改文件。" },
          {
            type: "tool_use",
            id: "call-edit-rejected",
            name: "replace_string_in_file",
            input: {
              file_path: "/Users/user/code/ai-observability/刘芸隆.md",
              old_string: "壮哉刘芸隆！侠骨仁心，光照四方。江湖有幸，得此一人。",
              new_string: "壮哉刘芸隆！侠骨仁心，光照四方。江湖有幸，得此一人。\n\n# 离别\n\n此去经年，江湖再会。",
              replace_all: false
            }
          }
        ]
      }
    },
    {
      type: "user",
      uuid: "rejected-edit-result",
      sessionId: "claude-rejected-edit-session",
      timestamp: "2026-07-01T11:06:02.562Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-edit-rejected",
            content: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
            is_error: true
          }
        ]
      },
      toolUseResult: "User rejected tool use"
    },
    {
      type: "user",
      uuid: "interrupted-marker",
      sessionId: "claude-rejected-edit-session",
      timestamp: "2026-07-01T11:06:02.564Z",
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }
    }
  ];
  await writeFile(sessionFile, entries.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

  const snapshots = await captureLatestClaudeTurnSnapshots({
    includeText: true,
    latestOnly: false,
    sessionFile,
    sessionId: "claude-rejected-edit-session"
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].tool_calls[0].tool_call_id, "call-edit-rejected");
  assert.equal(snapshots[0].tool_calls[0].status, "failed");
  assert.equal(snapshots[0].process_steps.some((step) => step.step_type === "tool_result" && step.status === "failed"), true);
  assert.deepEqual(snapshots[0].code_changes, []);
});

test("Claude turn parser resolves replacement edits to absolute workspace line numbers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-absolute-edit-"));
  const workspace = join(dir, "workspace");
  const docsDir = join(workspace, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, "spec.md"), "Intro\nKeep\nAlpha\nBeta changed\nGamma\nTail\n", "utf8");
  const sessionFile = join(dir, "claude-session.jsonl");
  const entries = [
    {
      type: "user",
      uuid: "request-absolute-edit",
      sessionId: "claude-absolute-edit-session",
      timestamp: "2026-07-01T11:05:38.955Z",
      cwd: workspace,
      message: { role: "user", content: [{ type: "text", text: "更新 spec" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-absolute-edit-tool",
      sessionId: "claude-absolute-edit-session",
      timestamp: "2026-07-01T11:05:59.353Z",
      cwd: workspace,
      message: {
        id: "msg-absolute-edit",
        role: "assistant",
        model: "deepseek-v4-pro",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "call-absolute-edit",
            name: "replace_string_in_file",
            input: {
              file_path: "docs/spec.md",
              old_string: "Alpha\nBeta\nGamma",
              new_string: "Alpha\nBeta changed\nGamma"
            }
          }
        ]
      }
    },
    {
      type: "user",
      uuid: "absolute-edit-result",
      sessionId: "claude-absolute-edit-session",
      timestamp: "2026-07-01T11:06:02.562Z",
      cwd: workspace,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-absolute-edit", content: "Updated docs/spec.md" }]
      }
    },
    {
      type: "assistant",
      uuid: "assistant-absolute-edit-final",
      sessionId: "claude-absolute-edit-session",
      timestamp: "2026-07-01T11:06:03.000Z",
      cwd: workspace,
      message: {
        id: "msg-absolute-edit-final",
        role: "assistant",
        model: "deepseek-v4-pro",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "已更新。" }]
      }
    }
  ];
  await writeFile(sessionFile, entries.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

  const snapshots = await captureLatestClaudeTurnSnapshots({
    includeText: true,
    latestOnly: false,
    sessionFile,
    sessionId: "claude-absolute-edit-session",
    workspacePath: workspace
  });

  assert.equal(snapshots.length, 1);
  const change = snapshots[0].code_changes[0];
  assert.equal(change.line_number_basis, "absolute");
  assert.equal(change.line_numbers_are_absolute, true);
  assert.equal(change.hunks[0].old_start, 3);
  assert.equal(change.hunks[0].new_start, 3);
  assert.deepEqual(change.hunks[0].lines.map((line) => line.old_line).filter(Boolean), [3, 4, 5]);
  assert.deepEqual(change.hunks[0].lines.map((line) => line.new_line).filter(Boolean), [3, 4, 5]);
});

test("Claude turn parser resolves repeated replacement text through git diff hunk lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-repeated-edit-"));
  const workspace = join(dir, "workspace");
  const docsDir = join(workspace, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, "story.md"), "Intro\nrepeat target\nMiddle\nold unique line\nTail\n", "utf8");
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });
  await writeFile(join(docsDir, "story.md"), "Intro\nrepeat target\nMiddle\nrepeat target\nTail\n", "utf8");

  const sessionFile = join(dir, "claude-session.jsonl");
  const entries = [
    {
      type: "user",
      uuid: "request-repeated-edit",
      sessionId: "claude-repeated-edit-session",
      timestamp: "2026-07-01T12:05:38.955Z",
      cwd: workspace,
      message: { role: "user", content: [{ type: "text", text: "更新 story" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-repeated-edit-tool",
      sessionId: "claude-repeated-edit-session",
      timestamp: "2026-07-01T12:05:59.353Z",
      cwd: workspace,
      message: {
        id: "msg-repeated-edit",
        role: "assistant",
        model: "deepseek-v4-pro",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "call-repeated-edit",
            name: "replace_string_in_file",
            input: {
              file_path: "docs/story.md",
              old_string: "old unique line",
              new_string: "repeat target"
            }
          }
        ]
      }
    },
    {
      type: "user",
      uuid: "repeated-edit-result",
      sessionId: "claude-repeated-edit-session",
      timestamp: "2026-07-01T12:06:02.562Z",
      cwd: workspace,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-repeated-edit", content: "Updated docs/story.md" }]
      }
    },
    {
      type: "assistant",
      uuid: "assistant-repeated-edit-final",
      sessionId: "claude-repeated-edit-session",
      timestamp: "2026-07-01T12:06:03.000Z",
      cwd: workspace,
      message: {
        id: "msg-repeated-edit-final",
        role: "assistant",
        model: "deepseek-v4-pro",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "已更新。" }]
      }
    }
  ];
  await writeFile(sessionFile, entries.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

  const snapshots = await captureLatestClaudeTurnSnapshots({
    includeText: true,
    latestOnly: false,
    sessionFile,
    sessionId: "claude-repeated-edit-session",
    workspacePath: workspace
  });

  assert.equal(snapshots.length, 1);
  const change = snapshots[0].code_changes[0];
  assert.equal(change.line_number_basis, "absolute");
  assert.equal(change.line_numbers_are_absolute, true);
  assert.equal(change.hunks[0].old_start, 4);
  assert.equal(change.hunks[0].new_start, 4);
  assert.equal(change.hunks[0].lines.find((line) => line.line_type === "removed")?.old_line, 4);
  assert.equal(change.hunks[0].lines.find((line) => line.line_type === "added")?.new_line, 4);
});

test("Claude turn parser resolves deletion-only edits through git diff hunk lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-delete-edit-"));
  const workspace = join(dir, "workspace");
  const docsDir = join(workspace, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, "story.md"), "Intro\nKeep\nDelete me\nTail\n", "utf8");
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });
  await writeFile(join(docsDir, "story.md"), "Intro\nKeep\nTail\n", "utf8");

  const sessionFile = join(dir, "claude-session.jsonl");
  const entries = [
    {
      type: "user",
      uuid: "request-delete-edit",
      sessionId: "claude-delete-edit-session",
      timestamp: "2026-07-01T13:05:38.955Z",
      cwd: workspace,
      message: { role: "user", content: [{ type: "text", text: "删除一句话" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-delete-edit-tool",
      sessionId: "claude-delete-edit-session",
      timestamp: "2026-07-01T13:05:59.353Z",
      cwd: workspace,
      message: {
        id: "msg-delete-edit",
        role: "assistant",
        model: "deepseek-v4-pro",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "call-delete-edit",
            name: "replace_string_in_file",
            input: {
              file_path: "docs/story.md",
              old_string: "Delete me\n",
              new_string: ""
            }
          }
        ]
      }
    },
    {
      type: "user",
      uuid: "delete-edit-result",
      sessionId: "claude-delete-edit-session",
      timestamp: "2026-07-01T13:06:02.562Z",
      cwd: workspace,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-delete-edit", content: "Updated docs/story.md" }]
      }
    },
    {
      type: "assistant",
      uuid: "assistant-delete-edit-final",
      sessionId: "claude-delete-edit-session",
      timestamp: "2026-07-01T13:06:03.000Z",
      cwd: workspace,
      message: {
        id: "msg-delete-edit-final",
        role: "assistant",
        model: "deepseek-v4-pro",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "已删除。" }]
      }
    }
  ];
  await writeFile(sessionFile, entries.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

  const snapshots = await captureLatestClaudeTurnSnapshots({
    includeText: true,
    latestOnly: false,
    sessionFile,
    sessionId: "claude-delete-edit-session",
    workspacePath: workspace
  });

  assert.equal(snapshots.length, 1);
  const change = snapshots[0].code_changes[0];
  assert.equal(change.line_number_basis, "absolute");
  assert.equal(change.line_numbers_are_absolute, true);
  assert.equal(change.hunks[0].old_start, 3);
  assert.equal(change.hunks[0].new_start, 3);
  assert.equal(change.hunks[0].lines.find((line) => line.line_type === "removed")?.old_line, 3);
});

test("Claude turn parser marks an unfinished previous turn abandoned when the next real user turn starts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-claude-abandoned-"));
  const sessionFile = join(dir, "claude-session.jsonl");
  const entries = [
    {
      type: "user",
      uuid: "request-one",
      sessionId: "claude-abandoned-session",
      timestamp: "2026-07-01T09:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "看看系统架构" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-one-progress",
      sessionId: "claude-abandoned-session",
      timestamp: "2026-07-01T09:00:05.000Z",
      message: {
        id: "msg-one",
        role: "assistant",
        model: "deepseek-v4-pro",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me explore the system architecture." },
          { type: "tool_use", id: "call-tree", name: "Bash", input: { command: "find . -maxdepth 2 -type f" } }
        ]
      }
    },
    {
      type: "user",
      uuid: "request-two",
      sessionId: "claude-abandoned-session",
      timestamp: "2026-07-01T09:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "你好" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-two",
      sessionId: "claude-abandoned-session",
      timestamp: "2026-07-01T09:01:05.000Z",
      message: {
        id: "msg-two",
        role: "assistant",
        model: "deepseek-v4-pro",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "你好！有什么我可以帮你的吗？" }]
      }
    }
  ];
  await writeFile(sessionFile, entries.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

  const snapshots = await captureLatestClaudeTurnSnapshots({
    includeText: true,
    latestOnly: false,
    sessionFile,
    sessionId: "claude-abandoned-session"
  });

  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.user_message.text), ["看看系统架构", "你好"]);
  assert.equal(snapshots[0].turn.status, "failed");
  assert.equal(snapshots[0].turn.abandoned, true);
  assert.equal(snapshots[0].turn.finish_reason, "next_user_turn_started");
  assert.equal(snapshots[1].turn.status, "completed");
  assert.equal(snapshots[1].assistant_message?.text, "你好！有什么我可以帮你的吗？");
  assert.ok(snapshots[0].source_files.claude_project_jsonl.next_offset < snapshots[1].source_files.claude_project_jsonl.next_offset);
});
