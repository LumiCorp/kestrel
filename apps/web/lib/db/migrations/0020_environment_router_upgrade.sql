-- Migration 0014 was amended after some installations had already applied it.
-- Carry those router fields forward explicitly so upgraded databases converge
-- with fresh installations without replaying or rewriting migration history.
ALTER TABLE "environments"
  ADD COLUMN IF NOT EXISTS "fly_gateway_machine_id" text;
ALTER TABLE "environments"
  ADD COLUMN IF NOT EXISTS "router_url" text;
ALTER TABLE "environments"
  ADD COLUMN IF NOT EXISTS "router_image" text;
