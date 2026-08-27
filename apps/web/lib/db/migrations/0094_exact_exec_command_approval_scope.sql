DELETE FROM "remembered_tool_approvals";
--> statement-breakpoint
ALTER TABLE "remembered_tool_approvals"
  ADD COLUMN "scope_kind" text NOT NULL,
  ADD COLUMN "scope_key" text NOT NULL,
  ADD COLUMN "scope_payload" jsonb;
--> statement-breakpoint
DROP INDEX "remembered_tool_approvals_identity_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "remembered_tool_approvals_identity_idx"
  ON "remembered_tool_approvals" (
    "organization_id", "thread_id", "actor_user_id", "tool_id",
    "descriptor_contract_revision", "approval_authority_revision",
    "scope_kind", "scope_key"
  );
