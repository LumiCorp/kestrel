CREATE TABLE IF NOT EXISTS orchestration_assembly_bundles (
  bundle_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  tool_allowlist_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  specialist_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  context_policy_id TEXT,
  approval_policy_id TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orchestration_assembly_bundles_source
  ON orchestration_assembly_bundles(source);

CREATE TABLE IF NOT EXISTS orchestration_thread_assembly_records (
  record_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES orchestration_threads(thread_id) ON DELETE CASCADE,
  bundle_id TEXT NOT NULL,
  cause TEXT NOT NULL,
  authority TEXT NOT NULL,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orchestration_thread_assembly_records_thread_id
  ON orchestration_thread_assembly_records(thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS orchestration_assembly_change_proposals (
  proposal_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES orchestration_threads(thread_id) ON DELETE CASCADE,
  requested_bundle_id TEXT,
  requested_tool_allowlist_json JSONB,
  requested_specialist_ids_json JSONB,
  requested_context_policy_id TEXT,
  requested_approval_policy_id TEXT,
  proposed_by TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orchestration_assembly_change_proposals_thread_id
  ON orchestration_assembly_change_proposals(thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orchestration_assembly_change_proposals_status
  ON orchestration_assembly_change_proposals(status);

CREATE TABLE IF NOT EXISTS orchestration_assembly_change_decisions (
  decision_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES orchestration_threads(thread_id) ON DELETE CASCADE,
  proposal_id TEXT REFERENCES orchestration_assembly_change_proposals(proposal_id) ON DELETE SET NULL,
  result TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  resulting_bundle_id TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orchestration_assembly_change_decisions_thread_id
  ON orchestration_assembly_change_decisions(thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orchestration_assembly_change_decisions_proposal_id
  ON orchestration_assembly_change_decisions(proposal_id)
  WHERE proposal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS orchestration_specialist_definitions (
  specialist_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT,
  allowed_tool_allowlist_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orchestration_context_policy_definitions (
  context_policy_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  default_action TEXT NOT NULL,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
