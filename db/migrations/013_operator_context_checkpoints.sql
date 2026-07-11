CREATE TABLE IF NOT EXISTS orchestration_context_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES orchestration_threads(thread_id) ON DELETE CASCADE,
  run_id TEXT,
  status TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  reason TEXT NOT NULL,
  signals_json JSONB,
  metadata_json JSONB,
  resolution_action TEXT,
  resolved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orchestration_context_checkpoints_thread_id
  ON orchestration_context_checkpoints(thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orchestration_context_checkpoints_status
  ON orchestration_context_checkpoints(status);
