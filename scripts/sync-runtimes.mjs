import { createHash } from "node:crypto";
import { cp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const source = new URL("plugin-runtime/dist/", root);
const targets = [
  new URL("plugins/claude-code/runtime/dist/", root),
  new URL("plugins/codex/plugins/observability/runtime/dist/", root),
  new URL("plugins/vscode-copilot/dist/", root)
];

async function files(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) output.push(...await files(join(dir, entry.name), relative));
    else output.push(relative);
  }
  return output.sort();
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const sourcePath = source.pathname;
const sourceFiles = await files(sourcePath);
for (const target of targets) {
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  const targetFiles = await files(target.pathname);
  if (JSON.stringify(targetFiles) !== JSON.stringify(sourceFiles)) {
    throw new Error(`Runtime file list mismatch: ${target.pathname}`);
  }
  for (const relative of sourceFiles) {
    const [sourceHash, targetHash] = await Promise.all([
      digest(join(sourcePath, relative)),
      digest(join(target.pathname, relative))
    ]);
    if (sourceHash !== targetHash) throw new Error(`Runtime hash mismatch: ${target.pathname}${relative}`);
  }
  console.log(`Synced ${sourceFiles.length} runtime files to ${target.pathname}`);
}
