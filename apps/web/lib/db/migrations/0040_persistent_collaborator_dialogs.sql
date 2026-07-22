CREATE TABLE "thread_dialogs" (
  "id" text PRIMARY KEY NOT NULL,
  "thread_id" text NOT NULL,
  "runtime_child_thread_id" text NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "thread_dialogs_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade
);

ALTER TABLE "thread_messages" ADD COLUMN "dialog_id" text;
ALTER TABLE "thread_messages" ADD COLUMN "dialog_message_id" text;
ALTER TABLE "thread_messages" ADD COLUMN "dialog_name" text;
ALTER TABLE "thread_messages" ADD COLUMN "dialog_sender" text;

ALTER TABLE "thread_messages"
  ADD CONSTRAINT "thread_messages_dialog_fk"
  FOREIGN KEY ("dialog_id") REFERENCES "public"."thread_dialogs"("id") ON DELETE cascade;

CREATE INDEX "thread_dialogs_thread_id_idx" ON "thread_dialogs" ("thread_id");
CREATE UNIQUE INDEX "thread_dialogs_open_name_idx" ON "thread_dialogs" ("thread_id", lower("name")) WHERE "status" = 'open';
CREATE UNIQUE INDEX "thread_messages_dialog_message_idx" ON "thread_messages" ("thread_id", "dialog_message_id");
