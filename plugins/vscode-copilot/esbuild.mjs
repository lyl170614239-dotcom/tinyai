import { build } from "esbuild";
import { cp } from "node:fs/promises";

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "esm",
  target: "node18",
  external: ["vscode"],
  sourcemap: false
});

await cp("../../plugin-runtime/dist", "dist", { recursive: true });
