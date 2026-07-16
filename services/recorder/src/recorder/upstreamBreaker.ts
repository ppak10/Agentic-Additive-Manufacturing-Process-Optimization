// Per-upstream circuit breaker. When a fetch to a given upstream host fails,
// subsequent calls are short-circuited for OPEN_MS until something tries to
// re-probe. This caps the cost of an outage: at 24fps × 3 cameras × N tabs +
// recorder polling, we were issuing hundreds of fetches/sec against a dead
// host, each spawning a socket attempt and allocating a TypeError with a
// multi-line stack — that pattern OOMed the dev server twice.
//
// Keyed by host:port so the firmware (port 80) and the plugin (port 5001)
// trip independently — one can be down while the other is reachable.

const OPEN_MS = 2_000;

const openUntil = new Map<string, number>();

export function isUpstreamOpen(urlOrBase: string): boolean {
  const key = hostKey(urlOrBase);
  const until = openUntil.get(key);
  return until !== undefined && Date.now() < until;
}

export function tripUpstream(urlOrBase: string): void {
  openUntil.set(hostKey(urlOrBase), Date.now() + OPEN_MS);
}

export function clearUpstream(urlOrBase: string): void {
  openUntil.delete(hostKey(urlOrBase));
}

function hostKey(s: string): string {
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return s;
  }
}
