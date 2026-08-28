ALTER TABLE "project_workflows"
  ADD COLUMN "active_version_id" text,
  ADD COLUMN "attention_code" text,
  ADD COLUMN "attention_message" text;

ALTER TABLE "project_workflow_versions" ADD COLUMN "model_id" text;
UPDATE "project_workflow_versions" AS version
SET "model_id" = workflow."model_id"
FROM "project_workflows" AS workflow
WHERE workflow."id" = version."workflow_id";
ALTER TABLE "project_workflow_versions" ALTER COLUMN "model_id" SET NOT NULL;

CREATE TABLE "project_workflow_version_activations" (
  "id" text PRIMARY KEY NOT NULL,
  "workflow_version_id" text NOT NULL,
  "activated_by_user_id" text NOT NULL,
  "environment_id" text NOT NULL,
  "manifest" jsonb NOT NULL,
  "manifest_digest" text NOT NULL,
  "activated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_workflow_version_activations_version_fk"
    FOREIGN KEY ("workflow_version_id") REFERENCES "project_workflow_versions"("id")
    ON DELETE CASCADE,
  CONSTRAINT "project_workflow_version_activations_actor_fk"
    FOREIGN KEY ("activated_by_user_id") REFERENCES "user"("id")
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "project_workflow_version_activations_version_idx"
  ON "project_workflow_version_activations" ("workflow_version_id");
CREATE INDEX "project_workflow_version_activations_actor_idx"
  ON "project_workflow_version_activations" ("activated_by_user_id");

ALTER TABLE "project_workflow_runs"
  ADD COLUMN "workflow_workspace_id" text,
  ADD COLUMN "activation_manifest_digest" text,
  ADD COLUMN "attention_code" text,
  ADD COLUMN "attention_message" text;

UPDATE "project_workflows"
SET "enabled" = false, "next_run_at" = NULL;

UPDATE "project_workflow_runs"
SET "workflow_workspace_id" = 'legacy:' || "id",
    "activation_manifest_digest" = 'legacy-unactivated';

ALTER TABLE "project_workflow_runs"
  ALTER COLUMN "workflow_workspace_id" SET NOT NULL,
  ALTER COLUMN "activation_manifest_digest" SET NOT NULL;

ALTER TABLE "project_workflows"
  ADD CONSTRAINT "project_workflows_active_version_fk"
  FOREIGN KEY ("active_version_id") REFERENCES "project_workflow_versions"("id")
  ON DELETE SET NULL;
