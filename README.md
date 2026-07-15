# Agentic-Additive-Manufacturing-Process-Optimization
Process optimization of Inova Mk1 from SLS4All

## Data layout (for analysts and downstream consumers)

The recorder writes to a Postgres database in the `agentic-sls-postgres`
container and to image files under `data/frames/`. The canonical schema
is `server/src/db/schema.sql` — read that file for the authoritative table
definitions, column types, and indexes.

### Tables

| Table              | Cardinality        | Source                                                                 |
| ------------------ | ------------------ | ---------------------------------------------------------------------- |
| `builds`           | one per print run  | recorder, on session start/end                                         |
| `telemetry`        | ~10 Hz per sensor  | recorder polling the Inova plugin REST API                             |
| `position_hf`      | ~1 kHz             | plugin WebSocket `/movement/position/stream` (firmware-native rate)    |
| `frames`           | ~5 Hz (chamber)    | recorder polling firmware HTTP endpoints; image bytes on disk          |
| `events`           | sparse             | recorder, on state transitions                                         |

Sample rates are configured in `.env` (`TELEMETRY_HZ`, `CAMERA_HZ`,
`THERMAL_HZ`). `position_hf` is event-driven from the firmware and not
rate-limited by the recorder.

### Sensor identifiers and units

`telemetry.sensor_id` and `telemetry.kind` are free-form strings populated
by the upstream Inova plugin. The exporter (see below) writes a
`data/exports/sensors.csv` enumerating every distinct `(sensor_id, kind)`
pair observed in the DB, with empty `unit` and `description` columns for
human annotation. Treat that CSV as the authoritative units glossary
once filled in.

### Frames on disk

Image files live at `data/frames/{build_id}/{ts_ms}_{kind}.{ext}` where
`kind` is one of `chamber`, `galvo`, or `thermal`. The `frames` table
holds one row per file with `(build_id, ts, kind, path)`; the path
column points back to the file on disk.

### Flat-file exports

`sls-export` (`agentic_sls/pipeline/export.py`) dumps the Postgres
tables to flat files under
`data/exports/` so downstream consumers can work without a running
container. Layout:

```
data/exports/
  builds.jsonl
  events.jsonl                  (embedding column dropped)
  frames.jsonl                  (embedding column dropped)
  build_to_inova_session.csv    (sidecar; manual mapping to Inova-Mk1-Database)
  sensors.csv                   (sidecar; (sensor_id, kind) glossary)
  telemetry/{build_id}.parquet
  position_hf/{build_id}.parquet
```

The exporter is idempotent: existing parquet files are skipped unless
`--force`, and sidecar CSVs preserve hand-filled values across re-runs.
By default only completed builds (`ended_at IS NOT NULL`) are exported;
pass `--include-active` to also export the open build.

```sh
uv run sls-export
uv run sls-export --builds 1,2
uv run sls-export --out /tmp/exports --force
```

Dependencies come from the root `pyproject.toml` (`uv sync`).
