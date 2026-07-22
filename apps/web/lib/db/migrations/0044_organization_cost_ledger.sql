ALTER TABLE "thread_messages" ADD COLUMN IF NOT EXISTS "cached_input_tokens" integer;
--> statement-breakpoint
ALTER TABLE "thread_messages" ADD COLUMN IF NOT EXISTS "reasoning_tokens" integer;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "organization_usage_events" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "actor_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "project_id" text REFERENCES "projects"("id") ON DELETE SET NULL,
  "thread_id" text REFERENCES "threads"("id") ON DELETE SET NULL,
  "run_id" text,
  "category" text NOT NULL,
  "provider" text NOT NULL,
  "service" text NOT NULL,
  "meter" text NOT NULL,
  "quantity" numeric(24, 8) NOT NULL,
  "unit" text NOT NULL,
  "reported_amount_usd" numeric(20, 8),
  "source_kind" text NOT NULL,
  "source_id" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "interval_started_at" timestamp with time zone,
  "interval_ended_at" timestamp with time zone,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_usage_events_category_check" CHECK ("category" IN ('models', 'environments', 'managed_compute', 'services')),
  CONSTRAINT "organization_usage_events_quantity_check" CHECK ("quantity" >= 0),
  CONSTRAINT "organization_usage_events_reported_amount_check" CHECK ("reported_amount_usd" IS NULL OR "reported_amount_usd" >= 0),
  CONSTRAINT "organization_usage_events_interval_check" CHECK ("interval_ended_at" IS NULL OR ("interval_started_at" IS NOT NULL AND "interval_ended_at" >= "interval_started_at"))
);
--> statement-breakpoint
ALTER TABLE "organization_usage_events"
  ADD CONSTRAINT "organization_usage_events_source_meter_idx"
  UNIQUE NULLS NOT DISTINCT ("organization_id", "source_kind", "source_id", "meter", "interval_started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_usage_events_org_occurred_idx"
  ON "organization_usage_events" ("organization_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_usage_events_service_idx"
  ON "organization_usage_events" ("organization_id", "provider", "service", "meter");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cost_rate_cards" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text REFERENCES "organization"("id") ON DELETE CASCADE,
  "category" text NOT NULL,
  "provider" text NOT NULL,
  "service" text NOT NULL,
  "meter" text NOT NULL,
  "unit" text NOT NULL,
  "rate_kind" text DEFAULT 'unit' NOT NULL,
  "unit_price_usd" numeric(20, 10) NOT NULL,
  "provenance" text NOT NULL,
  "source_url" text,
  "effective_from" timestamp with time zone NOT NULL,
  "effective_to" timestamp with time zone,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cost_rate_cards_category_check" CHECK ("category" IN ('models', 'environments', 'managed_compute', 'services')),
  CONSTRAINT "cost_rate_cards_rate_kind_check" CHECK ("rate_kind" IN ('unit', 'monthly', 'annual')),
  CONSTRAINT "cost_rate_cards_provenance_check" CHECK ("provenance" IN ('published', 'contract', 'assumption')),
  CONSTRAINT "cost_rate_cards_price_check" CHECK ("unit_price_usd" >= 0),
  CONSTRAINT "cost_rate_cards_effective_check" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);
--> statement-breakpoint
ALTER TABLE "cost_rate_cards"
  ADD CONSTRAINT "cost_rate_cards_scope_effective_idx"
  UNIQUE NULLS NOT DISTINCT ("organization_id", "category", "provider", "service", "meter", "unit", "effective_from");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_rate_cards_lookup_idx"
  ON "cost_rate_cards" ("organization_id", "category", "provider", "service", "meter", "enabled", "effective_from");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "organization_cost_entries" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "usage_event_id" text NOT NULL REFERENCES "organization_usage_events"("id") ON DELETE CASCADE,
  "rate_card_id" text REFERENCES "cost_rate_cards"("id") ON DELETE RESTRICT,
  "supersedes_entry_id" text,
  "revision" integer DEFAULT 1 NOT NULL,
  "amount_usd" numeric(20, 8) NOT NULL,
  "quantity" numeric(24, 8) NOT NULL,
  "unit_price_usd" numeric(20, 10),
  "pricing_basis" text NOT NULL,
  "rate_snapshot" jsonb,
  "is_current" boolean DEFAULT true NOT NULL,
  "priced_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_cost_entries_supersedes_fk" FOREIGN KEY ("supersedes_entry_id") REFERENCES "organization_cost_entries"("id") ON DELETE RESTRICT,
  CONSTRAINT "organization_cost_entries_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "organization_cost_entries_amount_check" CHECK ("amount_usd" >= 0),
  CONSTRAINT "organization_cost_entries_basis_check" CHECK ("pricing_basis" IN ('provider_reported', 'measured_at_rate', 'allocated_fixed', 'assumed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_cost_entries_usage_revision_idx"
  ON "organization_cost_entries" ("usage_event_id", "revision");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_cost_entries_current_idx"
  ON "organization_cost_entries" ("usage_event_id") WHERE "is_current" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_cost_entries_org_priced_idx"
  ON "organization_cost_entries" ("organization_id", "priced_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "organization_dashboard_settings" (
  "organization_id" text PRIMARY KEY NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "cost_visibility" text DEFAULT 'all_members' NOT NULL,
  "updated_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_dashboard_settings_visibility_check" CHECK ("cost_visibility" IN ('all_members', 'admins_only'))
);
--> statement-breakpoint

-- Public Fly rates as of 2026-07-22. Organization overrides supersede these.
INSERT INTO "cost_rate_cards" (
  "id", "organization_id", "category", "provider", "service", "meter", "unit",
  "rate_kind", "unit_price_usd", "provenance", "source_url",
  "effective_from", "enabled", "created_at", "updated_at"
) VALUES
  ('rate_fly_shared_1x_512mb_20260722', NULL, 'environments', 'fly', 'machine.shared-cpu-1x.512mb', 'running_seconds', 'second', 'unit', 0.00000128, 'assumption', 'https://fly.io/docs/about/pricing/', '2026-07-22T00:00:00Z', true, now(), now()),
  ('rate_fly_shared_2x_4096mb_20260722', NULL, 'environments', 'fly', 'machine.shared-cpu-2x.4096mb', 'running_seconds', 'second', 'unit', 0.00000857, 'assumption', 'https://fly.io/docs/about/pricing/', '2026-07-22T00:00:00Z', true, now(), now()),
  ('rate_fly_volume_20260722', NULL, 'environments', 'fly', 'volume', 'provisioned_gb_hours', 'gb_hour', 'unit', 0.0002054795, 'assumption', 'https://fly.io/docs/about/pricing/', '2026-07-22T00:00:00Z', true, now(), now()),
  ('rate_fly_stopped_rootfs_20260722', NULL, 'environments', 'fly', 'machine.rootfs', 'stopped_gb_hours', 'gb_hour', 'unit', 0.0002054795, 'assumption', 'https://fly.io/docs/about/pricing/', '2026-07-22T00:00:00Z', true, now(), now()),
  ('rate_fly_snapshot_20260722', NULL, 'environments', 'fly', 'volume_snapshot', 'stored_gb_hours', 'gb_hour', 'unit', 0.0001095890, 'assumption', 'https://fly.io/docs/about/pricing/', '2026-07-22T00:00:00Z', true, now(), now()),
  ('rate_fly_egress_na_eu_20260722', NULL, 'environments', 'fly', 'network.public_egress.na_eu', 'outbound_gb', 'gb', 'unit', 0.02, 'published', 'https://fly.io/docs/about/pricing/', '2026-07-22T00:00:00Z', true, now(), now()),
  ('rate_fly_egress_apac_sa_20260722', NULL, 'environments', 'fly', 'network.public_egress.apac_oceania_sa', 'outbound_gb', 'gb', 'unit', 0.04, 'published', 'https://fly.io/docs/about/pricing/', '2026-07-22T00:00:00Z', true, now(), now()),
  ('rate_fly_egress_africa_india_20260722', NULL, 'environments', 'fly', 'network.public_egress.africa_india', 'outbound_gb', 'gb', 'unit', 0.12, 'published', 'https://fly.io/docs/about/pricing/', '2026-07-22T00:00:00Z', true, now(), now())
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Published unit prices and explicit pay-as-you-go assumptions for supported defaults.
-- Organization contract rates supersede these without rewriting historical entries.
INSERT INTO "cost_rate_cards" (
  "id", "organization_id", "category", "provider", "service", "meter", "unit",
  "rate_kind", "unit_price_usd", "provenance", "source_url",
  "effective_from", "enabled", "created_at", "updated_at"
) VALUES
  ('rate_openai_gpt5mini_input_20260722', NULL, 'models', 'openai', 'gpt-5-mini', 'input_tokens', 'token', 'unit', 0.00000025, 'published', 'https://developers.openai.com/api/docs/models/gpt-5-mini', '2026-07-22T00:00:00Z', true, now(), now()),
  ('rate_openai_gpt5mini_cached_input_20260722', NULL, 'models', 'openai', 'gpt-5-mini', 'cached_input_tokens', 'token', 'unit', 0.000000025, 'published', 'https://developers.openai.com/api/docs/models/gpt-5-mini', '2026-07-22T00:00:00Z', true, now(), now()),
  ('rate_openai_gpt5mini_output_20260722', NULL, 'models', 'openai', 'gpt-5-mini', 'output_tokens', 'token', 'unit', 0.00000200, 'published', 'https://developers.openai.com/api/docs/models/gpt-5-mini', '2026-07-22T00:00:00Z', true, now(), now()),
  ('rate_tavily_search_20260722', NULL, 'services', 'tavily', 'tavily', 'search', 'invocation', 'unit', 0.008, 'assumption', 'https://docs.tavily.com/documentation/api-credits', '2026-07-22T00:00:00Z', true, now(), now()),
  ('rate_tavily_search_advanced_20260722', NULL, 'services', 'tavily', 'tavily', 'search_advanced', 'invocation', 'unit', 0.016, 'assumption', 'https://docs.tavily.com/documentation/api-credits', '2026-07-22T00:00:00Z', true, now(), now()),
  ('rate_ngrok_preview_lease_20260722', NULL, 'services', 'ngrok', 'preview_lease', 'lease_hours', 'hour', 'unit', 0.02, 'assumption', 'https://ngrok.com/pricing', '2026-07-22T00:00:00Z', true, now(), now()),
  ('rate_resend_recipient_20260722', NULL, 'services', 'resend', 'organization_email', 'recipients', 'recipient', 'unit', 0.0009, 'assumption', 'https://resend.com/docs/knowledge-base/what-is-resend-pricing', '2026-07-22T00:00:00Z', true, now(), now())
ON CONFLICT DO NOTHING;
