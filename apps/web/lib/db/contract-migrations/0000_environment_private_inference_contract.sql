DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ai_deployments" WHERE "environment_id" IS NULL) THEN
    RAISE EXCEPTION 'Every managed inference deployment must resolve to an Environment';
  END IF;
  IF EXISTS (SELECT 1 FROM "thread_turns" WHERE "requested_environment_id" IS NULL) THEN
    RAISE EXCEPTION 'Every durable Thread turn must resolve to an Environment';
  END IF;
END $$;

ALTER TABLE "ai_gateways"
  VALIDATE CONSTRAINT "ai_gateways_organization_environment_fk";
ALTER TABLE "ai_gateways"
  VALIDATE CONSTRAINT "ai_gateways_environment_scope_check";
ALTER TABLE "ai_deployments"
  VALIDATE CONSTRAINT "ai_deployments_organization_environment_fk";
ALTER TABLE "thread_turns"
  VALIDATE CONSTRAINT "thread_turns_organization_environment_fk";

ALTER TABLE "ai_deployments" ALTER COLUMN "environment_id" SET NOT NULL;
ALTER TABLE "thread_turns" ALTER COLUMN "requested_environment_id" SET NOT NULL;
