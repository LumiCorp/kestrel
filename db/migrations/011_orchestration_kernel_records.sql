CREATE TABLE IF NOT EXISTS orchestration_threads (
  thread_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_thread_id TEXT REFERENCES orchestration_threads(thread_id) ON DELETE SET NULL,
  active_run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
  current_request_id TEXT,
  last_run_status TEXT,
  wait_for_json JSONB,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orchestration_threads_session_id
  ON orchestration_threads(session_id);

CREATE INDEX IF NOT EXISTS idx_orchestration_threads_parent_thread_id
  ON orchestration_threads(parent_thread_id)
  WHERE parent_thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orchestration_threads_status
  ON orchestration_threads(status);

CREATE TABLE IF NOT EXISTS orchestration_delegations (
  delegation_id TEXT PRIMARY KEY,
  parent_thread_id TEXT NOT NULL REFERENCES orchestration_threads(thread_id) ON DELETE CASCADE,
  child_thread_id TEXT NOT NULL REFERENCES orchestration_threads(thread_id) ON DELETE CASCADE,
  parent_run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  profile_id TEXT,
  provider TEXT,
  model TEXT,
  skill_pack_id TEXT,
  launched_by TEXT,
  wait_event_type TEXT,
  result_summary TEXT,
  error_message TEXT,
  result_contract TEXT,
  policy_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestration_delegations_child_thread_id
  ON orchestration_delegations(child_thread_id);

CREATE INDEX IF NOT EXISTS idx_orchestration_delegations_parent_thread_id
  ON orchestration_delegations(parent_thread_id);

CREATE INDEX IF NOT EXISTS idx_orchestration_delegations_status
  ON orchestration_delegations(status);

CREATE TABLE IF NOT EXISTS orchestration_interaction_requests (
  request_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES orchestration_threads(thread_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  event_type TEXT NOT NULL,
  delegation_id TEXT REFERENCES orchestration_delegations(delegation_id) ON DELETE SET NULL,
  wait_kind TEXT,
  prompt TEXT,
  metadata_json JSONB,
  response_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orchestration_interaction_requests_thread_id
  ON orchestration_interaction_requests(thread_id);

CREATE INDEX IF NOT EXISTS idx_orchestration_interaction_requests_delegation_id
  ON orchestration_interaction_requests(delegation_id)
  WHERE delegation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orchestration_interaction_requests_status
  ON orchestration_interaction_requests(status);

CREATE TABLE IF NOT EXISTS orchestration_approval_grants (
  grant_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES orchestration_threads(thread_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES orchestration_interaction_requests(request_id) ON DELETE CASCADE,
  delegation_id TEXT REFERENCES orchestration_delegations(delegation_id) ON DELETE SET NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  allowed_tool_classes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_capabilities_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ,
  issued_by TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata_json JSONB
);

CREATE INDEX IF NOT EXISTS idx_orchestration_approval_grants_thread_id
  ON orchestration_approval_grants(thread_id);

CREATE INDEX IF NOT EXISTS idx_orchestration_approval_grants_request_id
  ON orchestration_approval_grants(request_id);

CREATE INDEX IF NOT EXISTS idx_orchestration_approval_grants_status
  ON orchestration_approval_grants(status);

CREATE TABLE IF NOT EXISTS orchestration_context_summary_artifacts (
  artifact_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES orchestration_threads(thread_id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  source TEXT NOT NULL,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orchestration_context_summary_artifacts_thread_id
  ON orchestration_context_summary_artifacts(thread_id);

CREATE TABLE IF NOT EXISTS orchestration_thread_compaction_events (
  event_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES orchestration_threads(thread_id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  summary_artifact_id TEXT REFERENCES orchestration_context_summary_artifacts(artifact_id) ON DELETE SET NULL,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orchestration_thread_compaction_events_thread_id
  ON orchestration_thread_compaction_events(thread_id);
