ALTER TABLE "project_prompt_schedules"
  ADD COLUMN "title" text;
--> statement-breakpoint
UPDATE "project_prompt_schedules"
SET "title" = 'Untitled schedule'
WHERE "title" IS NULL;
--> statement-breakpoint
ALTER TABLE "project_prompt_schedules"
  ALTER COLUMN "title" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_prompt_schedule_runs"
  ADD COLUMN "title_snapshot" text,
  ADD COLUMN "trigger" text DEFAULT 'scheduled' NOT NULL,
  ADD COLUMN "request_id" text;
--> statement-breakpoint
UPDATE "project_prompt_schedule_runs" AS "runs"
SET "title_snapshot" = "schedules"."title"
FROM "project_prompt_schedules" AS "schedules"
WHERE
  "runs"."schedule_id" = "schedules"."id"
  AND "runs"."title_snapshot" IS NULL;
--> statement-breakpoint
ALTER TABLE "project_prompt_schedule_runs"
  ALTER COLUMN "title_snapshot" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "project_prompt_schedule_runs_request_idx"
  ON "project_prompt_schedule_runs" USING btree ("schedule_id", "request_id");
