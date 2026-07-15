CREATE TABLE "thread_interactions" (
  "id" text PRIMARY KEY NOT NULL,
  "request_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "turn_id" text,
  "assistant_message_id" text,
  "source" text NOT NULL,
  "source_checkpoint_id" text,
  "kind" text NOT NULL,
  "event_type" text NOT NULL,
  "prompt" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "request_envelope" jsonb NOT NULL,
  "response_envelope" jsonb,
  "resolved_by_user_id" text,
  "resolved_at" timestamp with time zone,
  "resumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "thread_interactions_source_check"
    CHECK ("source" IN ('runtime', 'mcp')),
  CONSTRAINT "thread_interactions_kind_check"
    CHECK ("kind" IN ('user_input', 'approval', 'mcp_sampling', 'mcp_elicitation')),
  CONSTRAINT "thread_interactions_status_check"
    CHECK ("status" IN ('pending', 'processing', 'resolved', 'cancelled', 'failed')),
  CONSTRAINT "thread_interactions_source_contract_check"
    CHECK (
      ("source" = 'runtime' AND "turn_id" IS NOT NULL AND "source_checkpoint_id" IS NULL)
      OR
      ("source" = 'mcp' AND "source_checkpoint_id" IS NOT NULL)
    )
);
--> statement-breakpoint
ALTER TABLE "thread_interactions"
  ADD CONSTRAINT "thread_interactions_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "thread_interactions"
  ADD CONSTRAINT "thread_interactions_thread_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "thread_interactions"
  ADD CONSTRAINT "thread_interactions_turn_id_fk"
  FOREIGN KEY ("turn_id") REFERENCES "public"."thread_turns"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "thread_interactions"
  ADD CONSTRAINT "thread_interactions_assistant_message_id_fk"
  FOREIGN KEY ("assistant_message_id") REFERENCES "public"."thread_messages"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "thread_interactions"
  ADD CONSTRAINT "thread_interactions_source_checkpoint_id_fk"
  FOREIGN KEY ("source_checkpoint_id") REFERENCES "public"."mcp_interaction_checkpoints"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "thread_interactions"
  ADD CONSTRAINT "thread_interactions_resolved_by_user_id_fk"
  FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_interactions_request_idx"
  ON "thread_interactions" ("request_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_interactions_source_checkpoint_idx"
  ON "thread_interactions" ("source_checkpoint_id");
--> statement-breakpoint
CREATE INDEX "thread_interactions_thread_status_idx"
  ON "thread_interactions" ("thread_id", "status");
--> statement-breakpoint
CREATE INDEX "thread_interactions_turn_idx"
  ON "thread_interactions" ("turn_id");
--> statement-breakpoint
INSERT INTO "thread_interactions" (
  "id",
  "request_id",
  "organization_id",
  "thread_id",
  "turn_id",
  "source",
  "source_checkpoint_id",
  "kind",
  "event_type",
  "prompt",
  "status",
  "request_envelope",
  "response_envelope",
  "resolved_by_user_id",
  "resolved_at",
  "created_at",
  "updated_at"
)
SELECT
  'interaction-' || checkpoint."id",
  checkpoint."id",
  run_grant."organization_id",
  checkpoint."thread_id",
  turn."id",
  'mcp',
  checkpoint."id",
  CASE checkpoint."kind"
    WHEN 'sampling' THEN 'mcp_sampling'
    ELSE 'mcp_elicitation'
  END,
  CASE checkpoint."kind"
    WHEN 'sampling' THEN 'mcp.sampling.response'
    ELSE 'mcp.elicitation.response'
  END,
  CASE checkpoint."kind"
    WHEN 'sampling' THEN 'Allow the agent to perform this protected model operation?'
    ELSE COALESCE(
      NULLIF(checkpoint."request_envelope" ->> 'message', ''),
      'The agent needs additional information to continue.'
    )
  END,
  CASE checkpoint."status"
    WHEN 'requested' THEN 'pending'
    WHEN 'processing' THEN 'processing'
    WHEN 'failed' THEN 'failed'
    WHEN 'denied' THEN 'cancelled'
    ELSE 'resolved'
  END,
  checkpoint."request_envelope",
  checkpoint."response_envelope",
  checkpoint."resolved_by_user_id",
  checkpoint."resolved_at",
  checkpoint."created_at",
  checkpoint."updated_at"
FROM "mcp_interaction_checkpoints" checkpoint
JOIN "mcp_invocations" invocation
  ON invocation."id" = checkpoint."invocation_id"
JOIN "mcp_run_grants" run_grant
  ON run_grant."id" = invocation."grant_id"
LEFT JOIN LATERAL (
  SELECT candidate."id"
  FROM "thread_turns" candidate
  WHERE candidate."environment_execution_id" = run_grant."run_execution_id"
  ORDER BY candidate."created_at" DESC
  LIMIT 1
) turn ON true
ON CONFLICT ("request_id") DO NOTHING;
