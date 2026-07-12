// Tests for the reference_* tools and agent_actions logging.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeActionLog, logAction, truncateForLog } from "../src/actions.js";
import { registerDataReference } from "../src/data/reference.js";

describe("truncateForLog", () => {
  test("passes small values through untouched", () => {
    assert.deepEqual(truncateForLog({ a: 1 }), { a: 1 });
  });

  test("replaces oversized values with a marked prefix", () => {
    const big = { blob: "x".repeat(10_000) };
    const out = truncateForLog(big, 100) as { truncated: boolean; prefix: string };
    assert.equal(out.truncated, true);
    assert.ok(out.prefix.length <= 100);
  });
});

describe("reference tools", () => {
  let dir: string;
  let client: Client;

  test("setup", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "knowledge-"));
    await writeFile(
      path.join(dir, "alpha-doc.md"),
      "---\ntitle: Alpha\nsummary: First test doc.\n---\n\n# Alpha body\n",
    );
    await writeFile(path.join(dir, "no-frontmatter.md"), "# Bare doc\n");
    await writeFile(path.join(dir, "README.md"), "# excluded\n");
    process.env.KNOWLEDGE_DIR = dir;

    const server = new McpServer({ name: "t", version: "0" });
    registerDataReference(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t-client", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  async function call(name: string, args: Record<string, unknown>) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
    return { isError: !!res.isError, text };
  }

  test("reference_list indexes frontmatter and excludes README", async () => {
    const { text } = await call("reference_list", {});
    const body = JSON.parse(text);
    const ids = body.documents.map((d: { id: string }) => d.id);
    assert.deepEqual(ids, ["alpha-doc", "no-frontmatter"]);
    const alpha = body.documents[0];
    assert.equal(alpha.title, "Alpha");
    assert.equal(alpha.summary, "First test doc.");
  });

  test("reference_get returns full markdown", async () => {
    const { isError, text } = await call("reference_get", { id: "alpha-doc" });
    assert.equal(isError, false);
    assert.ok(text.includes("# Alpha body"));
  });

  test("unknown id errors and names available docs", async () => {
    const { isError, text } = await call("reference_get", { id: "nope" });
    assert.equal(isError, true);
    assert.ok(text.includes("alpha-doc"));
  });

  test("path traversal ids are rejected by the schema", async () => {
    const res = await client.callTool({
      name: "reference_get",
      arguments: { id: "../secret" },
    });
    assert.equal(res.isError, true);
  });

  test("teardown", async () => {
    delete process.env.KNOWLEDGE_DIR;
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });
});

const DB = !!process.env.DATABASE_URL;

describe("agent_actions logging", { skip: !DB && "DATABASE_URL not set" }, () => {
  test("logAction inserts a row with harness and parsed result", async () => {
    const fakeServer = {
      server: { getClientVersion: () => ({ name: "test-harness", version: "0" }) },
    } as never;
    await logAction(fakeServer, "recoater_passes_set", { value: 3 }, {
      content: [{ type: "text", text: '{"ok": true}' }],
    });

    const pg = (await import("pg")).default;
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      const { rows } = await c.query(
        `SELECT * FROM agent_actions
         WHERE harness = 'test-harness' ORDER BY id DESC LIMIT 1`,
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tool, "recoater_passes_set");
      assert.deepEqual(rows[0].arguments, { value: 3 });
      assert.deepEqual(rows[0].result, { ok: true });
      assert.equal(rows[0].is_error, false);
      await c.query("DELETE FROM agent_actions WHERE harness = 'test-harness'");
    } finally {
      await c.end();
      await closeActionLog();
    }
  });
});
