CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS builds (
  id          BIGSERIAL PRIMARY KEY,
  job_name    TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ,
  phase       TEXT,
  params      JSONB,
  notes       TEXT
);
CREATE INDEX IF NOT EXISTS builds_started_at_idx ON builds (started_at DESC);

CREATE TABLE IF NOT EXISTS telemetry (
  build_id    BIGINT REFERENCES builds(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL,
  sensor_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  value       DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS telemetry_build_ts_idx ON telemetry (build_id, ts DESC);
CREATE INDEX IF NOT EXISTS telemetry_kind_ts_idx  ON telemetry (kind, ts DESC);

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  build_id    BIGINT REFERENCES builds(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind        TEXT NOT NULL,
  message     TEXT,
  payload     JSONB,
  embedding   vector(768)
);
CREATE INDEX IF NOT EXISTS events_build_ts_idx ON events (build_id, ts DESC);

CREATE TABLE IF NOT EXISTS frames (
  id          BIGSERIAL PRIMARY KEY,
  build_id    BIGINT REFERENCES builds(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind        TEXT NOT NULL,
  path        TEXT NOT NULL,
  embedding   vector(512)
);
CREATE INDEX IF NOT EXISTS frames_build_ts_idx ON frames (build_id, ts DESC);

-- High-frequency raw position events from the plugin's
-- WS /movement/position/stream (firmware native ~1 kHz, event-driven).
-- Separate from telemetry because shape and rate differ; one wide row per
-- sample is far cheaper than 6 skinny rows × 1 kHz.
CREATE TABLE IF NOT EXISTS position_hf (
  build_id    BIGINT REFERENCES builds(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL,
  x           DOUBLE PRECISION,
  y           DOUBLE PRECISION,
  z1          DOUBLE PRECISION,
  z2          DOUBLE PRECISION,
  r           DOUBLE PRECISION,
  has_homed   BOOLEAN
);
CREATE INDEX IF NOT EXISTS position_hf_build_ts_idx ON position_hf (build_id, ts DESC);
