CREATE TABLE "organization_receiving_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "provider" text DEFAULT 'resend' NOT NULL,
  "encrypted_api_key" text,
  "credential_status" text DEFAULT 'not_configured' NOT NULL,
  "credential_validated_at" timestamp with time zone,
  "receiving_domain_id" text,
  "receiving_domain" text,
  "receiving_domain_status" text DEFAULT 'not_selected' NOT NULL,
  "mx_status" text DEFAULT 'unknown' NOT NULL,
  "domain_checked_at" timestamp with time zone,
  "route_locator" text NOT NULL,
  "provider_webhook_id" text,
  "encrypted_signing_secret" text,
  "webhook_status" text DEFAULT 'not_staged' NOT NULL,
  "inbound_enabled" boolean DEFAULT false NOT NULL,
  "last_health_checked_at" timestamp with time zone,
  "last_tested_at" timestamp with time zone,
  "last_error_code" text,
  "updated_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_receiving_connections_provider_check" CHECK ("provider" IN ('resend')),
  CONSTRAINT "organization_receiving_connections_credential_status_check" CHECK ("credential_status" IN ('not_configured', 'full_access', 'insufficient', 'error')),
  CONSTRAINT "organization_receiving_connections_domain_status_check" CHECK ("receiving_domain_status" IN ('not_selected', 'pending', 'verified', 'failed')),
  CONSTRAINT "organization_receiving_connections_mx_status_check" CHECK ("mx_status" IN ('unknown', 'pending', 'verified', 'failed')),
  CONSTRAINT "organization_receiving_connections_webhook_status_check" CHECK ("webhook_status" IN ('not_staged', 'staged', 'active', 'disabled', 'error')),
  CONSTRAINT "organization_receiving_connections_disabled_without_webhook_check" CHECK (NOT "inbound_enabled" OR "webhook_status" = 'active')
);
--> statement-breakpoint
ALTER TABLE "organization_receiving_connections" ADD CONSTRAINT "organization_receiving_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "organization_receiving_connections" ADD CONSTRAINT "organization_receiving_connections_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_receiving_connections_org_idx" ON "organization_receiving_connections" USING btree ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_receiving_connections_route_locator_idx" ON "organization_receiving_connections" USING btree ("route_locator");
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_receiving_connections_webhook_idx" ON "organization_receiving_connections" USING btree ("provider_webhook_id") WHERE "provider_webhook_id" IS NOT NULL;
