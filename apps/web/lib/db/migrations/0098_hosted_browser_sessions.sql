CREATE TABLE "browser_sessions" (
  "session_id" text PRIMARY KEY NOT NULL,
  "version" text DEFAULT 'browser_session_v1' NOT NULL,
  "thread_id" text NOT NULL,
  "mode" text NOT NULL,
  "state" text NOT NULL,
  "engine_revision" text NOT NULL,
  "generation" integer NOT NULL,
  "effective_allowlist_revision" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "last_activity_at" timestamp with time zone NOT NULL,
  "idle_expires_at" timestamp with time zone NOT NULL,
  "hard_expires_at" timestamp with time zone NOT NULL,
  "terminal_reason" text,
  CONSTRAINT "browser_sessions_version_check" CHECK ("version" = 'browser_session_v1'),
  CONSTRAINT "browser_sessions_mode_check" CHECK ("mode" IN ('qa', 'operator')),
  CONSTRAINT "browser_sessions_state_check" CHECK (
    "state" IN ('opening', 'ready', 'human_control', 'closing', 'closed', 'expired', 'lost', 'failed')
  ),
  CONSTRAINT "browser_sessions_generation_check" CHECK ("generation" > 0),
  CONSTRAINT "browser_sessions_expiry_check" CHECK (
    "created_at" <= "last_activity_at"
    AND "last_activity_at" <= "updated_at"
    AND "last_activity_at" < "idle_expires_at"
    AND "idle_expires_at" <= "hard_expires_at"
  ),
  CONSTRAINT "browser_sessions_terminal_reason_check" CHECK (
    ("state" IN ('opening', 'ready', 'human_control', 'closing') AND "terminal_reason" IS NULL)
    OR
    ("state" IN ('closed', 'expired', 'lost', 'failed') AND "terminal_reason" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "browser_session_resources" (
  "session_id" text PRIMARY KEY NOT NULL,
  "originating_turn_id" text NOT NULL,
  "preview_lease_id" text,
  "machine_id" text NOT NULL,
  "machine_generation" integer NOT NULL,
  "worker_image_digest" text NOT NULL,
  "proxy_authority_revision" text NOT NULL,
  "cleanup_requested_at" timestamp with time zone,
  "cleanup_confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "browser_session_resources_generation_check" CHECK ("machine_generation" > 0),
  CONSTRAINT "browser_session_resources_image_digest_check" CHECK ("worker_image_digest" ~ '@sha256:[a-f0-9]{64}$'),
  CONSTRAINT "browser_session_resources_cleanup_check" CHECK (
    "cleanup_confirmed_at" IS NULL
    OR ("cleanup_requested_at" IS NOT NULL AND "cleanup_confirmed_at" >= "cleanup_requested_at")
  )
);
--> statement-breakpoint
ALTER TABLE "browser_sessions"
  ADD CONSTRAINT "browser_sessions_thread_fk"
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "browser_session_resources"
  ADD CONSTRAINT "browser_session_resources_session_fk"
  FOREIGN KEY ("session_id") REFERENCES "browser_sessions"("session_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "browser_session_resources"
  ADD CONSTRAINT "browser_session_resources_originating_turn_fk"
  FOREIGN KEY ("originating_turn_id") REFERENCES "thread_turns"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "browser_session_resources"
  ADD CONSTRAINT "browser_session_resources_preview_lease_fk"
  FOREIGN KEY ("preview_lease_id") REFERENCES "workspace_preview_leases"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX "browser_sessions_one_nonterminal_per_thread_idx"
  ON "browser_sessions" ("thread_id")
  WHERE "state" IN ('opening', 'ready', 'human_control', 'closing');
--> statement-breakpoint
CREATE INDEX "browser_sessions_expiry_idx"
  ON "browser_sessions" ("state", "idle_expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "browser_session_resources_machine_idx"
  ON "browser_session_resources" ("machine_id");
--> statement-breakpoint
CREATE INDEX "browser_session_resources_turn_idx"
  ON "browser_session_resources" ("originating_turn_id");
--> statement-breakpoint
CREATE INDEX "browser_session_resources_preview_idx"
  ON "browser_session_resources" ("preview_lease_id");
--> statement-breakpoint
