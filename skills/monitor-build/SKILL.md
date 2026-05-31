---
name: monitor-build
description: Use when starting, inspecting, or interpreting the live Inova MK1 build monitor — the loop that polls /api/status + the chamber camera and writes NDJSON + JPEGs under builds/.
---

# Monitor a Build

## Overview

The Inova MK1 monitor is a Python loop in `src/agentic_sls/inova/__main__.py` that polls two HTTP endpoints on the printer at a fixed interval and writes everything to `<project>/builds/`:

- `GET /api/status` → one JSON line appended to `builds/status.ndjson`
- `GET /api/videocamera/image/<uuid>?c=<n>` → one JPEG written to `builds/images/<uuid>/<c:06d>.jpg`

Default interval is **1 second**. Default camera is `basehexv3`. Default output is `<project>/builds/`. Frame counter auto-resumes from the highest existing JPEG number, so restarting the monitor will not overwrite earlier frames.

## When to Use

- User asks to start, stop, or restart monitoring for a build.
- User asks "how is the print going" or "show me the last frame".
- You're triaging whether the monitor is keeping up with its 1 Hz target.
- You're looking at `builds/status.ndjson` and need to interpret it.

## Starting the Monitor

Run from the project root, in the background so the conversation stays interactive:

```
uv run python -m agentic_sls.inova
```

Use `Bash(run_in_background=true)`. The first stderr line confirms the configuration:

```
monitor: url=http://192.168.1.146 camera=basehexv3 interval=1.0s start_c=<N> out_dir=<project>/builds
```

Each successful poll prints `poll #<c> isPrinting=<bool> img=<bytes>B` to stderr.

Verify the process is alive and writing:

```
ps -o pid,etime,cmd --no-headers -C python | grep agentic_sls.inova
tail -n 3 builds/status.ndjson
```

## Stopping the Monitor

Find the python PID (not the `uv` wrapper PID — that one will respawn briefly on TERM) and send it `SIGTERM`:

```
pkill -TERM -f "python -m agentic_sls.inova"
```

The loop catches KeyboardInterrupt and exits cleanly; the NDJSON line for the in-flight poll has already been flushed by then.

## Reading `status.ndjson`

Each line is a self-contained JSON object:

```json
{"ts": "2026-05-25T19:20:20.012345Z", "c": 0, "kind": "poll",
 "status": {"isPrinting": true, ...},
 "image_path": "images/basehexv3/000000.jpg", "image_bytes": 19687}
```

Useful one-liners:

| Question | Command |
|---|---|
| How many polls so far? | `wc -l builds/status.ndjson` |
| What's the latest state? | `tail -n 1 builds/status.ndjson \| jq` |
| Any errors logged? | `grep -E '"(status_error\|image_error)"' builds/status.ndjson \| wc -l` |
| Distribution of image sizes? | `jq -r '.image_bytes // empty' builds/status.ndjson \| sort -n \| uniq -c \| tail` |

## Anomaly Checks

Healthy state at 1 Hz looks like:

- Poll-to-poll wall-clock delta: **~1.01 s median** (1 s sleep + ~10 ms HTTP work).
- JPEG sizes: **8–42 KB**, median ~20 KB.
- `status_error` / `image_error` keys: **absent**.
- `isPrinting` flag stable for the duration of an active build.

Red flags worth surfacing to the user:

1. **Delta > 2 s sustained** — printer is slow to respond or the polling process is starved. Check CPU on the dev box and Kestrel response time on the printer.
2. **`image_bytes` collapsing to < 5 KB** — chamber camera lost the build surface (lid opened, light flicker, occlusion).
3. **`status_error`/`image_error` appearing** — almost always a network blip or the printer process restarting. One-off entries are fine; a run of them is not.
4. **`isPrinting` flipping false mid-run** — print was aborted, paused by an interlock, or completed early. Stop and tell the user.
5. **Frame counter resetting to 0** — somebody started a second monitor without auto-resume; old frames are about to be overwritten. Investigate before continuing.

## Storage Projections

At 1 Hz with median 20 KB JPEGs:

- ~20 KB/s → **~72 MB/hour** → ~1.7 GB/day.
- NDJSON itself is negligible (a few hundred bytes per line).

Long prints (multi-day) should bump the interval (e.g. `--interval 5`) or downsample after the fact. Don't silently change the default — confirm with the user first.

## What This Skill Does NOT Cover

- Per-print grouping under `builds/<session_id>/` — pending the `sessions.py` module.
- Heater / thermistor / MLX90640 readings — those live in the printer's log files, pending `logs.py`.
- Cumulative laser/halogen wear — pending `wear.py`.

If the user asks about any of those, say the module isn't built yet rather than scraping ad-hoc over SSH.
