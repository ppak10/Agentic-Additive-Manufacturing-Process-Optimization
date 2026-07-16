import Fastify from "fastify";
import { config } from "./config.js";
import { applySchema, pool } from "./db/pool.js";
import { startTelemetryRecorder } from "./recorder/telemetry.js";
import { startJobDetector } from "./recorder/job.js";
import { startLayoutRecorder } from "./recorder/feedback.js";
import { startCameraRecorder, startChamberRecorder } from "./recorder/camera.js";
import { startBedMatrixRecorder } from "./recorder/bedmatrix.js";
import { startPositionStreamRecorder } from "./recorder/positionStream.js";
import { markShuttingDown } from "./recorder/state.js";
import { startMemoryMonitor, MEMORY_GUARD_EXIT_CODE } from "./recorder/memory.js";
import { closeAllSpools } from "./recorder/spool.js";
import { recoverPendingSpools } from "./recorder/importer.js";
import { reconcileOrphanBuilds } from "./recorder/lifecycle.js";
import { getLatestPrintingStatus } from "./recorder/job.js";
import { registerRoutes } from "./api/routes.js";

const fastify = Fastify({ logger: true });

const start = async () => {
  await applySchema();
  await registerRoutes(fastify);
  startTelemetryRecorder(fastify.log);
  startJobDetector(fastify.log);
  startLayoutRecorder(fastify.log); // build_layout + layer_objects events (operator-feedback context)
  startChamberRecorder(fastify.log);  // WebSocket stream from plugin (replaces HTTP poll for chamber)
  startCameraRecorder(fastify.log);   // HTTP poll for thermal + galvo
  startBedMatrixRecorder(fastify.log);
  startPositionStreamRecorder(fastify.log);
  // Cleanly bail out when the heap crosses the soft threshold so an
  // external supervisor (server/scripts/run-recorder.sh) can restart with a fresh
  // heap. Distinct exit code so the supervisor can log "memory restart" vs
  // "clean shutdown" separately.
  startMemoryMonitor(fastify.log, () => shutdown("memory-guard"));
  // Spool recovery and orphan-build reconciliation are delayed so the job
  // detector's first polls can re-adopt an in-progress build first —
  // recovering the ACTIVE build's spool would import it mid-print and
  // orphan everything appended afterwards; reconciliation must not close
  // the build the detector is about to adopt.
  setTimeout(() => {
    void recoverPendingSpools(fastify.log);
    void reconcileOrphanBuilds(
      fastify.log,
      getLatestPrintingStatus()?.jobName ?? null,
    ).catch((err) => fastify.log.error({ err }, "reconciliation failed"));
  }, 15_000).unref();
  await fastify.listen({ port: config.SERVER_PORT, host: "0.0.0.0" });
};

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  markShuttingDown(); // recorders see this and skip their pool.query() calls
  fastify.log.info({ signal }, "shutting down");
  try {
    await fastify.close();
    // Brief grace period for recorder loops to observe the shutdown flag
    // and bail out of mid-flight DB calls before we yank the pool out.
    await new Promise((r) => setTimeout(r, 150));
    // Flush buffered spool lines to the NVMe before exiting — an interrupted
    // import is redone on next start (idempotent), but an unflushed spool
    // buffer would be data actually lost.
    await closeAllSpools();
    await pool.end();
  } finally {
    // Non-zero exit when the memory guard triggered so the supervisor
    // script restarts us; zero exit for user-initiated signals so the
    // supervisor stops.
    process.exit(signal === "memory-guard" ? MEMORY_GUARD_EXIT_CODE : 0);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

start().catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});
