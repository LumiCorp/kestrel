CREATE TABLE "project_prompt_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"created_by_user_id" text,
	"cron_expression" text NOT NULL,
	"time_zone" text NOT NULL,
	"prompt" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"pause_reason" text,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_prompt_schedule_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"catch_up_from" timestamp with time zone,
	"prompt_snapshot" text NOT NULL,
	"thread_id" text,
	"message_id" text NOT NULL,
	"turn_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_prompt_schedule_runs_occurrence_idx" UNIQUE("schedule_id","scheduled_for")
);
--> statement-breakpoint
ALTER TABLE "project_prompt_schedules" ADD CONSTRAINT "project_prompt_schedules_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_prompt_schedules" ADD CONSTRAINT "project_prompt_schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_prompt_schedules" ADD CONSTRAINT "project_prompt_schedules_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_prompt_schedules" ADD CONSTRAINT "project_prompt_schedules_organization_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_prompt_schedule_runs" ADD CONSTRAINT "project_prompt_schedule_runs_schedule_id_project_prompt_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."project_prompt_schedules"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_prompt_schedule_runs" ADD CONSTRAINT "project_prompt_schedule_runs_turn_id_thread_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."thread_turns"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "project_prompt_schedules_project_idx" ON "project_prompt_schedules" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "project_prompt_schedules_creator_idx" ON "project_prompt_schedules" USING btree ("created_by_user_id");
--> statement-breakpoint
CREATE INDEX "project_prompt_schedules_due_idx" ON "project_prompt_schedules" USING btree ("enabled","next_run_at");
--> statement-breakpoint
CREATE INDEX "project_prompt_schedule_runs_status_idx" ON "project_prompt_schedule_runs" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "project_prompt_schedule_runs_thread_idx" ON "project_prompt_schedule_runs" USING btree ("thread_id");
--> statement-breakpoint
CREATE INDEX "project_prompt_schedule_runs_turn_idx" ON "project_prompt_schedule_runs" USING btree ("turn_id");
--> statement-breakpoint
CREATE FUNCTION "pause_project_prompt_schedules_on_member_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	WITH "paused" AS (
		UPDATE "project_prompt_schedules"
		SET
			"enabled" = false,
			"pause_reason" = 'creator_access_lost',
			"next_run_at" = NULL,
			"updated_at" = now()
		WHERE
			"organization_id" = OLD."organizationId"
			AND "created_by_user_id" = OLD."userId"
			AND "enabled" = true
		RETURNING "id", "project_id"
	)
	INSERT INTO "project_audit_events" (
		"id",
		"project_id",
		"actor_user_id",
		"action",
		"target_type",
		"target_id",
		"metadata",
		"created_at"
	)
	SELECT
		gen_random_uuid()::text,
		"project_id",
		NULL,
		'project.schedule.paused',
		'project_prompt_schedule',
		"id",
		jsonb_build_object('reason', 'creator_access_lost'),
		now()
	FROM "paused";
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "member_delete_pause_project_prompt_schedules"
BEFORE DELETE ON "member"
FOR EACH ROW
EXECUTE FUNCTION "pause_project_prompt_schedules_on_member_delete"();
