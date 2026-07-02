import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { resolveUserIdentityForTool } from "../plugin-runtime/dist/event-schema.js";
import { commitSnapshot, installGitHooks } from "../plugin-runtime/dist/git.js";

const exec = promisify(execFile);

async function initRepo() {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-git-hook-tool-"));
  await exec("git", ["init"], { cwd: dir });
  return dir;
}

test("installed git hooks default commit snapshots to tool=git while preserving installer", async () => {
  const previousHookTool = process.env.TINYAI_OBS_GIT_HOOK_TOOL;
  delete process.env.TINYAI_OBS_GIT_HOOK_TOOL;
  const dirs = [];

  try {
    for (const installer of ["copilot", "claude", "codex"]) {
      const dir = await initRepo();
      dirs.push(dir);

      await installGitHooks(dir, {
        tool: installer,
        collectorUrl: "http://collector.example",
        fallbackUrls: [],
        pluginVersion: "test-version",
        envFile: join(dir, "tinyai.env")
      });

      const postCommit = await readFile(join(dir, ".git", "hooks", "post-commit"), "utf8");

      assert.match(postCommit, /TINYAI_OBS_GIT_HOOK_TOOL='git'/);
      assert.match(postCommit, /export TINYAI_OBS_TOOL="\$TINYAI_OBS_GIT_HOOK_TOOL"/);
      assert.match(postCommit, new RegExp(`export TINYAI_OBS_HOOK_INSTALLER_TOOL='${installer}'`));
      assert.match(postCommit, /TINYAI_OBS_EVENT_TYPE=commit_snapshot/);
      await assert.rejects(readFile(join(dir, ".git", "hooks", "pre-push"), "utf8"));
    }
  } finally {
    if (previousHookTool === undefined) delete process.env.TINYAI_OBS_GIT_HOOK_TOOL;
    else process.env.TINYAI_OBS_GIT_HOOK_TOOL = previousHookTool;
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test("installed git hooks always use git as the boundary tool", async () => {
  const dir = await initRepo();
  const previousHookTool = process.env.TINYAI_OBS_GIT_HOOK_TOOL;
  process.env.TINYAI_OBS_GIT_HOOK_TOOL = "codex";

  try {
    await installGitHooks(dir, {
      tool: "copilot",
      collectorUrl: "http://collector.example",
      fallbackUrls: [],
      pluginVersion: "test-version",
      envFile: join(dir, "tinyai.env")
    });

    const postCommit = await readFile(join(dir, ".git", "hooks", "post-commit"), "utf8");
    assert.match(postCommit, /TINYAI_OBS_GIT_HOOK_TOOL='git'/);
    assert.doesNotMatch(postCommit, /TINYAI_OBS_GIT_HOOK_TOOL='codex'/);
  } finally {
    if (previousHookTool === undefined) delete process.env.TINYAI_OBS_GIT_HOOK_TOOL;
    else process.env.TINYAI_OBS_GIT_HOOK_TOOL = previousHookTool;
    await rm(dir, { recursive: true, force: true });
  }
});

test("reinstalling git hooks keeps user hook content and only one managed block", async () => {
  const dir = await initRepo();
  const previousHookTool = process.env.TINYAI_OBS_GIT_HOOK_TOOL;
  delete process.env.TINYAI_OBS_GIT_HOOK_TOOL;

  try {
    const hookPath = join(dir, ".git", "hooks", "post-commit");
    await writeFile(hookPath, "#!/bin/sh\necho user-hook\n", "utf8");
    for (const installer of ["copilot", "claude"]) {
      await installGitHooks(dir, {
        tool: installer,
        collectorUrl: "http://collector.example",
        fallbackUrls: [],
        pluginVersion: "test-version",
        envFile: join(dir, "tinyai.env")
      });
    }

    const postCommit = await readFile(hookPath, "utf8");
    assert.match(postCommit, /echo user-hook/);
    assert.equal((postCommit.match(/# >>> TinyAI Observability >>>/g) || []).length, 1);
    assert.equal((postCommit.match(/TINYAI_OBS_EVENT_TYPE=commit_snapshot/g) || []).length, 1);
    assert.match(postCommit, /export TINYAI_OBS_HOOK_INSTALLER_TOOL='claude'/);
    assert.match(postCommit, /TINYAI_OBS_GIT_HOOK_TOOL='git'/);
  } finally {
    if (previousHookTool === undefined) delete process.env.TINYAI_OBS_GIT_HOOK_TOOL;
    else process.env.TINYAI_OBS_GIT_HOOK_TOOL = previousHookTool;
    await rm(dir, { recursive: true, force: true });
  }
});

test("git hook identity can be resolved from the installing plugin configuration", () => {
  const previousTool = process.env.TINYAI_OBS_TOOL;
  const previousUserName = process.env.TINYAI_OBS_COPILOT_USER_NAME;
  const previousUsername = process.env.TINYAI_OBS_COPILOT_USERNAME;
  const previousUserId = process.env.TINYAI_OBS_COPILOT_USER_ID;
  const previousDisplayName = process.env.TINYAI_OBS_COPILOT_USER_DISPLAY_NAME;
  process.env.TINYAI_OBS_TOOL = "git";
  process.env.TINYAI_OBS_COPILOT_USER_NAME = "Plugin User";
  process.env.TINYAI_OBS_COPILOT_USERNAME = "plugin-user";
  process.env.TINYAI_OBS_COPILOT_USER_ID = "plugin-id";
  process.env.TINYAI_OBS_COPILOT_USER_DISPLAY_NAME = "Plugin User";

  try {
    const identity = resolveUserIdentityForTool("copilot");

    assert.equal(identity.username, "plugin-user");
    assert.equal(identity.user_id, "plugin-id");
    assert.equal(identity.user_display_name, "Plugin User");
  } finally {
    if (previousTool === undefined) delete process.env.TINYAI_OBS_TOOL;
    else process.env.TINYAI_OBS_TOOL = previousTool;
    if (previousUserName === undefined) delete process.env.TINYAI_OBS_COPILOT_USER_NAME;
    else process.env.TINYAI_OBS_COPILOT_USER_NAME = previousUserName;
    if (previousUsername === undefined) delete process.env.TINYAI_OBS_COPILOT_USERNAME;
    else process.env.TINYAI_OBS_COPILOT_USERNAME = previousUsername;
    if (previousUserId === undefined) delete process.env.TINYAI_OBS_COPILOT_USER_ID;
    else process.env.TINYAI_OBS_COPILOT_USER_ID = previousUserId;
    if (previousDisplayName === undefined) delete process.env.TINYAI_OBS_COPILOT_USER_DISPLAY_NAME;
    else process.env.TINYAI_OBS_COPILOT_USER_DISPLAY_NAME = previousDisplayName;
  }
});

test("commit snapshots preserve raw git committer identity as payload evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-git-committer-"));
  try {
    await exec("git", ["init"], { cwd: dir });
    await exec("git", ["config", "user.name", "quincy"], { cwd: dir });
    await exec("git", ["config", "user.email", "quincy@example.invalid"], { cwd: dir });
    await writeFile(join(dir, "app.txt"), "hello\n", "utf8");
    await exec("git", ["add", "app.txt"], { cwd: dir });
    await exec("git", ["commit", "-m", "initial"], { cwd: dir });

    const snapshot = await commitSnapshot(dir, "HEAD", { aiAssisted: true });

    assert.equal(snapshot.git_committer_name, "quincy");
    assert.equal(snapshot.git_author_name, "quincy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("post-commit hook uploads git boundary with installer identity and raw git author evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinyai-git-boundary-upload-"));
  const queuePath = join(dir, "git-queue.jsonl");
  const envFile = join(dir, "tinyai.env");

  try {
    await exec("git", ["init"], { cwd: dir });
    await exec("git", ["config", "user.name", "quincy"], { cwd: dir });
    await exec("git", ["config", "user.email", "quincy@example.invalid"], { cwd: dir });
    await writeFile(
      envFile,
      [
        "TINYAI_OBS_COPILOT_USERNAME=lyl",
        "TINYAI_OBS_COPILOT_USER_NAME=lyl",
        "TINYAI_OBS_COPILOT_USER_ID=lyl",
        `TINYAI_OBS_GIT_QUEUE=${queuePath}`,
        ""
      ].join("\n"),
      "utf8"
    );

    await installGitHooks(dir, {
      tool: "copilot",
      collectorUrl: "http://127.0.0.1:9",
      fallbackUrls: ["http://127.0.0.1:9"],
      pluginVersion: "test-version",
      envFile
    });

    await writeFile(join(dir, "app.txt"), "hello\n", "utf8");
    await exec("git", ["add", "app.txt"], { cwd: dir });
    await exec("git", ["commit", "-m", "capture git boundary"], { cwd: dir });

    const queueLine = (await readFile(queuePath, "utf8")).trim().split("\n")[0];
    const queued = JSON.parse(queueLine);
    const batch = queued.batch;
    const event = batch.events[0];

    assert.equal(batch.plugin_name, "tinyai-observability-git-hook");
    assert.equal(batch.username, "lyl");
    assert.equal(batch.user_id, "lyl");
    assert.equal(batch.client_id.length, 32);
    assert.equal(event.tool, "git");
    assert.equal(event.event_type, "commit_snapshot");
    assert.equal(event.username, "lyl");
    assert.equal(event.user_id, "lyl");
    assert.equal(event.payload.hook_tool, "git");
    assert.equal(event.payload.hook_installer_tool, "copilot");
    assert.equal(event.payload.git_author_name, "quincy");
    assert.equal(event.payload.git_committer_name, "quincy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
