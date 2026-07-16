import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

export const pool = new Pool({ connectionString: config.DATABASE_URL });

export async function applySchema(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(resolve(here, "schema.sql"), "utf8");
  await pool.query(sql);
}
