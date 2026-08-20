CREATE TABLE "platform_turn_worker_capacity" (
	"id" text PRIMARY KEY NOT NULL,
	"concurrency_per_machine" integer DEFAULT 16 NOT NULL,
	"desired_active_machines" integer DEFAULT 1 NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"operation_id" text,
	"operation_state" text DEFAULT 'idle' NOT NULL,
	"operation_stage" text,
	"operation_inventory_fingerprint" text,
	"operation_actor_user_id" text,
	"operation_result" jsonb,
	"operation_queued_at" timestamp with time zone,
	"operation_started_at" timestamp with time zone,
	"operation_finished_at" timestamp with time zone,
	"operation_lease_until" timestamp with time zone,
	"admission_closed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_turn_worker_capacity_singleton_check" CHECK ("id" = 'default'),
	CONSTRAINT "platform_turn_worker_capacity_concurrency_check" CHECK ("concurrency_per_machine" BETWEEN 1 AND 64),
	CONSTRAINT "platform_turn_worker_capacity_machines_check" CHECK ("desired_active_machines" BETWEEN 1 AND 8),
	CONSTRAINT "platform_turn_worker_capacity_revision_check" CHECK ("revision" > 0),
	CONSTRAINT "platform_turn_worker_capacity_state_check" CHECK ("operation_state" IN ('idle', 'queued', 'running', 'succeeded', 'failed', 'interrupted')),
	CONSTRAINT "platform_turn_worker_capacity_actor_fk" FOREIGN KEY ("operation_actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
INSERT INTO "platform_turn_worker_capacity" ("id")
VALUES ('default')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "thread_turns"
	ADD COLUMN "concurrency_group_key" text;
--> statement-breakpoint
UPDATE "thread_turns" AS "turns"
SET "concurrency_group_key" = CASE
	WHEN "threads"."workspace_mode" = 'primary' AND "threads"."project_id" IS NOT NULL
		THEN 'project:' || "threads"."project_id"
	WHEN "threads"."workspace_mode" = 'primary' AND "threads"."created_by_user_id" IS NOT NULL
		THEN 'personal:' || "threads"."organization_id" || ':' || "threads"."created_by_user_id"
	ELSE 'thread:' || "threads"."id"
END
FROM "threads"
WHERE "turns"."thread_id" = "threads"."id";
--> statement-breakpoint
CREATE INDEX "thread_turns_concurrency_group_idx"
	ON "thread_turns" USING btree ("concurrency_group_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_turns_running_concurrency_group_idx"
	ON "thread_turns" USING btree ("concurrency_group_key")
	WHERE "status" = 'running' AND "concurrency_group_key" IS NOT NULL;
