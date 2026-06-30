import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildClaudeBashDeltaPayload,
  captureClaudeBashSnapshot,
  claudeWorkspaceDiffPathCandidates,
  hasClaudeExternalWriteSignal
} from "../plugin-runtime/dist/index.js";

test("Claude workspace fallback ignores IDE context paths and keeps only terminal write targets", () => {
  const snapshot = {
    code_changes: [],
    tool_calls: [
      {
        tool_name: "run_in_terminal",
        arguments_raw: {
          command: [
            "python3 - <<'PY'",
            "from pathlib import Path",
            "Path('/Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/hotel_aggregator/src/main/java/BubbleSort.java').write_text('class BubbleSort {}')",
            "PY"
          ].join("\n")
        },
        result_raw: "created BubbleSort.java"
      }
    ],
    process_steps: [
      {
        step_type: "context",
        text: "IDE 当前文件：/Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs/刘芸隆.md"
      }
    ]
  };

  assert.equal(hasClaudeExternalWriteSignal(snapshot), true);
  assert.deepEqual(claudeWorkspaceDiffPathCandidates(snapshot), [
    "/Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/hotel_aggregator/src/main/java/BubbleSort.java"
  ]);
});

test("Claude workspace fallback does not run for read-only terminal commands", () => {
  const snapshot = {
    code_changes: [],
    tool_calls: [
      {
        tool_name: "run_in_terminal",
        arguments_raw: {
          command: "ls /Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs/刘芸隆.md"
        }
      }
    ],
    process_steps: [
      {
        step_type: "context",
        text: "IDE 当前文件：/Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs/刘芸隆.md"
      }
    ]
  };

  assert.equal(hasClaudeExternalWriteSignal(snapshot), false);
  assert.deepEqual(claudeWorkspaceDiffPathCandidates(snapshot), []);
});

test("Claude workspace fallback ignores read-only command output that mentions modified files", () => {
  const snapshot = {
    code_changes: [],
    tool_calls: [
      {
        tool_name: "run_in_terminal",
        arguments_raw: {
          command: "git status --short"
        },
        result_raw: " M openspec/specs/刘芸隆.md\n?? hotel_aggregator/src/main/java/BubbleSort.java"
      }
    ]
  };

  assert.equal(hasClaudeExternalWriteSignal(snapshot), false);
  assert.deepEqual(claudeWorkspaceDiffPathCandidates(snapshot), []);
});

test("Claude workspace fallback ignores stderr redirection in read-only find commands", () => {
  const snapshot = {
    code_changes: [],
    tool_calls: [
      {
        tool_name: "run_in_terminal",
        arguments_raw: {
          command: "find /Users/user/code/ai-observability -name \"刘芸隆.md\" 2>/dev/null"
        },
        result_raw: "/Users/user/code/ai-observability/刘芸隆.md"
      }
    ]
  };

  assert.equal(hasClaudeExternalWriteSignal(snapshot), false);
  assert.deepEqual(claudeWorkspaceDiffPathCandidates(snapshot), []);
});

test("Claude bash delta captures only changes made after the command baseline", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "tinyai-claude-bash-delta-"));
  const filePath = join(workspace, "app.py");
  await writeFile(filePath, "base\nold dirty\n", "utf8");

  const before = await captureClaudeBashSnapshot(workspace, {
    command: "echo 'new from bash' >> app.py",
    toolCallId: "tool-bash-1"
  });
  await appendFile(filePath, "new from bash\n", "utf8");

  const payload = await buildClaudeBashDeltaPayload(workspace, before, {
    command: "echo 'new from bash' >> app.py",
    sessionId: "session-bash",
    requestId: "request-bash",
    responseId: "response-bash",
    turnIndex: 2,
    toolCallId: "tool-bash-1"
  });

  assert.ok(payload);
  assert.equal(payload.snapshot_kind, "claude_turn_bash_delta");
  assert.equal(payload.capture_strategy, "bash_pre_post_delta_v1");
  assert.equal(payload.files_changed, 1);
  assert.equal(payload.lines_added, 1);
  assert.equal(payload.lines_deleted, 0);
  assert.deepEqual(payload.file_paths, ["app.py"]);
  assert.equal(payload.files[0].file_path, "app.py");
  assert.equal(payload.files[0].hunks[0].lines.some((line) => line.line_type === "added" && line.text === "new from bash"), true);
  assert.equal(payload.files[0].hunks[0].lines.some((line) => line.line_type === "added" && line.text === "old dirty"), false);
});

test("Claude bash delta returns no code payload for read-only commands with no file changes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "tinyai-claude-bash-readonly-"));
  await writeFile(join(workspace, "README.md"), "hello\n", "utf8");

  const before = await captureClaudeBashSnapshot(workspace, {
    command: "cat README.md",
    toolCallId: "tool-bash-readonly"
  });
  const payload = await buildClaudeBashDeltaPayload(workspace, before, {
    command: "cat README.md",
    sessionId: "session-bash",
    toolCallId: "tool-bash-readonly"
  });

  assert.equal(payload, undefined);
});

test("Claude bash delta ignores directory paths from read-only ls commands", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "tinyai-claude-bash-dir-"));
  await mkdir(join(workspace, "plugins", "claude-code"), { recursive: true });
  await writeFile(join(workspace, "plugins", "claude-code", "README.md"), "hello\n", "utf8");
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

  const before = await captureClaudeBashSnapshot(workspace, {
    command: "ls -la plugins/",
    toolCallId: "tool-bash-ls-dir",
    extraPaths: ["plugins"]
  });
  const payload = await buildClaudeBashDeltaPayload(workspace, before, {
    command: "ls -la plugins/",
    sessionId: "session-bash",
    toolCallId: "tool-bash-ls-dir"
  });

  assert.equal(payload, undefined);
});
