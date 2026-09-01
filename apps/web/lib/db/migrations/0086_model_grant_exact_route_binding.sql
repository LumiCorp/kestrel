ALTER TABLE "environment_model_grants"
  ADD COLUMN IF NOT EXISTS "route_binding_status" text,
  ADD COLUMN IF NOT EXISTS "route_provider" text,
  ADD COLUMN IF NOT EXISTS "model_registration_id" text,
  ADD COLUMN IF NOT EXISTS "model_registration_revision" text,
  ADD COLUMN IF NOT EXISTS "model_registration_fingerprint" text,
  ADD COLUMN IF NOT EXISTS "model_qualification_revision" text,
  ADD COLUMN IF NOT EXISTS "model_api_endpoint" text,
  ADD COLUMN IF NOT EXISTS "model_endpoint_codec" text,
  ADD COLUMN IF NOT EXISTS "model_routing_policy_fingerprint" text,
  ADD COLUMN IF NOT EXISTS "model_required_role" text;
--> statement-breakpoint
ALTER TABLE "environment_model_grants"
  ADD CONSTRAINT "environment_model_grants_route_binding_status_check"
  CHECK (
    "route_binding_status" IS NULL OR
    "route_binding_status" IN ('qualified', 'legacy_unqualified')
  ) NOT VALID,
  ADD CONSTRAINT "environment_model_grants_qualified_route_check"
  CHECK (
    "route_binding_status" <> 'qualified' OR (
      "route_provider" IS NOT NULL AND
      "model_registration_id" IS NOT NULL AND
      "model_registration_revision" IS NOT NULL AND
      "model_registration_fingerprint" IS NOT NULL AND
      "model_qualification_revision" IS NOT NULL AND
      "model_api_endpoint" IS NOT NULL AND
      "model_endpoint_codec" IS NOT NULL AND
      "model_routing_policy_fingerprint" IS NOT NULL AND
      "model_required_role" IS NOT NULL
    )
  ) NOT VALID;
