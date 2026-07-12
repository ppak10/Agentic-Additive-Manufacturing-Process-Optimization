import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult, jsonResult } from "../result.js";

// Curated reference documents (TDS sheets, manufacturer settings, machine
// translation notes, papers) as markdown files with a small frontmatter
// block. At this corpus size an index the agent reads beats search: list
// titles+summaries, fetch by id. Grows into lexical search only if the
// corpus outgrows its index.
//
// Location: KNOWLEDGE_DIR env, falling back to <repo>/knowledge when the
// plugin runs from a repo checkout (the normal case for all four harnesses).

function knowledgeDir(): string {
  if (process.env.KNOWLEDGE_DIR) return process.env.KNOWLEDGE_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "knowledge");
}

interface DocMeta {
  id: string;
  title: string;
  summary: string;
}

function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

async function listDocs(): Promise<DocMeta[]> {
  const dir = knowledgeDir();
  const entries = await readdir(dir, { withFileTypes: true });
  const docs: DocMeta[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md") || e.name === "README.md") {
      continue;
    }
    const text = await readFile(path.join(dir, e.name), "utf8");
    const fm = parseFrontmatter(text);
    docs.push({
      id: e.name.replace(/\.md$/, ""),
      title: fm.title ?? e.name,
      summary: fm.summary ?? "",
    });
  }
  return docs.sort((a, b) => a.id.localeCompare(b.id));
}

export function registerDataReference(server: McpServer) {
  server.registerTool(
    "reference_list",
    {
      title: "List reference documents",
      description:
        "Index of the curated reference corpus: material TDS values, " +
        "manufacturer (Fuse 1) print settings and their translation to the " +
        "Inova, machine conventions, papers. Returns id + title + summary " +
        "for every document; fetch full text with reference_get.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult({ documents: await listDocs() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "reference_get",
    {
      title: "Get a reference document",
      description:
        "Full markdown text of one reference document by id (from " +
        "reference_list).",
      inputSchema: {
        id: z
          .string()
          .regex(/^[\w-]+$/, "document id, not a path")
          .describe("Document id from reference_list"),
      },
    },
    async ({ id }) => {
      try {
        const file = path.join(knowledgeDir(), `${id}.md`);
        const text = await readFile(file, "utf8");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const docs = await listDocs().catch(() => []);
        return errorResult(
          new Error(
            `no document '${id}'. Available: ${docs.map((d) => d.id).join(", ")}`,
          ),
        );
      }
    },
  );
}
