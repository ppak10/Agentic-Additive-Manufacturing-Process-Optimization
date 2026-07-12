// Read-only Postgres access for the data_* knowledge tools.
//
// The pool is lazy: the MCP server starts fine without DATABASE_URL and the
// printer-control tools keep working — only the data tools error, with a
// message that says what to set. Every connection is forced read-only and
// statement-capped server-side, so no tool (including db_query) can write
// or run away.
import pg from "pg";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. The data_* tools query the recorder's " +
          "Postgres, e.g. postgres://inova:...@localhost:5432/inova",
      );
    }
    pool = new pg.Pool({
      connectionString: url,
      max: 3,
      options:
        "-c default_transaction_read_only=on -c statement_timeout=10000",
    });
  }
  return pool;
}

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<R[]> {
  const res = await getPool().query<R>(sql, params);
  return res.rows;
}
