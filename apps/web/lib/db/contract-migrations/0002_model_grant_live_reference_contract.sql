DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "environment_model_grants"
    WHERE "status" = 'active' AND "gateway_model_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'model grant contract rejected: active model grant is missing its live gateway model reference';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "environment_model_grants"
  VALIDATE CONSTRAINT "environment_model_grants_gateway_model_id_fk";
--> statement-breakpoint
ALTER TABLE "environment_model_grants"
  DROP CONSTRAINT IF EXISTS "environment_model_grants_gateway_model_fk";
--> statement-breakpoint
ALTER TABLE "environment_model_grants"
  ADD CONSTRAINT "environment_model_grants_active_model_check"
  CHECK ("status" <> 'active' OR "gateway_model_id" IS NOT NULL);
