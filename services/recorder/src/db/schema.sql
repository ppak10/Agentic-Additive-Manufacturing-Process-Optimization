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

-- Firmware PrintSession UUID for this build — the bridge between recorder
-- build ids and the firmware's job/profile world (PrintSessions carry JobId
-- and ProfileId). Backfilled for historical builds by
-- agentic_sls/pipeline/match_build_sessions.py; stamped live at print start once the
-- plugin exposes the active session.
ALTER TABLE builds ADD COLUMN IF NOT EXISTS inova_session_id UUID;

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

-- Health of the recording pipeline, as classified by /api/health/recording.
-- One row inserted on every state transition (RECORDING → PRINTING_NOT_RECORDING,
-- etc.). Lets us reconstruct outages after the fact without correlating gaps in
-- telemetry/frames — the reason someone printed while the recorder was down is
-- exactly the case this table exists to answer.
-- Operator-measured calibrations, append-only: latest row per kind is
-- current; history stays because old builds must be interpreted with the
-- calibration active at record time (build_layout events snapshot it).
-- kinds: 'plotter_to_camera' {quad, k1, model} (Mission Control Align);
--        'thermal_to_plotter' {quad, model} (thermal grid corners in
--        plotter uv; flat MainBox seed until a thermal align mode exists).
CREATE TABLE IF NOT EXISTS calibrations (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  source     TEXT,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calibrations_kind_idx ON calibrations (kind, id DESC);

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
