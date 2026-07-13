#!/usr/bin/env node
// Repo-local launcher: loads the parent repo's .env (DATABASE_URL for the
// knowledge tools + action log) and sets KNOWLEDGE_DIR before starting the
// MCP server. Harness manifests on this machine point here so every harness
// gets identical tools AND identical env — required for the harness
// comparison. Published-package consumers keep using launch.cjs and set env
// themselves.
const { readFileSync, existsSync } = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");

const envFile = path.join(repoRoot, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
process.env.KNOWLEDGE_DIR ??= path.join(repoRoot, "knowledge");

require("./launch.cjs");
