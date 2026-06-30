import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { buildClaudeBashDeltaPayload, captureClaudeBashSnapshot } from "../plugin-runtime/dist/index.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  await execFileAsync("git", ["-c", "user.name=TinyAI Test", "-c", "user.email=tinyai@example.com", ...args], { cwd });
}

test("Claude bash delta ignores files already missing before the command", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "tinyai-claude-bash-delta-"));
  try {
    await git(workspace, ["init"]);
    await mkdir(join(workspace, "plugins", "claude-code"), { recursive: true });
    const packagePath = join(workspace, "plugins", "claude-code", "tinyai-claude-code-observability-plugin-0.1.4.tgz");
    await writeFile(packagePath, Buffer.from([0, 1, 2, 3, 4, 5]));
    await git(workspace, ["add", "."]);
    await git(workspace, ["commit", "-m", "add package"]);
    await rm(packagePath);

    const before = await captureClaudeBashSnapshot(workspace, {
      command: "ls plugins/claude-code",
      toolCallId: "tool-1"
    });
    const delta = await buildClaudeBashDeltaPayload(workspace, before, {
      command: "ls plugins/claude-code",
      sessionId: "session-1",
      toolCallId: "tool-1",
      occurredAt: "2026-06-30T10:00:00.000Z"
    });

    assert.equal(delta, undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
