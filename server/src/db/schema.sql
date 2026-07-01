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

-- Every CodeCommand the slicer issues to ICodePlotter, captured by the
-- LoggingCodePlotter decorator in the plugin and streamed over the plugin's
-- WS /plotter/commands/stream. One row per command — recognized ops (MOVE_XY,
-- SET_LASER) have parsed args; everything else lands in `raw` for audit.
-- (build_id, layer_idx, cmd_idx) is not unique — a plugin restart mid-build
-- bumps buildEpoch and resets cmd_idx, producing benign overlap.
CREATE TABLE IF NOT EXISTS plotter_commands (
  build_id    BIGINT REFERENCES builds(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL,
  layer_idx   INT NOT NULL,
  cmd_idx     INT NOT NULL,
  op          TEXT NOT NULL,
  x           REAL,
  y           REAL,
  laser       REAL,
  speed       REAL,
  raw         TEXT
);
CREATE INDEX IF NOT EXISTS plotter_commands_build_layer_idx
  ON plotter_commands (build_id, layer_idx, cmd_idx);
CREATE INDEX IF NOT EXISTS plotter_commands_build_ts_idx
  ON plotter_commands (build_id, ts DESC);

-- Health of the recording pipeline, as classified by /api/health/recording.
-- One row inserted on every state transition (RECORDING → PRINTING_NOT_RECORDING,
-- etc.). Lets us reconstruct outages after the fact without correlating gaps in
-- telemetry/frames — the reason someone printed while the recorder was down is
-- exactly the case this table exists to answer.
CREATE TABLE IF NOT EXISTS recording_health_events (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_state  TEXT,
  new_state   TEXT NOT NULL,
  reason      TEXT,
  detail      JSONB
);
CREATE INDEX IF NOT EXISTS recording_health_events_ts_idx
  ON recording_health_events (ts DESC);
