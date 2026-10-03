import { build } from "esbuild";
import { chmodSync } from "node:fs";

const result = await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  external: ["ws"],
  logLevel: "info",
});

if (result.errors.length > 0) {
  process.exit(1);
}
chmodSync("dist/cli.js", 0o755);
console.log("agent bundle written to dist/cli.js");
