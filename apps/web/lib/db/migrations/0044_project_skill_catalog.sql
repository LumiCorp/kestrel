ALTER TABLE "projects"
  ADD COLUMN "skill_catalog_initialized_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_id_id_idx"
  ON "projects" ("organization_id", "id");
--> statement-breakpoint
CREATE TABLE "project_skill_installations" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" text NOT NULL,
  "created_by_user_id" text NOT NULL,
  "git_url" text NOT NULL,
  "branch" text DEFAULT 'main' NOT NULL,
  "path" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "revision" jsonb,
  "last_sync_attempt_at" timestamp with time zone,
  "last_sync_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_skill_installations_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade,
  CONSTRAINT "project_skill_installations_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
    ON DELETE cascade,
  CONSTRAINT "project_skill_installations_created_by_user_id_user_id_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id")
    ON DELETE restrict,
  CONSTRAINT "project_skill_installations_organization_project_fk"
    FOREIGN KEY ("organization_id", "project_id")
    REFERENCES "public"."projects"("organization_id", "id")
    ON DELETE cascade,
  CONSTRAINT "project_skill_installations_status_check"
    CHECK ("status" IN ('pending', 'syncing', 'ready', 'stale', 'failed', 'removal_pending'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "project_skill_installations_source_idx"
  ON "project_skill_installations" ("project_id", "git_url", "branch", "path");
--> statement-breakpoint
CREATE INDEX "project_skill_installations_org_project_idx"
  ON "project_skill_installations" ("organization_id", "project_id");
--> statement-breakpoint
CREATE INDEX "project_skill_installations_status_idx"
  ON "project_skill_installations" ("organization_id", "status");
