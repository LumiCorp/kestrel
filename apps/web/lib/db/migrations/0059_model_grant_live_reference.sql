ALTER TABLE "environment_model_grants"
  ADD COLUMN IF NOT EXISTS "gateway_model_id" text;
--> statement-breakpoint
UPDATE "environment_model_grants" AS model_grant
SET "gateway_model_id" = model."id"
FROM "ai_gateway_models" AS model
WHERE model_grant."gateway_model_id" IS NULL
  AND model_grant."gateway_id" = model."gateway_id"
  AND model_grant."raw_model_id" = model."raw_model_id";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_model_grants_gateway_model_id_idx"
  ON "environment_model_grants" ("gateway_model_id");
--> statement-breakpoint
ALTER TABLE "environment_model_grants"
  ADD CONSTRAINT "environment_model_grants_gateway_model_id_fk"
  FOREIGN KEY ("gateway_model_id") REFERENCES "ai_gateway_models"("id")
  ON DELETE SET NULL NOT VALID;
