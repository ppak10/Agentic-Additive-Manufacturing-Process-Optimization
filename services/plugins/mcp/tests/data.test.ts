// Tests for the data_* knowledge tools.
//
// Unit tests (always run): the gateSql guard.
// Integration tests (skip without DATABASE_URL): the tools end-to-end over
// an in-memory MCP transport against the live recorder Postgres — safe, the
// pool forces read-only transactions.
//
//   npm test          (from plugin/; loads DATABASE_URL from the caller env)
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDataAstm } from "../src/data/astm.js";
import { registerDataBuilds } from "../src/data/builds.js";
import { gateSql, registerDataQuery } from "../src/data/query.js";
import { registerDataTelemetry } from "../src/data/telemetry.js";

describe("gateSql", () => {
  test("accepts a plain SELECT", () => {
    assert.equal(gateSql("SELECT 1"), "SELECT 1");
  });

  test("accepts WITH and lowercase, strips trailing semicolon", () => {
    assert.equal(
      gateSql("  with t as (select 1) select * from t; "),
      "with t as (select 1) select * from t",
    );
  });

  test("rejects DML and DDL", () => {
    for (const sql of [
      "DELETE FROM builds",
      "UPDATE builds SET notes = 'x'",
      "INSERT INTO builds DEFAULT VALUES",
      "DROP TABLE builds",
      "TRUNCATE builds",
      "EXPLAIN ANALYZE DELETE FROM builds",
    ]) {
      assert.throws(() => gateSql(sql), /only SELECT\/WITH/);
    }
  });

  test("rejects multi-statement", () => {
    assert.throws(
      () => gateSql("SELECT 1; DELETE FROM builds"),
      /multiple statements/,
    );
  });

  test("selectish prefixes don't fool the word boundary", () => {
    assert.throws(() => gateSql("selectivity_test()"), /only SELECT\/WITH/);
  });
});

// ---------------------------------------------------------------------------

const DB = !!process.env.DATABASE_URL;

describe("data tools (integration)", { skip: !DB && "DATABASE_URL not set" }, () => {
  let client: Client;

  test("setup", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerDataBuilds(server);
    registerDataAstm(server);
    registerDataTelemetry(server);
    registerDataQuery(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t-client", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  async function call(name: string, args: Record<string, unknown>) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
    return { isError: !!res.isError, body: res.isError ? text : JSON.parse(text) };
  }

  test("astm_query default grouping returns SLS batches with stats", async () => {
    const { isError, body } = await call("astm_query", {
      standard: "D638",
      material_class: "SLS",
    });
    assert.equal(isError, false);
    const batches = body.groups.map((g: { batch_label: string }) => g.batch_label);
    assert.ok(batches.includes("A") && batches.includes("H"));
    const total = body.groups.reduce(
      (s: number, g: { n: string }) => s + Number(g.n),
      0,
    );
    assert.equal(total, 54); // all D638 SLS specimens
    const h = body.groups.find((g: { batch_label: string }) => g.batch_label === "H");
    assert.ok(Number(h.modulus_mpa_mean) > 2000); // stiffest batch
  });

  test("astm_query include_specimens returns metric rows without curves", async () => {
    const { body } = await call("astm_query", {
      standard: "D638",
      batch: "A",
      include_specimens: true,
    });
    assert.equal(body.specimens.length, 5);
    assert.ok("modulus_pa" in body.specimens[0]);
    assert.ok(!("curves" in body.specimens[0]));
  });

  test("astm_query grouped by profile names the profile", async () => {
    const { body } = await call("astm_query", {
      material_class: "SLS",
      group_by: "profile",
    });
    assert.ok(
      body.groups.some((g: { profile_name?: string }) =>
        g.profile_name?.includes("mJ/mm"),
      ),
    );
  });

  test("telemetry_summary windows the layer array", async () => {
    const { body } = await call("telemetry_summary", {
      build_id: 12,
      layer_range: [3, 5],
    });
    assert.equal(body.layers.length, 3);
    assert.equal(body.layers[0].recoat, 3);
    assert.ok(body.temps.printBed);
  });

  test("telemetry_summary unknown build returns a helpful error object", async () => {
    const { isError, body } = await call("telemetry_summary", {
      build_id: 999999,
    });
    assert.equal(isError, false);
    assert.match(body.error, /no summary/);
  });

  test("builds_list responds with a bounded catalog", async () => {
    const { isError, body } = await call("builds_list", { limit: 5 });
    assert.equal(isError, false);
    assert.ok(body.count <= 5);
  });

  test("db_query caps rows and reports truncation", async () => {
    const { body } = await call("db_query", {
      sql: "SELECT generate_series(1, 50) AS n",
      max_rows: 10,
    });
    assert.equal(body.count, 10);
    assert.equal(body.truncated, true);
  });

  test("db_query data-modifying CTE is stopped by the read-only backstop", async () => {
    // Passes the SELECT/WITH regex on purpose — this asserts defense in
    // depth: Postgres rejects it (top-level-CTE rule / read-only txn).
    const { isError } = await call("db_query", {
      sql: "WITH d AS (DELETE FROM builds RETURNING id) SELECT * FROM d",
    });
    assert.equal(isError, true);
  });

  test("teardown", async () => {
    await client.close();
    // The pg pool holds the event loop open; tests are done, let go.
    const { getPool } = await import("../src/db.js");
    await getPool().end();
  });
});
