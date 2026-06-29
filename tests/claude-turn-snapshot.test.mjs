import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

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
