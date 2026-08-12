ALTER TABLE orchestration_interaction_requests
  ADD COLUMN IF NOT EXISTS interaction_json JSONB;
