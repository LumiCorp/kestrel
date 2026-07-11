ALTER TABLE orchestration_assembly_change_proposals
  ADD COLUMN IF NOT EXISTS requested_provider TEXT,
  ADD COLUMN IF NOT EXISTS requested_model TEXT,
  ADD COLUMN IF NOT EXISTS requested_prompt_variant TEXT;
