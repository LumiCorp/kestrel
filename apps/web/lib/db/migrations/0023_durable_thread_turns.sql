CREATE TABLE "thread_turns" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "author_user_id" text NOT NULL,
  "input_message_id" text,
  "approval_id" text,
  "approval_approved" boolean,
  "approval_reason" text,
  "project_context_revision_id" text,
  "environment_execution_id" text,
  "idempotency_key" text NOT NULL,
  "sequence" integer NOT NULL,
  "source" text DEFAULT 'web' NOT NULL,
  "requested_model_id" text,
  "status" text DEFAULT 'queued' NOT NULL,
  "failure_code" text,
  "failure_message" text,
  "cancel_requested_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "thread_turns_source_check"
    CHECK ("source" IN ('web', 'mobile', 'api')),
  CONSTRAINT "thread_turns_status_check"
    CHECK ("status" IN ('queued', 'running', 'waiting_for_input', 'completed', 'failed', 'cancelled')),
  CONSTRAINT "thread_turns_terminal_timestamp_check"
    CHECK (
      ("status" IN ('completed', 'failed', 'cancelled') AND "finished_at" IS NOT NULL)
      OR
      ("status" NOT IN ('completed', 'failed', 'cancelled') AND "finished_at" IS NULL)
    ),
  CONSTRAINT "thread_turns_input_contract_check"
    CHECK (
      ("input_message_id" IS NOT NULL AND "approval_id" IS NULL AND "approval_approved" IS NULL AND "approval_reason" IS NULL)
      OR
      ("input_message_id" IS NULL AND "approval_id" IS NOT NULL AND "approval_approved" IS NOT NULL)
    )
);
--> statement-breakpoint
CREATE TABLE "thread_turn_events" (
  "id" text PRIMARY KEY NOT NULL,
  "turn_id" text NOT NULL,
  "sequence" integer NOT NULL,
  "type" text NOT NULL,
  "data" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_turn_queue_state" (
  "thread_id" text PRIMARY KEY NOT NULL,
  "active_turn_id" text,
  "next_sequence" integer DEFAULT 1 NOT NULL,
  "state" text DEFAULT 'running' NOT NULL,
  "pause_reason" text,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "thread_turn_queue_state_state_check"
    CHECK ("state" IN ('running', 'paused')),
  CONSTRAINT "thread_turn_queue_state_pause_reason_check"
    CHECK (
      ("state" = 'paused' AND "pause_reason" IS NOT NULL)
      OR
      ("state" = 'running' AND "pause_reason" IS NULL)
    )
);
--> statement-breakpoint
CREATE TABLE "mobile_device_registrations" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "organization_id" text,
  "platform" text NOT NULL,
  "expo_push_token" text NOT NULL,
  "app_version" text,
  "locale" text,
  "timezone" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mobile_device_registrations_platform_check"
    CHECK ("platform" IN ('ios', 'android'))
);
--> statement-breakpoint
CREATE TABLE "mobile_push_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "device_registration_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "turn_id" text NOT NULL,
  "kind" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "expo_ticket_id" text,
  "error_code" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mobile_push_deliveries_kind_check"
    CHECK ("kind" IN ('completed', 'failed', 'attention')),
  CONSTRAINT "mobile_push_deliveries_status_check"
    CHECK ("status" IN ('pending', 'accepted', 'delivered', 'failed', 'device_unregistered'))
);
--> statement-breakpoint
ALTER TABLE "thread_turns"
  ADD CONSTRAINT "thread_turns_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "thread_turns"
  ADD CONSTRAINT "thread_turns_thread_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "thread_turns"
  ADD CONSTRAINT "thread_turns_author_user_id_fk"
  FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "thread_turns"
  ADD CONSTRAINT "thread_turns_input_message_id_fk"
  FOREIGN KEY ("input_message_id") REFERENCES "public"."thread_messages"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "thread_turns"
  ADD CONSTRAINT "thread_turns_context_revision_id_fk"
  FOREIGN KEY ("project_context_revision_id") REFERENCES "public"."project_context_revisions"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "thread_turns"
  ADD CONSTRAINT "thread_turns_environment_execution_id_fk"
  FOREIGN KEY ("environment_execution_id") REFERENCES "public"."environment_run_executions"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "thread_turn_events"
  ADD CONSTRAINT "thread_turn_events_turn_id_fk"
  FOREIGN KEY ("turn_id") REFERENCES "public"."thread_turns"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "thread_turn_queue_state"
  ADD CONSTRAINT "thread_turn_queue_state_thread_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "thread_turn_queue_state"
  ADD CONSTRAINT "thread_turn_queue_state_active_turn_id_fk"
  FOREIGN KEY ("active_turn_id") REFERENCES "public"."thread_turns"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mobile_device_registrations"
  ADD CONSTRAINT "mobile_device_registrations_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mobile_device_registrations"
  ADD CONSTRAINT "mobile_device_registrations_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mobile_push_deliveries"
  ADD CONSTRAINT "mobile_push_deliveries_device_registration_id_fk"
  FOREIGN KEY ("device_registration_id") REFERENCES "public"."mobile_device_registrations"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mobile_push_deliveries"
  ADD CONSTRAINT "mobile_push_deliveries_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mobile_push_deliveries"
  ADD CONSTRAINT "mobile_push_deliveries_thread_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mobile_push_deliveries"
  ADD CONSTRAINT "mobile_push_deliveries_turn_id_fk"
  FOREIGN KEY ("turn_id") REFERENCES "public"."thread_turns"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_turns_thread_sequence_idx"
  ON "thread_turns" ("thread_id", "sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_turns_thread_idempotency_idx"
  ON "thread_turns" ("thread_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_turns_input_message_idx"
  ON "thread_turns" ("input_message_id");
--> statement-breakpoint
CREATE INDEX "thread_turns_org_status_idx"
  ON "thread_turns" ("organization_id", "status");
--> statement-breakpoint
CREATE INDEX "thread_turns_thread_status_idx"
  ON "thread_turns" ("thread_id", "status");
--> statement-breakpoint
CREATE INDEX "thread_turns_author_idx" ON "thread_turns" ("author_user_id");
--> statement-breakpoint
CREATE INDEX "thread_turns_context_revision_idx"
  ON "thread_turns" ("project_context_revision_id");
--> statement-breakpoint
CREATE INDEX "thread_turns_execution_idx"
  ON "thread_turns" ("environment_execution_id");
--> statement-breakpoint
ALTER TABLE "thread_messages" ADD COLUMN "turn_id" text;
--> statement-breakpoint
ALTER TABLE "thread_messages"
  ADD CONSTRAINT "thread_messages_turn_id_fk"
  FOREIGN KEY ("turn_id") REFERENCES "public"."thread_turns"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "thread_messages_turn_id_idx" ON "thread_messages" ("turn_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_turn_events_turn_sequence_idx"
  ON "thread_turn_events" ("turn_id", "sequence");
--> statement-breakpoint
CREATE INDEX "thread_turn_events_expiry_idx"
  ON "thread_turn_events" ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "mobile_device_registrations_push_token_idx"
  ON "mobile_device_registrations" ("expo_push_token");
--> statement-breakpoint
CREATE INDEX "mobile_device_registrations_user_idx"
  ON "mobile_device_registrations" ("user_id");
--> statement-breakpoint
CREATE INDEX "mobile_device_registrations_org_idx"
  ON "mobile_device_registrations" ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mobile_push_deliveries_turn_device_kind_idx"
  ON "mobile_push_deliveries" ("turn_id", "device_registration_id", "kind");
--> statement-breakpoint
CREATE INDEX "mobile_push_deliveries_status_idx"
  ON "mobile_push_deliveries" ("status");
--> statement-breakpoint
CREATE INDEX "mobile_push_deliveries_ticket_idx"
  ON "mobile_push_deliveries" ("expo_ticket_id");
