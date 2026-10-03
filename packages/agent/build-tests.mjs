import { build } from "esbuild";
import fs from "node:fs";

const entryPoints = fs
  .readdirSync("test")
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `test/${f}`);

await build({
  entryPoints,
  outdir: "dist-test",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: "inline",
  external: ["ws"],
  logLevel: "info",
});
console.log("agent tests bundled to dist-test/");
