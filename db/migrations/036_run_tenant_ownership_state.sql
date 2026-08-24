ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS tenant_ownership_state TEXT NOT NULL DEFAULT 'legacy_unknown'
  CHECK (tenant_ownership_state IN ('legacy_unknown', 'explicit_unbound', 'tenant_bound'));

ALTER TABLE effects
  ADD COLUMN IF NOT EXISTS tenant_ownership_state TEXT NOT NULL DEFAULT 'legacy_unknown'
  CHECK (tenant_ownership_state IN ('legacy_unknown', 'explicit_unbound', 'tenant_bound'));

