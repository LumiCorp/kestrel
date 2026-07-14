CREATE TABLE IF NOT EXISTS "account_deletion_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "email" text NOT NULL,
  "status" text DEFAULT 'requested' NOT NULL,
  "confirmation_token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "confirmed_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_deletion_requests_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "account_deletion_requests_status_check"
    CHECK ("status" IN ('requested', 'confirmed', 'processing', 'completed', 'rejected', 'cancelled')),
  CONSTRAINT "account_deletion_requests_terminal_time_check"
    CHECK (
      ("status" = 'completed' AND "completed_at" IS NOT NULL)
      OR ("status" <> 'completed' AND "completed_at" IS NULL)
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_deletion_requests_token_idx"
  ON "account_deletion_requests" USING btree ("confirmation_token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_deletion_requests_user_status_idx"
  ON "account_deletion_requests" USING btree ("user_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_deletion_requests_status_created_idx"
  ON "account_deletion_requests" USING btree ("status", "created_at");
