ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS tenant_ownership_state TEXT NOT NULL DEFAULT 'legacy_unknown'
  CHECK (tenant_ownership_state IN ('legacy_unknown', 'explicit_unbound', 'tenant_bound'));

ALTER TABLE effects
  ADD COLUMN IF NOT EXISTS tenant_ownership_state TEXT NOT NULL DEFAULT 'legacy_unknown'
  CHECK (tenant_ownership_state IN ('legacy_unknown', 'explicit_unbound', 'tenant_bound'));

UPDATE runs
   SET tenant_ownership_state = 'tenant_bound'
 WHERE tenant_id IS NOT NULL
   AND tenant_ownership_state = 'legacy_unknown';

UPDATE effects
   SET tenant_ownership_state = 'tenant_bound'
 WHERE tenant_id IS NOT NULL
   AND tenant_ownership_state = 'legacy_unknown';
