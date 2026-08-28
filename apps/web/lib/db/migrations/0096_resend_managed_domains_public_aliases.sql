ALTER TABLE "organization_receiving_connections" ADD COLUMN "receiving_domain_kind" text DEFAULT 'custom' NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_receiving_connections" ADD CONSTRAINT "organization_receiving_connections_domain_kind_check" CHECK ("receiving_domain_kind" IN ('custom', 'resend_managed'));
--> statement-breakpoint
ALTER TABLE "project_email_triggers" DROP CONSTRAINT "project_email_triggers_private_access_check";
--> statement-breakpoint
ALTER TABLE "project_email_triggers" ADD CONSTRAINT "project_email_triggers_access_mode_check" CHECK ("access_mode" IN ('private', 'public'));
--> statement-breakpoint
DROP INDEX "project_email_triggers_address_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "project_email_triggers_address_idx" ON "project_email_triggers" USING btree ("address_domain", "address_local_part") WHERE "deleted_at" IS NULL;
