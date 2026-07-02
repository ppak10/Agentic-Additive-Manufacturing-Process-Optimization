import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { resolve } from "node:path";
import { homedir } from "node:os";

loadEnv({ path: resolve(process.cwd(), "../.env") });
loadEnv();

const schema = z.object({
  DATABASE_URL: z.string().url(),
  INOVA_API_BASE_URL: z.string().url().default("http://192.168.1.146:5001"),
  INOVA_FIRMWARE_BASE_URL: z.string().url().default("http://192.168.1.146"),
  SERVER_PORT: z.coerce.number().int().positive().default(3000),
  TELEMETRY_HZ: z.coerce.number().positive().default(10),
  CAMERA_HZ: z.coerce.number().positive().default(15),
  // Galvo camera rate. Split from CAMERA_HZ so the chamber and galvo can be
  // tuned independently — their content, frame sizes, and typical usefulness
  // to downstream ML differ enough that one knob was a mistake.
  GALVO_HZ: z.coerce.number().positive().default(10),
  THERMAL_HZ: z.coerce.number().positive().default(5),
  FRAMES_DIR: z.string().default("./data/frames"),
  // Print-time ingest spool. Must live on the fast disk (NVMe root partition),
  // NOT under data/ on the SMR storage drive — the point of the spool is to
  // keep the print-time write path off that disk. Contents are imported into
  // Postgres after each build ends (see recorder/importer.ts).
  SPOOL_DIR: z.string().default(resolve(homedir(), ".agentic-sls/spool")),
});

export const config = schema.parse(process.env);
export type Config = typeof config;
