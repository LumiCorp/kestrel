ALTER TABLE orchestration_context_policy_definitions
  ADD COLUMN IF NOT EXISTS economics_policy_json JSONB;

CREATE INDEX IF NOT EXISTS idx_orchestration_context_policy_economics_version
  ON orchestration_context_policy_definitions ((economics_policy_json ->> 'version'))
  WHERE economics_policy_json IS NOT NULL;
