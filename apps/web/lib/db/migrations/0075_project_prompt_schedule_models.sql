ALTER TABLE "project_prompt_schedules"
  ADD COLUMN "model_id" text;

ALTER TABLE "project_prompt_schedule_runs"
  ADD COLUMN "model_id_snapshot" text;
