ALTER TABLE "mcp_interaction_checkpoints"
  DROP CONSTRAINT "mcp_interaction_checkpoints_status_check";
--> statement-breakpoint
ALTER TABLE "mcp_interaction_checkpoints"
  ADD CONSTRAINT "mcp_interaction_checkpoints_status_check"
  CHECK ("status" IN ('requested', 'approved', 'processing', 'denied', 'completed', 'failed'));
--> statement-breakpoint
ALTER TABLE "mcp_interaction_checkpoints"
  ADD COLUMN "failure_code" text;
--> statement-breakpoint
ALTER TABLE "mcp_interaction_checkpoints"
  ADD COLUMN "failure_message" text;
