let buildId: number | null = null;
let shuttingDown = false;

export function currentBuildId(): number | null {
  return buildId;
}

export function setCurrentBuildId(id: number | null): void {
  buildId = id;
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
