import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runtimeHook = await readFile("plugin-runtime/src/hook.ts", "utf8");
const runtimeMcp = await readFile("plugin-runtime/src/mcp-server.ts", "utf8");
const copilotExtension = await readFile("plugins/vscode-copilot/src/extension.ts", "utf8");

test("snapshot capture paths do not emit duplicate activity or file-read events", () => {
  for (const source of [runtimeHook, runtimeMcp, copilotExtension]) {
    assert.doesNotMatch(source, /eventType:\s*"agent_activity"/);
    assert.doesNotMatch(source, /eventType:\s*"file_read"/);
  }
  assert.doesNotMatch(copilotExtension, /copilot:task_start:/);
  assert.doesNotMatch(copilotExtension, /ensureTask\("copilot_local_transcript"\)/);
});

test("ordinary official spec reads remain spec_read events", () => {
  assert.doesNotMatch(runtimeMcp, /spec_scope\s*===\s*"official"\s*\?\s*"official_misread"/);
  assert.doesNotMatch(copilotExtension, /spec_scope\s*===\s*"official"\s*\?\s*"official_misread"/);
  assert.match(runtimeMcp, /"official_misread"/);
  assert.match(copilotExtension, /"official_misread"/);
});

test("VS Code plugin auto-installs non-destructive Git hooks for commit attribution", async () => {
  const runtimeGit = await readFile("plugin-runtime/src/git.ts", "utf8");
  const packageJson = await readFile("plugins/vscode-copilot/package.json", "utf8");

  assert.match(packageJson, /"tinyaiObservability\.autoInstallGitHooks"/);
  assert.match(packageJson, /"default":\s*true/);
  assert.match(copilotExtension, /autoInstallGitHooks:\s*cfg\.get<boolean>\("autoInstallGitHooks"\)\s*\?\?\s*true/);
  assert.match(copilotExtension, /installGitHooksForWorkspace\(\{\s*silent:\s*true,\s*emitHeartbeat:\s*false\s*\}\)/);

  assert.doesNotMatch(runtimeGit, /TINYAI_OBS_EVENT_TYPE=ai_line_snapshot/);
  assert.doesNotMatch(runtimeGit, /TINYAI_OBS_STAGED_ONLY='1'/);
  assert.match(runtimeGit, /TINYAI_OBS_EVENT_TYPE=commit_snapshot/);
  assert.match(runtimeGit, /TINYAI_OBS_EVENT_TYPE=push_snapshot/);
  assert.match(runtimeGit, /removeManagedHook\(preCommitPath\)/);
  assert.match(runtimeGit, /TINYAI_HOOK_BEGIN/);
  assert.match(runtimeGit, /writeManagedHook/);
});
