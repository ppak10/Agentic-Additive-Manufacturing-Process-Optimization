import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), "../.env") });
loadEnv();

const schema = z.object({
  DATABASE_URL: z.string().url(),
  INOVA_API_BASE_URL: z.string().url().default("http://192.168.1.146:5001"),
  INOVA_FIRMWARE_BASE_URL: z.string().url().default("http://192.168.1.146"),
  SERVER_PORT: z.coerce.number().int().positive().default(3000),
  TELEMETRY_HZ: z.coerce.number().positive().default(10),
  CAMERA_HZ: z.coerce.number().positive().default(5),
  THERMAL_HZ: z.coerce.number().positive().default(2),
  FRAMES_DIR: z.string().default("./data/frames"),
});

export const config = schema.parse(process.env);
export type Config = typeof config;
