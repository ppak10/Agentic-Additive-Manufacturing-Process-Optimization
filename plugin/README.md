# agentic-sls MCP plugin

MCP server + per-harness packaging for agentic process control of the SLS4All
Inova MK1 — printer status, recoater passes (staged + full-recoat), and
mid-print layer overrides, backed by the
[Inova-API-Plugin](../sls4all/Inova-API-Plugin) on port 5001.

One core, four harnesses: the MCP server (`src/`) is harness-agnostic; each
harness gets a thin manifest or config snippet.

```
plugin/
├── src/                    # MCP server (TypeScript, stdio)
├── scripts/launch.cjs      # bootstrap launcher (npm install on first run)
├── .claude-plugin/         # Claude Code plugin manifest
├── skills/                 # SKILL.md workflows (Claude Code; OpenCode-compatible)
├── AGENTS.md               # canonical agent context (OpenCode/Codex/Antigravity)
└── tests/smoke.ts          # stdio round-trip smoke test (GET-only)
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `INOVA_API_BASE_URL` | `http://192.168.1.146:5001` | Inova-API-Plugin base URL |

## Running directly

```bash
npm install
npm run dev        # tsx src/index.ts (stdio — for harnesses, not terminals)
npm run smoke      # spawns the server, lists tools, calls read-only tools
npm run typecheck
```

Published entry point (after `npm publish`): `npx -y @ppak10/agentic-sls-mcp`.

## Harness setup

### Claude Code (plugin)

```
/plugin marketplace add ppak10/Agentic-Additive-Manufacturing-Process-Optimization
/plugin install agentic-sls@agentic-sls --scope user
```

Then `/reload-plugins` and verify with `/mcp`. Skills under `skills/` ship
with the plugin.

### OpenCode

The repo's project plugin (`.opencode/plugins/agentic-sls.ts`) registers this
server automatically when running OpenCode inside this repo. For other
projects, add to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agentic-sls": {
      "type": "local",
      "command": ["node", "/path/to/repo/plugin/scripts/launch.cjs"],
      "enabled": true
    }
  }
}
```

Note OpenCode's shape: `command` is a single array (no `args`), env goes under
`environment`. OpenCode reads Claude-format skills — point `skills.paths` at
`plugin/skills/` (the project plugin does this) — and picks up `AGENTS.md`
from the project root.

### Codex CLI

```bash
codex mcp add agentic-sls -- node /path/to/repo/plugin/scripts/launch.cjs
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.agentic-sls]
command = "node"
args = ["/path/to/repo/plugin/scripts/launch.cjs"]

[mcp_servers.agentic-sls.env]
INOVA_API_BASE_URL = "http://192.168.1.146:5001"
```

Verify with `/mcp` inside Codex. Codex reads `AGENTS.md` from the project
root. TODO: package as a Codex plugin (`.codex-plugin/plugin.json`) once we
target their marketplace — see developers.openai.com/codex/plugins.

### Antigravity (CLI + IDE)

Antigravity (which absorbed Gemini CLI) reads MCP servers from
`~/.gemini/config/mcp_config.json` (shared by IDE and CLI; auto-reloads):

```json
{
  "mcpServers": {
    "agentic-sls": {
      "command": "node",
      "args": ["/path/to/repo/plugin/scripts/launch.cjs"],
      "env": { "INOVA_API_BASE_URL": "http://192.168.1.146:5001" }
    }
  }
}
```

The repo-root `gemini-extension.json` remains for the legacy Gemini CLI
extension path and Antigravity's extension-import tooling; `AGENTS.md` is the
preferred context file (GEMINI.md is legacy-supported).

## Local models

Any OpenAI-compatible endpoint works with OpenCode; declare the provider in
`opencode.json` and enable a tool-call parser on the serving side (e.g. vLLM
`--enable-auto-tool-choice --tool-call-parser <hermes|qwen|llama>`).

## Safety model

All set-tools mutate a live print (server-side validation, all-or-nothing
batches, effect on next layer). The tool descriptions and
`skills/recoater-control/SKILL.md` carry the operational semantics — keep them
in sync with the Inova-API-Plugin endpoints.
