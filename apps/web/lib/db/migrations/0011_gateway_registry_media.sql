CREATE TABLE IF NOT EXISTS "ai_gateways" (
  "id" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "display_name" text NOT NULL,
  "base_url" text,
  "api_key_env_var" text,
  "api_key" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "supported_modalities" jsonb NOT NULL DEFAULT '["language"]'::jsonb,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "ai_gateway_models" (
  "id" text PRIMARY KEY NOT NULL,
  "gateway_id" text NOT NULL REFERENCES "ai_gateways"("id") ON DELETE cascade,
  "raw_model_id" text NOT NULL,
  "alias" text,
  "modality" text NOT NULL,
  "approved" boolean DEFAULT true NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "description" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "message_speech_assets" (
  "id" text PRIMARY KEY NOT NULL,
  "message_id" text NOT NULL REFERENCES "messages"("id") ON DELETE cascade,
  "model_id" text NOT NULL,
  "voice" text DEFAULT 'alloy' NOT NULL,
  "text_hash" text NOT NULL,
  "storage_key" text NOT NULL,
  "media_type" text DEFAULT 'audio/mpeg' NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "media_generation_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "chat_id" text REFERENCES "chats"("id") ON DELETE set null,
  "artifact_id" text,
  "kind" text NOT NULL,
  "gateway_id" text REFERENCES "ai_gateways"("id") ON DELETE set null,
  "model_id" text NOT NULL,
  "prompt" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "provider_job_id" text,
  "output_url" text,
  "output_storage_key" text,
  "error" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "artifact_documents" DROP CONSTRAINT IF EXISTS "artifact_documents_kind_check";
EXCEPTION
  WHEN undefined_table THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "ai_gateways_enabled_idx" ON "ai_gateways" ("enabled");
CREATE INDEX IF NOT EXISTS "ai_gateways_provider_idx" ON "ai_gateways" ("provider");
CREATE UNIQUE INDEX IF NOT EXISTS "ai_gateways_provider_display_name_idx" ON "ai_gateways" ("provider", "display_name");
CREATE INDEX IF NOT EXISTS "ai_gateway_models_gateway_id_idx" ON "ai_gateway_models" ("gateway_id");
CREATE INDEX IF NOT EXISTS "ai_gateway_models_modality_idx" ON "ai_gateway_models" ("modality");
CREATE INDEX IF NOT EXISTS "ai_gateway_models_approved_idx" ON "ai_gateway_models" ("approved");
CREATE UNIQUE INDEX IF NOT EXISTS "ai_gateway_models_gateway_raw_model_idx" ON "ai_gateway_models" ("gateway_id", "raw_model_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ai_gateway_models_alias_idx" ON "ai_gateway_models" ("alias");
CREATE UNIQUE INDEX IF NOT EXISTS "message_speech_assets_cache_idx" ON "message_speech_assets" ("message_id", "model_id", "voice", "text_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "message_speech_assets_storage_key_idx" ON "message_speech_assets" ("storage_key");
CREATE INDEX IF NOT EXISTS "message_speech_assets_message_id_idx" ON "message_speech_assets" ("message_id");
CREATE INDEX IF NOT EXISTS "media_generation_jobs_org_id_idx" ON "media_generation_jobs" ("organization_id");
CREATE INDEX IF NOT EXISTS "media_generation_jobs_chat_id_idx" ON "media_generation_jobs" ("chat_id");
CREATE INDEX IF NOT EXISTS "media_generation_jobs_status_idx" ON "media_generation_jobs" ("status");
CREATE INDEX IF NOT EXISTS "media_generation_jobs_kind_idx" ON "media_generation_jobs" ("kind");
CREATE INDEX IF NOT EXISTS "media_generation_jobs_gateway_id_idx" ON "media_generation_jobs" ("gateway_id");
