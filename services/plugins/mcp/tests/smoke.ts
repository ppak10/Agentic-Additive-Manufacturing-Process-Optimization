// Stdio round-trip smoke test: spawn the server, list tools, exercise the
// read-only tools against the live Inova API. Set-tools are only invoked in
// ways designed to be REJECTED by their guards (and chosen so that even a
// broken guard could not mutate anything) — safe to run mid-print.
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
  "setup_overrides_get",
  "setup_overrides_set",
  "job_list",
  "job_get",
  "job_set",
  "job_create_from_template",
  "profile_list",
  "profile_get",
  "profile_set",
  "powder_tuning_status",
  "powder_tuning_print_setup",
  "powder_tuning_bed_level",
  "powder_tuning_add_layer",
  "powder_tuning_set_surface",
  "powder_tuning_select_patch",
  "powder_tuning_print_patch",
  "powder_tuning_stop",
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
  "setup_overrides_get",
  "job_list",
  "profile_list",
  "powder_tuning_status",
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

// Powder-tuning guards. Schema-level rejections (out-of-range values) fail
// before any HTTP request, so they are safe regardless of session state; the
// SDK may surface them as a thrown InvalidParams error rather than isError.
async function expectRejected(name: string, args: Record<string, unknown>) {
  try {
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) {
      console.log(`ok   ${name} rejected ${JSON.stringify(args)}`);
    } else {
      console.error(`FAIL ${name} guard did not reject: ${JSON.stringify(args)}`);
      failures += 1;
    }
  } catch {
    console.log(`ok   ${name} rejected ${JSON.stringify(args)} (schema)`);
  }
}
await expectRejected("powder_tuning_set_surface", { temperature: 500 });
await expectRejected("powder_tuning_select_patch", { grid_index: -1 });
await expectRejected("powder_tuning_print_patch", { laser_on_percent: 150 });

// Only when no session is active: the no-session 400 must gate every
// powder-tuning command. print_setup is the probe — it cannot fire the laser
// even if the gate were broken and a session started concurrently.
{
  const st = await client.callTool({ name: "powder_tuning_status", arguments: {} });
  const active = !st.isError && (JSON.parse(
    ((st.content as Array<{ text?: string }>)?.[0]?.text ?? "{}"),
  ) as { data?: { isActive?: boolean } }).data?.isActive;
  if (active) {
    console.log("skip powder-tuning no-session guard (session is active)");
  } else {
    const res = await client.callTool({ name: "powder_tuning_print_setup", arguments: {} });
    if (res.isError) console.log("ok   powder_tuning_print_setup rejected without a session");
    else {
      console.error("FAIL powder_tuning_print_setup succeeded without a session");
      failures += 1;
    }
  }
}

// Jobs tools — dynamic on the live job list. Guard calls are chosen so a
// BROKEN guard still cannot mutate: the "[TEMPLATE]"-name guard uses a
// nonexistent job id (would 404 before patching), the template-read-only
// guard re-sends the template's current profile id (idempotent), and the
// non-template clone uses a nonexistent profile id (profile validation
// would reject before cloning).
function firstText(res: { content?: unknown }): string {
  return ((res.content as Array<{ text?: string }>)?.[0]?.text ?? "");
}

const jobListRes = await client.callTool({ name: "job_list", arguments: {} });
const jobList = jobListRes.isError
  ? []
  : (JSON.parse(firstText(jobListRes)) as Array<{
      id: string;
      name: string;
      is_template: boolean;
    }>);

if (jobList.length === 0) {
  console.log("skip jobs detail/guards (no stored jobs)");
} else {
  const detailRes = await client.callTool({
    name: "job_get",
    arguments: { job_id: jobList[0].id },
  });
  if (detailRes.isError) {
    console.error(`FAIL job_get: ${firstText(detailRes)}`);
    failures += 1;
  } else {
    console.log(`ok   job_get ${jobList[0].id}: ${firstText(detailRes).slice(0, 80).replace(/\s+/g, " ")}…`);
  }

  // name guard: nonexistent job, so even a broken guard just 404s
  const nameGuard = await client.callTool({
    name: "job_set",
    arguments: {
      job_id: "00000000-0000-0000-0000-000000000000",
      name: "[TEMPLATE] smoke",
    },
  });
  if (nameGuard.isError) console.log("ok   job_set rejected [TEMPLATE] name");
  else {
    console.error("FAIL job_set accepted a [TEMPLATE] name");
    failures += 1;
  }

  const template = jobList.find((j) => j.is_template);
  if (template) {
    const detail = JSON.parse(
      firstText(await client.callTool({ name: "job_get", arguments: { job_id: template.id } })),
    ) as { printProfileId: string | null };
    const tmplGuard = await client.callTool({
      name: "job_set",
      arguments: {
        job_id: template.id,
        print_profile_id: detail.printProfileId ?? "",
      },
    });
    if (tmplGuard.isError) console.log("ok   job_set rejected template mutation");
    else {
      console.error("FAIL job_set mutated a template");
      failures += 1;
    }
  } else {
    console.log("skip template-read-only guard (no [TEMPLATE] job stored)");
  }

  // Profile guardrails — same safety construction: the bounds guard uses a
  // nonexistent id (a broken guard would just 404), the Default guard
  // re-sends the Default's current name (idempotent if broken).
  const profListRes = await client.callTool({ name: "profile_list", arguments: {} });
  const profList = profListRes.isError
    ? []
    : (JSON.parse(firstText(profListRes)) as Array<{ id: string; name: string; isDefault: boolean }>);
  const dfltProf = profList.find((p) => p.isDefault);

  if (profList.length > 0) {
    const pg = await client.callTool({
      name: "profile_get",
      arguments: { profile_id: profList[0].id, merged: true },
    });
    if (pg.isError) {
      console.error(`FAIL profile_get: ${firstText(pg)}`);
      failures += 1;
    } else {
      console.log(`ok   profile_get ${profList[0].name}: ${firstText(pg).slice(0, 80).replace(/\s+/g, " ")}…`);
    }

    const bounds = await client.callTool({
      name: "profile_set",
      arguments: {
        profile_id: "00000000-0000-0000-0000-000000000000",
        fields: { surfaceTarget: 500 },
      },
    });
    if (bounds.isError) console.log("ok   profile_set rejected out-of-range surfaceTarget=500");
    else {
      console.error("FAIL profile_set accepted surfaceTarget=500");
      failures += 1;
    }

    if (dfltProf) {
      const dg = await client.callTool({
        name: "profile_set",
        arguments: { profile_id: dfltProf.id, name: dfltProf.name },
      });
      if (dg.isError) console.log("ok   profile_set rejected the system Default");
      else {
        console.error("FAIL profile_set mutated the system Default");
        failures += 1;
      }
    }
  } else {
    console.log("skip profile guards (no profiles listed)");
  }

  const nonTemplate = jobList.find((j) => !j.is_template);
  if (nonTemplate) {
    const cloneGuard = await client.callTool({
      name: "job_create_from_template",
      arguments: {
        template_job_id: nonTemplate.id,
        print_profile_id: "00000000-0000-0000-0000-000000000000",
      },
    });
    if (cloneGuard.isError) console.log("ok   job_create_from_template rejected non-template source");
    else {
      console.error("FAIL job_create_from_template cloned a non-template");
      failures += 1;
    }
  } else {
    console.log("skip non-template clone guard (all stored jobs are templates)");
  }
}

await client.close();
process.exit(failures > 0 ? 1 : 0);
