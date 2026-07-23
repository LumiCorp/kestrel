-- Reassert the Fly provider contract for databases whose migration ledger
-- advanced past 0043 before that migration reached the deployment branch.
ALTER TABLE "ai_provider_connections"
  DROP CONSTRAINT IF EXISTS "ai_provider_connections_provider_check";
--> statement-breakpoint
ALTER TABLE "ai_provider_connections"
  ADD CONSTRAINT "ai_provider_connections_provider_check"
  CHECK ("provider" IN ('fly', 'runpod'));
