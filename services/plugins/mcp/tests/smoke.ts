// Stdio round-trip smoke test: spawn the server, list tools, exercise the
// read-only tools against the live Inova API. Never calls a set-tool — this
// is safe to run mid-print.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_TOOLS = [
  "printer_status",
  "recoater_passes_get",
  "recoater_passes_set",
  "recoater_full_passes_get",
  "recoater_full_passes_set",
  "layer_overrides_get",
  "layer_overrides_set",
  "builds_list",
  "build_get",
  "astm_query",
  "telemetry_summary",
  "db_query",
  "reference_list",
  "reference_get",
];

const READ_ONLY_TOOLS = [
  "printer_status",
  "recoater_passes_get",
  "recoater_full_passes_get",
  "layer_overrides_get",
];

// Knowledge tools hit the recorder Postgres (DATABASE_URL), not the printer
// — also read-only, also safe mid-print.
const DATA_CALLS: Array<[string, Record<string, unknown>]> = [
  ["builds_list", { printed_only: true }],
  ["build_get", { build_id: 12 }],
  ["astm_query", { standard: "D638" }],
  ["astm_query", { material_class: "SLS", group_by: "profile" }],
  ["telemetry_summary", { build_id: 12, layer_range: [1, 5] }],
  ["db_query", { sql: "SELECT count(*) AS n FROM astm_specimens" }],
  ["reference_list", {}],
  ["reference_get", { id: "fuse1-to-inova-translation" }],
];

// Must be rejected by the db_query gate.
const DATA_GUARDS: Array<[string, Record<string, unknown>]> = [
  ["db_query", { sql: "DELETE FROM builds" }],
  ["db_query", { sql: "SELECT 1; DELETE FROM builds" }],
];

// Spawn through launch.cjs — the same entry point every harness manifest
// uses — so the smoke test also covers dep resolution/bootstrap.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(pluginRoot, "scripts", "launch.cjs")],
  env: { ...process.env } as Record<string, string>,
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
if (missing.length > 0) {
  console.error(`FAIL missing tools: ${missing.join(", ")} (got: ${names.join(", ")})`);
  process.exit(1);
}
console.log(`tools ok (${names.length}): ${names.join(", ")}`);

let failures = 0;
for (const name of READ_ONLY_TOOLS) {
  const res = await client.callTool({ name, arguments: {} });
  const first = (res.content as Array<{ type: string; text?: string }>)[0];
  if (res.isError) {
    console.error(`FAIL ${name}: ${first?.text}`);
    failures += 1;
  } else {
    console.log(`ok   ${name}: ${first?.text?.slice(0, 120).replace(/\s+/g, " ")}…`);
  }
}

for (const [name, args] of DATA_CALLS) {
  const res = await client.callTool({ name, arguments: args });
  const first = (res.content as Array<{ type: string; text?: string }>)[0];
  if (res.isError) {
    console.error(`FAIL ${name} ${JSON.stringify(args)}: ${first?.text}`);
    failures += 1;
  } else {
    console.log(`ok   ${name} ${JSON.stringify(args)}: ${first?.text?.slice(0, 100).replace(/\s+/g, " ")}…`);
  }
}

for (const [name, args] of DATA_GUARDS) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) {
    console.log(`ok   ${name} rejected ${JSON.stringify(args)}`);
  } else {
    console.error(`FAIL ${name} guard did not reject: ${JSON.stringify(args)}`);
    failures += 1;
  }
}

await client.close();
process.exit(failures > 0 ? 1 : 0);
