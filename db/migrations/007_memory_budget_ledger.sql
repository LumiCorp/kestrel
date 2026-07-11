CREATE TABLE IF NOT EXISTS memory_budget_ledger (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  memory_json JSONB,
  budget_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_budget_ledger_run_step
  ON memory_budget_ledger(run_id, step_index);
