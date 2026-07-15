#!/usr/bin/env bash
# run-recorder.sh — Supervisor loop for the Node.js recorder.
#
# Restarts the recorder on non-zero exit (memory-guard trip, unexpected
# crash) and stops on clean exit (user SIGINT/SIGTERM). Sets NODE_OPTIONS
# with a large heap ceiling and RECORDER_MEMORY_GUARD=1 so the in-process
# memory monitor can trigger a graceful bail-out before hitting the ceiling.
#
# Rationale: `npm run dev` alone will happily OOM after ~5 hours of runtime
# because of the slow leak (WebSocket subscribers / camera buffers, most
# likely). This wrapper turns that into a self-healing restart until the
# real leak is fixed.
#
# Usage:
#   server/scripts/run-recorder.sh                # default 12GB heap
#   HEAP_MB=16384 server/scripts/run-recorder.sh  # override
#
# Distinguishes:
#   exit 0                  → clean shutdown (SIGINT/SIGTERM) — supervisor stops
#   exit 101 (guard trip)   → memory soft-limit — supervisor restarts
#   any other non-zero exit → unexpected crash — supervisor restarts after backoff

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="${SCRIPT_DIR}/.."

# Singleton guard: multiple supervisors mean multiple recorders fighting
# over the port (the losers crash-loop forever). flock on a lockfile makes
# a second invocation exit immediately instead.
# Lock stays at the repo root so pre-move and post-move invocations
# can never run concurrently.
LOCKFILE="${SCRIPT_DIR}/../../.run-recorder.lock"
exec 9>"${LOCKFILE}"
if ! flock -n 9; then
    echo "run-recorder.sh is already running (lock held on ${LOCKFILE}) — exiting."
    exit 1
fi

HEAP_MB="${HEAP_MB:-12288}"
BACKOFF_SECONDS="${BACKOFF_SECONDS:-3}"
MEMORY_GUARD_EXIT_CODE=101

export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${HEAP_MB}"
export RECORDER_MEMORY_GUARD=1

cd "${SERVER_DIR}"

restart_count=0
while true; do
    started_at="$(date -Iseconds)"
    echo "[$(date -Iseconds)] recorder starting (heap=${HEAP_MB}MB, restart #${restart_count})"
    npm run dev
    code=$?
    ended_at="$(date -Iseconds)"

    if [[ $code -eq 0 ]]; then
        echo "[${ended_at}] recorder exited cleanly (code 0) — supervisor stopping"
        break
    fi

    if [[ $code -eq ${MEMORY_GUARD_EXIT_CODE} ]]; then
        echo "[${ended_at}] recorder tripped memory guard (code ${code}, started ${started_at}) — restarting"
    else
        echo "[${ended_at}] recorder crashed (code ${code}, started ${started_at}) — restarting after ${BACKOFF_SECONDS}s backoff"
        sleep "${BACKOFF_SECONDS}"
    fi

    restart_count=$((restart_count + 1))
done
