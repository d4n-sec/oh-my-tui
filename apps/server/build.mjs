import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const external = [
  "fastify",
  "@fastify/cookie",
  "@fastify/static",
  "@fastify/websocket",
  "ssh2",
  "ws",
  // Native/edge Web Crypto usage; keep it out of the bundle so Node resolves its
  // own copy (and its optional metadata deps) at runtime.
  "@simplewebauthn/server",
];

await build({
  entryPoints: ["src/index.ts", "src/cli.ts", "src/admin.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  external,
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});

// Ship the built frontend with the package so a global npm install serves the
// UI without a separate asset path.
const webSrc = path.resolve("../web/dist");
const webDst = path.resolve("dist/web");
if (fs.existsSync(webSrc)) {
  fs.rmSync(webDst, { recursive: true, force: true });
  fs.cpSync(webSrc, webDst, { recursive: true });
  console.log("copied web assets to dist/web");
} else {
  console.warn("warning: apps/web/dist not found; build the web workspace first");
}

fs.chmodSync("dist/cli.js", 0o755);
console.log("server bundles written to dist/");
