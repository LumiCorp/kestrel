ALTER TABLE "mcp_interaction_checkpoints"
  ADD COLUMN "processing_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mcp_interaction_checkpoints"
  ADD COLUMN "processing_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "mcp_interaction_checkpoints_processing_expiry_idx"
  ON "mcp_interaction_checkpoints" ("processing_expires_at")
  WHERE "status" = 'processing';
