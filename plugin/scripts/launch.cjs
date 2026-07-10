#!/usr/bin/env node
// Bootstrap launcher for harness manifests (Claude Code plugin, Gemini
// extension): plugin installs are bare git clones, so install deps on first
// run, then exec the server. npm output is routed to stderr — stdout belongs
// to the MCP JSON-RPC stream.
const { spawn, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

if (!existsSync(path.join(root, "node_modules"))) {
  const install = spawnSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: root, stdio: ["ignore", 2, 2], shell: process.platform === "win32" },
  );
  if (install.status !== 0) {
    console.error("agentic-sls: npm install failed");
    process.exit(install.status ?? 1);
  }
}

const tsx = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const child = spawn(tsx, [path.join(root, "src", "index.ts")], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 0));
