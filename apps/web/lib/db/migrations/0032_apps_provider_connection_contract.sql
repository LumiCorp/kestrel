ALTER TABLE "app_definitions"
  ADD COLUMN "connection_requirement" text NOT NULL DEFAULT 'required';

UPDATE "app_definitions"
SET "connection_requirement" = 'none'
WHERE "connection_model" = 'none';

UPDATE "app_definitions"
SET
  "connection_model" = 'environment',
  "connection_requirement" = 'optional',
  "updated_at" = now()
WHERE "key" = 'built_in.weather';

ALTER TABLE "app_definitions"
  DROP CONSTRAINT IF EXISTS "app_definitions_connection_model_check";

ALTER TABLE "app_definitions"
  ADD CONSTRAINT "app_definitions_connection_model_check"
  CHECK ("connection_model" IN ('none', 'personal', 'environment', 'hybrid'));

ALTER TABLE "app_definitions"
  ADD CONSTRAINT "app_definitions_connection_requirement_check"
  CHECK ("connection_requirement" IN ('none', 'optional', 'required'));

ALTER TABLE "app_definitions"
  ADD CONSTRAINT "app_definitions_connection_contract_check"
  CHECK (("connection_model" = 'none') = ("connection_requirement" = 'none'));
