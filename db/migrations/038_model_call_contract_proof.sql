-- Model-call contract proof is additive. Existing rows remain readable through
-- the compatibility reader, which marks evidence they did not capture legacy.
ALTER TABLE model_call_provenance
  ADD COLUMN IF NOT EXISTS proof_json JSONB;
