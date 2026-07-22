ALTER TABLE "ai_provider_connections"
  DROP CONSTRAINT IF EXISTS "ai_provider_connections_provider_check";
--> statement-breakpoint
ALTER TABLE "ai_provider_connections"
  ADD CONSTRAINT "ai_provider_connections_provider_check"
  CHECK ("provider" IN ('fly', 'runpod'));
