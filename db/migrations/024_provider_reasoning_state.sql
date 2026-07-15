CREATE TABLE IF NOT EXISTS provider_reasoning_state (
  record_id TEXT PRIMARY KEY,
  record_kind TEXT NOT NULL CHECK (record_kind IN ('continuation', 'retained_visible')),
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  retention_scope TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_format TEXT,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_reasoning_active_continuation
  ON provider_reasoning_state (session_id, turn_id, provider, model)
  WHERE record_kind = 'continuation';

CREATE INDEX IF NOT EXISTS idx_provider_reasoning_retained_run
  ON provider_reasoning_state (run_id, created_at)
  WHERE record_kind = 'retained_visible';

CREATE INDEX IF NOT EXISTS idx_provider_reasoning_expiry
  ON provider_reasoning_state (expires_at);

CREATE INDEX IF NOT EXISTS idx_provider_reasoning_retention_scope
  ON provider_reasoning_state (retention_scope, record_kind, expires_at);

CREATE TABLE IF NOT EXISTS provider_reasoning_access_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('read', 'delete', 'policy_change')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_provider_reasoning_audit_run_time
  ON provider_reasoning_access_audit (run_id, occurred_at DESC);
