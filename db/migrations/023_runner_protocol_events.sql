CREATE TABLE IF NOT EXISTS runner_protocol_events (
  sequence BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  run_id TEXT,
  session_id TEXT,
  thread_id TEXT,
  command_id TEXT,
  event_json JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runner_protocol_events_run_sequence
  ON runner_protocol_events (run_id, sequence);

CREATE INDEX IF NOT EXISTS idx_runner_protocol_events_session_sequence
  ON runner_protocol_events (session_id, sequence);

CREATE INDEX IF NOT EXISTS idx_runner_protocol_events_thread_sequence
  ON runner_protocol_events (thread_id, sequence);
