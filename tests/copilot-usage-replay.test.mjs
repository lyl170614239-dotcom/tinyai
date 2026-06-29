import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseCopilotRequestUsage } from "../plugin-runtime/dist/copilot-usage.js";

const fixtureUrl = new URL("./fixtures/copilot-request-usage.jsonl", import.meta.url);

async function fixtureEntries() {
  return (await readFile(fixtureUrl, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
}

test("replays Copilot Initial/Set/Push request usage", async () => {
  const parsed = parseCopilotRequestUsage(await fixtureEntries());
  assert.equal(parsed.sessionId, "copilot-fixture-session");
  assert.equal(parsed.title, "系统目录列表");
  assert.equal(parsed.startedAt, "2026-06-22T11:58:49.846Z");
  assert.equal(parsed.resolvedModel, "claude-sonnet-4-6");
  assert.equal(parsed.requestCount, 3);
  assert.deepEqual(parsed.usageTotals, {
    prompt_tokens: 91494,
    output_tokens: 2736,
    completion_tokens: 4098,
    elapsed_ms: 85247,
    copilot_credits: 24.1
  });
  assert.equal(parsed.requestUsage[0].elapsed_ms, 19462);
  assert.equal(parsed.requestUsage[0].credits_source, "details");
  assert.equal(parsed.requestUsage[2].completion_tokens, 2600);
});

test("does not overwrite known usage with incomplete patches", () => {
  const parsed = parseCopilotRequestUsage([
    {
      kind: 0,
      v: {
        sessionId: "partial",
        requests: [{
          requestId: "request-partial",
          promptTokens: 12,
          outputTokens: 5,
          elapsedMs: 90,
          copilotCredits: 1.25
        }]
      }
    },
    { kind: 1, k: ["requests", 0, "result"], v: { metadata: { resolvedModel: "gpt-5" } } }
  ]);
  assert.deepEqual(parsed.requestUsage[0], {
    request_id: "request-partial",
    request_index: 0,
    model: "gpt-5",
    prompt_tokens: 12,
    output_tokens: 5,
    elapsed_ms: 90,
    copilot_credits: 1.25,
    credits_source: "direct"
  });
});
