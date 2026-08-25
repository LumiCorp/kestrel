ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS tenant_id TEXT;

ALTER TABLE effects
  ADD COLUMN IF NOT EXISTS tenant_id TEXT;

UPDATE effects e
   SET tenant_id = r.tenant_id
  FROM runs r
 WHERE e.run_id = r.run_id
   AND e.tenant_id IS NULL
   AND r.tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runs_tenant_authority
  ON runs (tenant_id, run_id)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_effects_tenant_authority
  ON effects (tenant_id, idempotency_key)
  WHERE tenant_id IS NOT NULL;
