CREATE TABLE IF NOT EXISTS orchestration_operator_focus (
  session_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES orchestration_threads(thread_id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_orchestration_operator_focus_thread_id
  ON orchestration_operator_focus(thread_id);

CREATE TABLE IF NOT EXISTS orchestration_operator_attention (
  attention_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES orchestration_threads(thread_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  checkpoint_id TEXT REFERENCES orchestration_context_checkpoints(checkpoint_id) ON DELETE CASCADE,
  delegation_id TEXT REFERENCES orchestration_delegations(delegation_id) ON DELETE CASCADE,
  child_thread_id TEXT REFERENCES orchestration_threads(thread_id) ON DELETE CASCADE,
  recommended_action TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orchestration_operator_attention_session_id
  ON orchestration_operator_attention(session_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_orchestration_operator_attention_thread_id
  ON orchestration_operator_attention(thread_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_orchestration_operator_attention_status
  ON orchestration_operator_attention(status, updated_at DESC);
