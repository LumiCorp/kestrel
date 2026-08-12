CREATE TABLE IF NOT EXISTS "runtime_interaction_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "interaction_id" text NOT NULL,
  "turn_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "request_id" text NOT NULL,
  "strategy" text NOT NULL,
  "native_correlation" jsonb NOT NULL,
  "attempt" integer DEFAULT 1 NOT NULL,
  "idempotency_key" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "acknowledged_at" timestamp with time zone,
  "failure_code" text,
  "failure_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "runtime_interaction_deliveries_interaction_id_fk"
    FOREIGN KEY ("interaction_id") REFERENCES "public"."thread_interactions"("id")
    ON DELETE cascade,
  CONSTRAINT "runtime_interaction_deliveries_turn_id_fk"
    FOREIGN KEY ("turn_id") REFERENCES "public"."thread_turns"("id")
    ON DELETE cascade,
  CONSTRAINT "runtime_interaction_deliveries_binding_id_fk"
    FOREIGN KEY ("binding_id") REFERENCES "public"."runtime_bindings"("id")
    ON DELETE cascade,
  CONSTRAINT "runtime_interaction_deliveries_strategy_check"
    CHECK ("strategy" IN ('kestrel_continuation', 'live_connection', 'live_callback')),
  CONSTRAINT "runtime_interaction_deliveries_state_check"
    CHECK ("state" IN ('pending', 'delivering', 'delivered', 'failed', 'expired'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "runtime_interaction_deliveries_interaction_idx"
  ON "runtime_interaction_deliveries" ("interaction_id");

CREATE UNIQUE INDEX IF NOT EXISTS "runtime_interaction_deliveries_idempotency_idx"
  ON "runtime_interaction_deliveries" ("idempotency_key");

CREATE INDEX IF NOT EXISTS "runtime_interaction_deliveries_turn_state_idx"
  ON "runtime_interaction_deliveries" ("turn_id", "state");
