# Codex CLI setup

Codex has no project-level plugin discovery — the MCP server registers in
the global `~/.codex/config.toml`:

```toml
[mcp_servers.agentic-sls]
command = "node"
args = ["/mnt/storage2/GitHub/Agentic-Additive-Manufacturing-Process-Optimization/services/plugins/mcp/scripts/launch-local.cjs"]
```

`codex exec` needs `--dangerously-bypass-approvals-and-sandbox` for MCP
calls (openai/codex#16685) — analyst restraint is prompt-level only.
