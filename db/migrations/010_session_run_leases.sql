ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS active_run_id TEXT,
  ADD COLUMN IF NOT EXISTS active_run_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sessions_active_run_id
  ON sessions(active_run_id)
  WHERE active_run_id IS NOT NULL;
