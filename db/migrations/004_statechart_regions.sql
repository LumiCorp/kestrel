ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS legacy_readonly BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS active_state_parent TEXT,
  ADD COLUMN IF NOT EXISTS active_state_child TEXT,
  ADD COLUMN IF NOT EXISTS active_region TEXT;

ALTER TABLE session_versions
  ADD COLUMN IF NOT EXISTS state_node_json JSONB;

CREATE TABLE IF NOT EXISTS region_work_items (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  region TEXT NOT NULL,
  step_agent TEXT NOT NULL,
  state_node_json JSONB,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_region_work_items_session_status
  ON region_work_items(session_id, status, created_at);
