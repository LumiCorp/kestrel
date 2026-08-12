ALTER TABLE "environment_workspaces"
  ADD COLUMN "personal_owner_user_id" text
  REFERENCES "user"("id") ON DELETE restrict;
--> statement-breakpoint
DROP INDEX "environment_workspaces_thread_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "environment_workspaces_personal_owner_idx"
  ON "environment_workspaces" ("organization_id", "personal_owner_user_id")
  WHERE "personal_owner_user_id" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "environment_workspaces"
  DROP CONSTRAINT "environment_workspaces_owner_check";
--> statement-breakpoint
ALTER TABLE "environment_workspaces"
  ADD CONSTRAINT "environment_workspaces_owner_check" CHECK (
    (
      "kind" = 'project'
      AND "project_id" IS NOT NULL
      AND "standalone_thread_id" IS NULL
      AND "personal_owner_user_id" IS NULL
    )
    OR
    (
      "kind" = 'scratch'
      AND "project_id" IS NULL
      AND "personal_owner_user_id" IS NOT NULL
      AND "standalone_thread_id" IS NULL
    )
  );
