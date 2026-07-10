#!/usr/bin/env node
// Bootstrap launcher for harness manifests (Claude Code plugin, Gemini
// extension): plugin installs are bare git clones, so install deps on first
// run, then exec the server. npm output is routed to stderr — stdout belongs
// to the MCP JSON-RPC stream.
const { spawn, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

// Deps may be hoisted to a parent (npm workspaces in the monorepo) or local
// (bare clone by a harness) — walk upward for the tsx shim rather than
// assuming a location.
const tsxShim = process.platform === "win32" ? "tsx.cmd" : "tsx";
function findTsx() {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", ".bin", tsxShim);
    if (existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

let tsx = findTsx();
if (tsx === null) {
  const install = spawnSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: root, stdio: ["ignore", 2, 2], shell: process.platform === "win32" },
  );
  if (install.status !== 0) {
    console.error("agentic-sls: npm install failed");
    process.exit(install.status ?? 1);
  }
  tsx = findTsx();
  if (tsx === null) {
    console.error("agentic-sls: tsx not found after npm install");
    process.exit(1);
  }
}
const child = spawn(tsx, [path.join(root, "src", "index.ts")], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 0));
