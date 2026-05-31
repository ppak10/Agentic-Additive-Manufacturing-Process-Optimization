import Fastify from "fastify";
import { config } from "./config.js";
import { applySchema, pool } from "./db/pool.js";
import { startTelemetryRecorder } from "./recorder/telemetry.js";
import { startJobDetector } from "./recorder/job.js";
import { startCameraRecorder } from "./recorder/camera.js";
import { registerRoutes } from "./api/routes.js";

const fastify = Fastify({ logger: true });

const start = async () => {
  await applySchema();
  await registerRoutes(fastify);
  startTelemetryRecorder(fastify.log);
  startJobDetector(fastify.log);
  startCameraRecorder(fastify.log);
  await fastify.listen({ port: config.SERVER_PORT, host: "0.0.0.0" });
};

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  fastify.log.info({ signal }, "shutting down");
  try {
    await fastify.close();
    await pool.end();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

start().catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});
