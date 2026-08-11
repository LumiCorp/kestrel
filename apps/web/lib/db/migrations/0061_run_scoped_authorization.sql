ALTER TABLE "environment_run_executions"
  ADD COLUMN "authorization_renewal_token_hash" text;
--> statement-breakpoint
ALTER TABLE "environment_run_executions"
  ADD COLUMN "project_context_grant_id" text;
