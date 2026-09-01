CREATE TABLE "project_email_triggers" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" text NOT NULL,
  "created_by_user_id" text,
  "execution_owner_user_id" text,
  "name" text NOT NULL,
  "instruction" text NOT NULL,
  "model_id" text NOT NULL,
  "claimed_from_filter" text,
  "access_mode" text DEFAULT 'private' NOT NULL,
  "address_local_part" text NOT NULL,
  "address_domain" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "disabled_reason" text,
  "revision" integer DEFAULT 1 NOT NULL,
  "rotated_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_email_triggers_private_access_check" CHECK ("access_mode" = 'private'),
  CONSTRAINT "project_email_triggers_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "project_email_triggers_enabled_owner_check" CHECK (NOT "enabled" OR "execution_owner_user_id" IS NOT NULL),
  CONSTRAINT "project_email_triggers_deleted_disabled_check" CHECK ("deleted_at" IS NULL OR NOT "enabled")
);
--> statement-breakpoint
ALTER TABLE "project_email_triggers" ADD CONSTRAINT "project_email_triggers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_email_triggers" ADD CONSTRAINT "project_email_triggers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_email_triggers" ADD CONSTRAINT "project_email_triggers_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_email_triggers" ADD CONSTRAINT "project_email_triggers_execution_owner_user_id_user_id_fk" FOREIGN KEY ("execution_owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_email_triggers" ADD CONSTRAINT "project_email_triggers_organization_project_fk" FOREIGN KEY ("organization_id", "project_id") REFERENCES "public"."projects"("organization_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "project_email_triggers_address_idx" ON "project_email_triggers" USING btree ("address_domain", "address_local_part");
--> statement-breakpoint
CREATE INDEX "project_email_triggers_project_idx" ON "project_email_triggers" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "project_email_triggers_execution_owner_idx" ON "project_email_triggers" USING btree ("execution_owner_user_id");
--> statement-breakpoint
CREATE INDEX "project_email_triggers_admission_idx" ON "project_email_triggers" USING btree ("organization_id", "enabled", "deleted_at");
