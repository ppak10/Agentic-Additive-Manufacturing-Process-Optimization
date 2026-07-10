#!/usr/bin/env node
// agentic-sls MCP server — stdio transport. All logging goes to stderr so
// nothing can corrupt the JSON-RPC stream on stdout.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InovaClient } from "./client.js";
import { registerPrinterStatus } from "./printer/status.js";
import { registerRecoaterPasses } from "./recoater/passes.js";
import { registerRecoaterFullPasses } from "./recoater/full.js";
import { registerLayerOverrides } from "./recoater/overrides.js";

const server = new McpServer({ name: "agentic-sls", version: "0.1.0" });
const client = new InovaClient();

registerPrinterStatus(server, client);
registerRecoaterPasses(server, client);
registerRecoaterFullPasses(server, client);
registerLayerOverrides(server, client);

await server.connect(new StdioServerTransport());
console.error(
  `agentic-sls MCP server ready (Inova API: ${process.env.INOVA_API_BASE_URL ?? "http://192.168.1.146:5001"})`,
);
