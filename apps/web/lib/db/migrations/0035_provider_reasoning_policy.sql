ALTER TABLE "environments"
  ADD COLUMN IF NOT EXISTS "reasoning_request_mode" text NOT NULL DEFAULT 'provider_visible',
  ADD COLUMN IF NOT EXISTS "reasoning_effort" text,
  ADD COLUMN IF NOT EXISTS "reasoning_retention_mode" text NOT NULL DEFAULT 'live_only',
  ADD COLUMN IF NOT EXISTS "reasoning_retention_days" integer NOT NULL DEFAULT 7;

DO $$ BEGIN
  ALTER TABLE "environments" ADD CONSTRAINT "environments_reasoning_request_mode_check"
    CHECK ("reasoning_request_mode" IN ('off', 'summary', 'provider_visible'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "environments" ADD CONSTRAINT "environments_reasoning_effort_check"
    CHECK ("reasoning_effort" IS NULL OR "reasoning_effort" IN ('low', 'medium', 'high'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "environments" ADD CONSTRAINT "environments_reasoning_retention_mode_check"
    CHECK ("reasoning_retention_mode" IN ('live_only', 'provider_visible'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "environments" ADD CONSTRAINT "environments_reasoning_retention_days_check"
    CHECK ("reasoning_retention_days" BETWEEN 1 AND 30);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "environment_run_executions"
  ADD COLUMN IF NOT EXISTS "runtime_run_id" text,
  ADD COLUMN IF NOT EXISTS "reasoning_policy_snapshot" jsonb,
  ADD COLUMN IF NOT EXISTS "reasoning_key_ready" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "environment_run_executions_runtime_run_idx"
  ON "environment_run_executions" ("runtime_run_id");
