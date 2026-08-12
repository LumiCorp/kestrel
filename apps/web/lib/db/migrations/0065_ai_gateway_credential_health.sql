ALTER TABLE "ai_gateways"
  ADD COLUMN "credential_status" text DEFAULT 'unverified' NOT NULL,
  ADD COLUMN "credential_validated_at" timestamp with time zone,
  ADD COLUMN "credential_revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE "ai_gateways"
SET
  "credential_status" = CASE
    WHEN "provider" = 'ollama' THEN 'not_required'
    WHEN NULLIF(BTRIM("api_key"), '') IS NOT NULL
      OR NULLIF(BTRIM("api_key_env_var"), '') IS NOT NULL
      OR "provider_connection_id" IS NOT NULL
      OR "deployment_id" IS NOT NULL
      THEN 'ready'
    ELSE 'unverified'
  END,
  "credential_validated_at" = CASE
    WHEN "provider" <> 'ollama'
      AND (
        NULLIF(BTRIM("api_key"), '') IS NOT NULL
        OR NULLIF(BTRIM("api_key_env_var"), '') IS NOT NULL
        OR "provider_connection_id" IS NOT NULL
        OR "deployment_id" IS NOT NULL
      )
      THEN COALESCE("updated_at", "created_at", now())
    ELSE NULL
  END;
--> statement-breakpoint
ALTER TABLE "ai_gateways"
  ADD CONSTRAINT "ai_gateways_credential_status_check"
    CHECK ("credential_status" IN ('unverified', 'ready', 'invalid', 'not_required')),
  ADD CONSTRAINT "ai_gateways_credential_revision_check"
    CHECK ("credential_revision" > 0),
  ADD CONSTRAINT "ai_gateways_credential_validation_check"
    CHECK ("credential_status" <> 'ready' OR "credential_validated_at" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "environment_model_grants"
  ADD COLUMN "gateway_credential_revision" integer;
--> statement-breakpoint
UPDATE "environment_model_grants" AS model_grant
SET "gateway_credential_revision" = gateway."credential_revision"
FROM "ai_gateways" AS gateway
WHERE model_grant."gateway_id" = gateway."id"
  AND model_grant."gateway_credential_revision" IS NULL;
--> statement-breakpoint
ALTER TABLE "environment_model_grants"
  ADD CONSTRAINT "environment_model_grants_active_credential_revision_check"
    CHECK ("status" <> 'active' OR "gateway_credential_revision" IS NOT NULL) NOT VALID;
