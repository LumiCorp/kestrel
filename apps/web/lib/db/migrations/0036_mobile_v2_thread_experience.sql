ALTER TABLE "threads" ADD COLUMN "parent_thread_id" text;
ALTER TABLE "threads" ADD COLUMN "branch_anchor_message_id" text;
ALTER TABLE "thread_messages" ADD COLUMN "source_message_id" text;
ALTER TABLE "thread_turns" ADD COLUMN "queue_ordinal" integer;
ALTER TABLE "thread_turns" ADD COLUMN "output_message_id" text;

UPDATE "thread_turns"
SET "queue_ordinal" = "sequence"
WHERE "queue_ordinal" IS NULL;

ALTER TABLE "thread_turns" ALTER COLUMN "queue_ordinal" SET NOT NULL;

UPDATE "thread_turns" turn
SET "output_message_id" = candidate."id"
FROM (
  SELECT DISTINCT ON (message."turn_id")
    message."turn_id",
    message."id"
  FROM "thread_messages" message
  WHERE message."turn_id" IS NOT NULL
    AND message."role" = 'assistant'
  ORDER BY message."turn_id", message."created_at" DESC, message."id" DESC
) candidate
WHERE turn."id" = candidate."turn_id";

ALTER TABLE "threads"
  ADD CONSTRAINT "threads_parent_thread_id_fk"
  FOREIGN KEY ("parent_thread_id") REFERENCES "public"."threads"("id")
  ON DELETE SET NULL;

ALTER TABLE "threads"
  ADD CONSTRAINT "threads_branch_anchor_message_id_fk"
  FOREIGN KEY ("branch_anchor_message_id") REFERENCES "public"."thread_messages"("id")
  ON DELETE SET NULL;

ALTER TABLE "thread_messages"
  ADD CONSTRAINT "thread_messages_source_message_id_fk"
  FOREIGN KEY ("source_message_id") REFERENCES "public"."thread_messages"("id")
  ON DELETE SET NULL;

ALTER TABLE "thread_turns"
  ADD CONSTRAINT "thread_turns_output_message_id_fk"
  FOREIGN KEY ("output_message_id") REFERENCES "public"."thread_messages"("id")
  ON DELETE SET NULL;

CREATE TABLE "thread_turn_presentations" (
  "turn_id" text PRIMARY KEY NOT NULL,
  "stage" text NOT NULL,
  "milestones" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "thread_turn_presentations_stage_check"
    CHECK ("stage" IN (
      'queued', 'preparing', 'reading_context', 'working',
      'using_capability', 'finalizing', 'waiting', 'retrying'
    )),
  CONSTRAINT "thread_turn_presentations_milestones_check"
    CHECK (jsonb_typeof("milestones") = 'array' AND jsonb_array_length("milestones") <= 8)
);

ALTER TABLE "thread_turn_presentations"
  ADD CONSTRAINT "thread_turn_presentations_turn_id_fk"
  FOREIGN KEY ("turn_id") REFERENCES "public"."thread_turns"("id")
  ON DELETE CASCADE;

CREATE TABLE "thread_read_states" (
  "user_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "last_read_message_id" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "thread_read_states_pk" PRIMARY KEY ("user_id", "thread_id")
);

ALTER TABLE "thread_read_states"
  ADD CONSTRAINT "thread_read_states_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
  ON DELETE CASCADE;

ALTER TABLE "thread_read_states"
  ADD CONSTRAINT "thread_read_states_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
  ON DELETE CASCADE;

ALTER TABLE "thread_read_states"
  ADD CONSTRAINT "thread_read_states_thread_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id")
  ON DELETE CASCADE;

ALTER TABLE "thread_read_states"
  ADD CONSTRAINT "thread_read_states_last_read_message_id_fk"
  FOREIGN KEY ("last_read_message_id") REFERENCES "public"."thread_messages"("id")
  ON DELETE SET NULL;

CREATE INDEX "threads_parent_thread_id_idx"
  ON "threads" ("parent_thread_id");
CREATE INDEX "thread_messages_thread_created_id_idx"
  ON "thread_messages" ("thread_id", "created_at", "id");
CREATE INDEX "thread_turns_thread_queue_ordinal_idx"
  ON "thread_turns" ("thread_id", "queue_ordinal");
CREATE INDEX "thread_turn_presentations_stage_idx"
  ON "thread_turn_presentations" ("stage");
CREATE INDEX "thread_read_states_org_user_idx"
  ON "thread_read_states" ("organization_id", "user_id");
