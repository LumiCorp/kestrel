ALTER TABLE "organization_receiving_connections"
  ADD COLUMN "webhook_create_intent" jsonb,
  ADD COLUMN "webhook_create_attempted_at" timestamp with time zone,
  ADD COLUMN "webhook_staging_sequence" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE "email_delivery_receipts" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "receiving_connection_id" text NOT NULL,
  "trigger_organization_id" text,
  "trigger_id" text,
  "svix_id" text NOT NULL,
  "resend_email_id" text NOT NULL,
  "event_at" timestamp with time zone NOT NULL,
  "state" text DEFAULT 'queued' NOT NULL,
  "reason" text,
  "claimed_from" text,
  "to_mailboxes" jsonb,
  "cc_mailboxes" jsonb,
  "bcc_mailboxes" jsonb,
  "received_for_mailboxes" jsonb,
  "reply_to_mailboxes" jsonb,
  "subject" text,
  "text_body" text,
  "html_body" text,
  "trigger_revision" integer,
  "reserved_thread_id" text NOT NULL,
  "reserved_message_id" text NOT NULL,
  "reserved_turn_id" text NOT NULL,
  "materialized_thread_organization_id" text,
  "materialized_thread_id" text,
  "materialized_message_thread_id" text,
  "materialized_message_id" text,
  "materialized_turn_thread_id" text,
  "materialized_turn_id" text,
  "hydrated_at" timestamp with time zone,
  "admitted_at" timestamp with time zone,
  "materialized_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_delivery_receipts_state_check" CHECK ("state" IN ('queued', 'hydrating', 'admitted', 'materialized', 'rejected', 'failed')),
  CONSTRAINT "email_delivery_receipts_reason_check" CHECK ((("state" IN ('rejected', 'failed')) AND "reason" IS NOT NULL AND "finished_at" IS NOT NULL) OR (("state" NOT IN ('rejected', 'failed')) AND "reason" IS NULL AND "finished_at" IS NULL)),
  CONSTRAINT "email_delivery_receipts_trigger_organization_check" CHECK (("trigger_organization_id" IS NULL) = ("trigger_id" IS NULL) AND ("trigger_organization_id" IS NULL OR "trigger_organization_id" = "organization_id")),
  CONSTRAINT "email_delivery_receipts_thread_organization_check" CHECK (("materialized_thread_organization_id" IS NULL) = ("materialized_thread_id" IS NULL) AND ("materialized_thread_organization_id" IS NULL OR "materialized_thread_organization_id" = "organization_id")),
  CONSTRAINT "email_delivery_receipts_materialized_children_check" CHECK (("materialized_message_thread_id" IS NULL) = ("materialized_message_id" IS NULL) AND ("materialized_turn_thread_id" IS NULL) = ("materialized_turn_id" IS NULL) AND ("materialized_message_thread_id" IS NULL OR "materialized_message_thread_id" = "materialized_thread_id") AND ("materialized_turn_thread_id" IS NULL OR "materialized_turn_thread_id" = "materialized_thread_id")),
  CONSTRAINT "email_delivery_receipts_materialized_state_check" CHECK (("state" = 'materialized') = ("materialized_thread_organization_id" IS NOT NULL AND "materialized_thread_id" IS NOT NULL AND "materialized_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" ADD CONSTRAINT "email_delivery_receipts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_receiving_connections_organization_id_idx" ON "organization_receiving_connections" USING btree ("organization_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "project_email_triggers_organization_id_idx" ON "project_email_triggers" USING btree ("organization_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "threads_organization_id_idx" ON "threads" USING btree ("organization_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_messages_thread_identity_idx" ON "thread_messages" USING btree ("thread_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_turns_thread_identity_idx" ON "thread_turns" USING btree ("thread_id", "id");
--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" ADD CONSTRAINT "email_delivery_receipts_organization_connection_fk" FOREIGN KEY ("organization_id", "receiving_connection_id") REFERENCES "public"."organization_receiving_connections"("organization_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" ADD CONSTRAINT "email_delivery_receipts_organization_trigger_fk" FOREIGN KEY ("trigger_organization_id", "trigger_id") REFERENCES "public"."project_email_triggers"("organization_id", "id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" ADD CONSTRAINT "email_delivery_receipts_organization_thread_fk" FOREIGN KEY ("materialized_thread_organization_id", "materialized_thread_id") REFERENCES "public"."threads"("organization_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" ADD CONSTRAINT "email_delivery_receipts_thread_message_fk" FOREIGN KEY ("materialized_message_thread_id", "materialized_message_id") REFERENCES "public"."thread_messages"("thread_id", "id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" ADD CONSTRAINT "email_delivery_receipts_thread_turn_fk" FOREIGN KEY ("materialized_turn_thread_id", "materialized_turn_id") REFERENCES "public"."thread_turns"("thread_id", "id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_receipts_connection_svix_idx" ON "email_delivery_receipts" USING btree ("receiving_connection_id", "svix_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_receipts_connection_email_idx" ON "email_delivery_receipts" USING btree ("receiving_connection_id", "resend_email_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_receipts_reserved_thread_idx" ON "email_delivery_receipts" USING btree ("reserved_thread_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_receipts_reserved_message_idx" ON "email_delivery_receipts" USING btree ("reserved_message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_receipts_reserved_turn_idx" ON "email_delivery_receipts" USING btree ("reserved_turn_id");
--> statement-breakpoint
CREATE INDEX "email_delivery_receipts_state_idx" ON "email_delivery_receipts" USING btree ("state", "updated_at");
--> statement-breakpoint
CREATE INDEX "email_delivery_receipts_trigger_idx" ON "email_delivery_receipts" USING btree ("trigger_id");
