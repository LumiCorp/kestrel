CREATE TABLE "remembered_tool_approvals" (
  "id" text PRIMARY KEY NOT NULL,
  "version" text NOT NULL,
  "organization_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "tool_id" text NOT NULL,
  "descriptor_contract_revision" text NOT NULL,
  "approval_authority_revision" text NOT NULL,
  "source_interaction_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "remembered_tool_approvals_version_check"
    CHECK ("version" = 'remembered_tool_approval_v1')
);
--> statement-breakpoint
ALTER TABLE "remembered_tool_approvals"
  ADD CONSTRAINT "remembered_tool_approvals_organization_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "remembered_tool_approvals"
  ADD CONSTRAINT "remembered_tool_approvals_thread_fk"
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "remembered_tool_approvals"
  ADD CONSTRAINT "remembered_tool_approvals_actor_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "user"("id")
  ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "remembered_tool_approvals"
  ADD CONSTRAINT "remembered_tool_approvals_source_interaction_fk"
  FOREIGN KEY ("source_interaction_id") REFERENCES "thread_interactions"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "remembered_tool_approvals_identity_idx"
  ON "remembered_tool_approvals" (
    "organization_id", "thread_id", "actor_user_id", "tool_id",
    "descriptor_contract_revision", "approval_authority_revision"
  );
--> statement-breakpoint
CREATE INDEX "remembered_tool_approvals_thread_actor_idx"
  ON "remembered_tool_approvals" ("thread_id", "actor_user_id");
