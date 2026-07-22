DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ai_provider_connections" WHERE "scope" <> 'organization'
  ) THEN
    RAISE EXCEPTION 'organization settings contract rejected: provider connection scope is not organization-owned';
  END IF;

  IF EXISTS (SELECT 1 FROM "ai_provider_connections" WHERE "organization_id" IS NULL) THEN
    RAISE EXCEPTION 'Every infrastructure provider connection must belong to an organization';
  END IF;
  IF EXISTS (SELECT 1 FROM "ai_provider_connections" WHERE "api_key" IS NULL OR "api_key_env_var" IS NOT NULL) THEN
    RAISE EXCEPTION 'Every infrastructure provider connection must use a stored credential without an environment fallback';
  END IF;
  IF EXISTS (SELECT 1 FROM "ai_deployment_profiles" WHERE "organization_id" IS NULL) THEN
    RAISE EXCEPTION 'Every deployment profile must belong to an organization';
  END IF;
  IF EXISTS (SELECT 1 FROM "ai_gateways" WHERE "organization_id" IS NULL) THEN
    RAISE EXCEPTION 'Every AI gateway must belong to an organization';
  END IF;
  IF EXISTS (SELECT 1 FROM "ai_gateways" WHERE "api_key_env_var" IS NOT NULL) THEN
    RAISE EXCEPTION 'AI gateway environment credential fallbacks must be removed';
  END IF;
  IF EXISTS (SELECT 1 FROM "ai_gateway_models" WHERE "organization_id" IS NULL) THEN
    RAISE EXCEPTION 'Every AI gateway model must belong to an organization';
  END IF;
END $$;

ALTER TABLE "ai_gateways" VALIDATE CONSTRAINT "ai_gateways_organization_provider_connection_fk";
ALTER TABLE "ai_gateway_models" VALIDATE CONSTRAINT "ai_gateway_models_organization_gateway_fk";
ALTER TABLE "ai_deployments" VALIDATE CONSTRAINT "ai_deployments_organization_profile_fk";

ALTER TABLE "ai_provider_connections" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "ai_deployment_profiles" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "ai_gateways" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "ai_gateway_models" ALTER COLUMN "organization_id" SET NOT NULL;
