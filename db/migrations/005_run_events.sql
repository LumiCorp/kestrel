CREATE TABLE IF NOT EXISTS run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  step_index INTEGER,
  event_type TEXT NOT NULL,
  level TEXT NOT NULL,
  metadata_json JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_time
  ON run_events(run_id, occurred_at, id);

CREATE INDEX IF NOT EXISTS idx_run_events_session_time
  ON run_events(session_id, occurred_at, id);
