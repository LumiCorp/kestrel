ALTER TABLE "app_connections"
  DROP CONSTRAINT IF EXISTS "app_connections_owner_type_check";
--> statement-breakpoint
ALTER TABLE "app_connections"
  ADD CONSTRAINT "app_connections_owner_type_check" CHECK (
    "owner_type" IN ('system', 'organization', 'personal', 'environment', 'deployment_managed')
  );
