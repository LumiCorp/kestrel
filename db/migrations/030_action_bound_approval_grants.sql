ALTER TABLE orchestration_approval_grants
  ADD COLUMN IF NOT EXISTS approval_id TEXT,
  ADD COLUMN IF NOT EXISTS action_key TEXT,
  ADD COLUMN IF NOT EXISTS payload_hash TEXT,
  ADD COLUMN IF NOT EXISTS tool_class TEXT,
  ADD COLUMN IF NOT EXISTS authority_kind TEXT,
  ADD COLUMN IF NOT EXISTS authority_revision TEXT,
  ADD COLUMN IF NOT EXISTS binding_json JSONB,
  ADD COLUMN IF NOT EXISTS decision_actor_json JSONB,
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;

UPDATE orchestration_approval_grants
   SET status = 'EXPIRED',
       expires_at = LEAST(COALESCE(expires_at, NOW()), NOW())
 WHERE status = 'ACTIVE'
   AND (
     approval_id IS NULL OR
     action_key IS NULL OR
     payload_hash IS NULL OR
     payload_hash !~ '^sha256:[0-9a-f]{64}$' OR
     tool_class IS NULL OR
     authority_kind IS NULL OR
     authority_revision IS NULL OR
     binding_json IS NULL OR
     decision_actor_json IS NULL
   );

ALTER TABLE orchestration_approval_grants
  DROP CONSTRAINT IF EXISTS orchestration_approval_grants_bound_status_check;

ALTER TABLE orchestration_approval_grants
  ADD CONSTRAINT orchestration_approval_grants_bound_status_check
  CHECK (
    status NOT IN ('ACTIVE', 'CONSUMED') OR (
      approval_id IS NOT NULL AND
      action_key IS NOT NULL AND
      payload_hash ~ '^sha256:[0-9a-f]{64}$' AND
      tool_class = 'external_side_effect' AND
      authority_kind IN ('runtime_policy', 'hosted_mcp_grant', 'hosted_app_policy') AND
      authority_revision IS NOT NULL AND
      binding_json IS NOT NULL AND
      decision_actor_json IS NOT NULL AND
      expires_at IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_orchestration_approval_grants_exact_active
  ON orchestration_approval_grants (
    thread_id,
    action_key,
    payload_hash,
    authority_kind,
    authority_revision,
    expires_at
  )
  WHERE status = 'ACTIVE';
