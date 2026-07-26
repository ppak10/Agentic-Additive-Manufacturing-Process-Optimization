let buildId: number | null = null;
let shuttingDown = false;

export function currentBuildId(): number | null {
  return buildId;
}

export function setCurrentBuildId(id: number | null): void {
  buildId = id;
}

// Frames (chamber/thermal/galvo) and the high-frequency galvo position stream
// are spooled ONLY during the printing phase (firmware phase "Layers") — the
// heavy visual/scan data is worthless (and out-of-distribution for the defect
// model) during Heating/BedPreparation/PrintCap/Cooling. Scalar telemetry
// (incl. all temperatures) is deliberately NOT gated by this: it records across
// the whole build so the heating ramp + cooldown thermal history is preserved.
// Set by the job detector (job.ts) on each phase transition.
let framesRecording = false;

export function isFramesRecording(): boolean {
  return framesRecording;
}

export function setFramesRecording(active: boolean): void {
  framesRecording = active;
}

// Shared shutdown signal — recorders check this before issuing pool.query()
// so they don't race the pool.end() in the shutdown handler. Set once,
// process.exit() makes it irrelevant after that.
export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function markShuttingDown(): void {
  shuttingDown = true;
}
