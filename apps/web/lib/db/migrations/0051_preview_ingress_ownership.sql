ALTER TABLE "environments"
  ADD COLUMN "preview_ingress_provider" text DEFAULT 'ngrok' NOT NULL;

ALTER TABLE "environments"
  ADD CONSTRAINT "environments_preview_ingress_provider_check"
  CHECK ("preview_ingress_provider" IN ('ngrok', 'kestrel_edge'));

ALTER TABLE "workspace_preview_leases"
  ADD COLUMN "ingress_provider" text DEFAULT 'ngrok' NOT NULL;

ALTER TABLE "workspace_preview_leases"
  ALTER COLUMN "connection_id" DROP NOT NULL;

ALTER TABLE "workspace_preview_leases"
  ADD CONSTRAINT "workspace_preview_leases_ingress_provider_check"
  CHECK (
    ("ingress_provider" = 'kestrel_edge' AND "connection_id" IS NULL)
    OR
    ("ingress_provider" = 'ngrok' AND ("status" NOT IN ('provisioning', 'active', 'closing') OR "connection_id" IS NOT NULL))
  );
