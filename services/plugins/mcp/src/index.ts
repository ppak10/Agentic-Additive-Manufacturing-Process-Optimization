#!/usr/bin/env node
// agentic-sls MCP server — stdio transport. All logging goes to stderr so
// nothing can corrupt the JSON-RPC stream on stdout.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InovaClient } from "./client.js";
import { registerPrinterStatus } from "./printer/status.js";
import { registerPrintingObjects } from "./printer/objects.js";
import { registerPrinterJobs } from "./printer/jobs.js";
import { registerPrinterProfiles } from "./printer/profiles.js";
import { registerPrinterArtifacts } from "./printer/artifacts.js";
import { registerRecoaterPasses } from "./recoater/passes.js";
import { registerRecoaterFullPasses } from "./recoater/full.js";
import { registerLayerOverrides } from "./recoater/overrides.js";
import { registerDataBuilds } from "./data/builds.js";
import { registerDataAstm } from "./data/astm.js";
import { registerDataTelemetry } from "./data/telemetry.js";
import { registerDataQuery } from "./data/query.js";
import { registerDataReference } from "./data/reference.js";

const server = new McpServer({ name: "agentic-sls", version: "0.1.0" });
const client = new InovaClient();

// Control tools — live printer, need INOVA_API_BASE_URL.
registerPrinterStatus(server, client);
registerPrintingObjects(server, client);
registerRecoaterPasses(server, client);
registerRecoaterFullPasses(server, client);
registerLayerOverrides(server, client);
registerPrinterJobs(server, client);
registerPrinterProfiles(server, client);
registerPrinterArtifacts(server, client);

// Knowledge tools — recorder Postgres, need DATABASE_URL (read-only).
registerDataBuilds(server);
registerDataAstm(server);
registerDataTelemetry(server);
registerDataQuery(server);
registerDataReference(server);

await server.connect(new StdioServerTransport());
console.error(
  `agentic-sls MCP server ready (Inova API: ${process.env.INOVA_API_BASE_URL ?? "http://192.168.1.146:5001"})`,
);
