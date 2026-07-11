CREATE TABLE IF NOT EXISTS conversation_turns (
  turn_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES orchestration_threads(thread_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  root_run_id TEXT,
  status TEXT NOT NULL,
  initial_event_type TEXT NOT NULL,
  active_run_id TEXT,
  terminal_run_id TEXT,
  terminal_status TEXT,
  metadata_json JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_thread_updated
  ON conversation_turns(thread_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_session_updated
  ON conversation_turns(session_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_status
  ON conversation_turns(status);

CREATE TABLE IF NOT EXISTS conversation_turn_segments (
  segment_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES orchestration_threads(thread_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_type TEXT NOT NULL,
  request_id TEXT,
  grant_id TEXT,
  message_hash TEXT NOT NULL,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_turn_segments_turn_time
  ON conversation_turn_segments(turn_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_conversation_turn_segments_run_id
  ON conversation_turn_segments(run_id);

CREATE TABLE IF NOT EXISTS model_call_provenance (
  call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  thread_id TEXT,
  turn_id TEXT REFERENCES conversation_turns(turn_id) ON DELETE SET NULL,
  step_index INTEGER,
  step_agent TEXT,
  phase TEXT,
  model TEXT,
  provider TEXT,
  response_format TEXT,
  schema_name TEXT,
  provider_payload_hash TEXT NOT NULL,
  component_hash TEXT NOT NULL,
  template_ids_json JSONB,
  tool_manifest_hash TEXT,
  assembly_id TEXT,
  source_bucket_hashes_json JSONB,
  metadata_json JSONB,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_model_call_provenance_run_time
  ON model_call_provenance(run_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_model_call_provenance_turn_time
  ON model_call_provenance(turn_id, created_at ASC)
  WHERE turn_id IS NOT NULL;
