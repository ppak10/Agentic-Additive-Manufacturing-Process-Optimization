import { applySchema, pool } from "./pool.js";

await applySchema();
console.log("schema applied");
await pool.end();
