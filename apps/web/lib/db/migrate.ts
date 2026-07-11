import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";

config({
  path: ".env.local",
});

const runMigrate = async () => {
  const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.log(
      "⏭️  POSTGRES_URL/DATABASE_URL not defined, skipping migrations"
    );
    process.exit(0);
  }

  const connection = postgres(databaseUrl, { max: 1 });
  const db = drizzle(connection);

  console.log("⏳ Running migrations...");

  const start = Date.now();
  await migrate(db, {
    migrationsFolder: "./drizzle/migrations",
    migrationsTable: "__unified_app_migrations",
  });
  // Bootstrap the legacy knowledge/chat tables before applying follow-up
  // migrations that add foreign keys against them.
  await ensureKnowledgeSchema(connection);
  await migrate(db, {
    migrationsFolder: "./lib/db/migrations",
  });
  const { backfillPersonalWorkspaceData } = await import(
    "@/lib/personal-workspace"
  );
  await backfillPersonalWorkspaceData();
  const end = Date.now();

  console.log("✅ Migrations completed in", end - start, "ms");
  process.exit(0);
};

async function ensureKnowledgeSchema(connection: Sql) {
  await connection.unsafe(`
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS "chats" (
      "id" text PRIMARY KEY NOT NULL,
      "title" text,
      "user_id" text NOT NULL,
      "organization_id" text,
      "mode" text DEFAULT 'chat' NOT NULL,
      "active_stream_id" text,
      "is_public" boolean DEFAULT false NOT NULL,
      "share_token" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "messages" (
      "id" text PRIMARY KEY NOT NULL,
      "chat_id" text NOT NULL,
      "role" text NOT NULL,
      "parts" jsonb,
      "feedback" text,
      "model" text,
      "input_tokens" integer,
      "output_tokens" integer,
      "duration_ms" integer,
      "external_message_id" text,
      "source" text DEFAULT 'web',
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "sources" (
      "id" text PRIMARY KEY NOT NULL,
      "organization_id" text,
      "type" text NOT NULL,
      "label" text NOT NULL,
      "base_path" text DEFAULT '/docs',
      "repo" text,
      "branch" text,
      "content_path" text,
      "output_path" text,
      "readme_only" boolean DEFAULT false,
      "channel_id" text,
      "handle" text,
      "max_videos" integer DEFAULT 50,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "knowledge_snapshots" (
      "id" text PRIMARY KEY NOT NULL,
      "organization_id" text NOT NULL,
      "status" text DEFAULT 'building' NOT NULL,
      "filesystem_path" text NOT NULL,
      "source_count" integer DEFAULT 0 NOT NULL,
      "file_count" integer DEFAULT 0 NOT NULL,
      "is_active" boolean DEFAULT false NOT NULL,
      "last_synced_at" timestamp with time zone,
      "error" text,
      "metadata" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "knowledge_sync_runs" (
      "id" text PRIMARY KEY NOT NULL,
      "organization_id" text NOT NULL,
      "requested_by_user_id" text,
      "source_filter" text,
      "status" text DEFAULT 'queued' NOT NULL,
      "snapshot_id" text,
      "source_count" integer DEFAULT 0 NOT NULL,
      "file_count" integer DEFAULT 0 NOT NULL,
      "started_at" timestamp with time zone,
      "finished_at" timestamp with time zone,
      "error" text,
      "metadata" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "discord_guild_bindings" (
      "organization_id" text PRIMARY KEY NOT NULL,
      "guild_id" text NOT NULL,
      "guild_name" text,
      "enabled" boolean DEFAULT true NOT NULL,
      "last_webhook_at" timestamp with time zone,
      "last_gateway_started_at" timestamp with time zone,
      "last_event_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "tool_providers" (
      "key" text PRIMARY KEY NOT NULL,
      "display_name" text NOT NULL,
      "description" text,
      "type" text NOT NULL,
      "auth_type" text DEFAULT 'none' NOT NULL,
      "metadata" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "tool_capabilities" (
      "provider_key" text NOT NULL,
      "key" text NOT NULL,
      "runtime_name" text,
      "display_name" text NOT NULL,
      "description" text,
      "access_mode" text NOT NULL,
      "default_enabled" boolean DEFAULT true NOT NULL,
      "default_approval_mode" text DEFAULT 'auto' NOT NULL,
      "default_surface_access" jsonb DEFAULT '{"chat": true, "admin": false}'::jsonb NOT NULL,
      "default_rate_limit_mode" text DEFAULT 'default' NOT NULL,
      "default_logging_mode" text DEFAULT 'full' NOT NULL,
      "default_settings" jsonb,
      "metadata" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      PRIMARY KEY ("provider_key", "key")
    );

    CREATE TABLE IF NOT EXISTS "organization_tool_providers" (
      "organization_id" text NOT NULL,
      "provider_key" text NOT NULL,
      "enabled" boolean DEFAULT true NOT NULL,
      "settings" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      PRIMARY KEY ("organization_id", "provider_key")
    );

    CREATE TABLE IF NOT EXISTS "organization_tool_capabilities" (
      "organization_id" text NOT NULL,
      "provider_key" text NOT NULL,
      "capability_key" text NOT NULL,
      "enabled" boolean DEFAULT true NOT NULL,
      "approval_mode" text DEFAULT 'auto' NOT NULL,
      "surface_access" jsonb DEFAULT '{"chat": true, "admin": false}'::jsonb NOT NULL,
      "rate_limit_mode" text DEFAULT 'default' NOT NULL,
      "logging_mode" text DEFAULT 'full' NOT NULL,
      "settings" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      PRIMARY KEY ("organization_id", "provider_key", "capability_key")
    );

    CREATE TABLE IF NOT EXISTS "organization_tool_connections" (
      "organization_id" text NOT NULL,
      "provider_key" text NOT NULL,
      "auth_source" text NOT NULL,
      "status" text DEFAULT 'not_configured' NOT NULL,
      "account_id" text,
      "credential_ref" text,
      "metadata" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      PRIMARY KEY ("organization_id", "provider_key")
    );

    CREATE TABLE IF NOT EXISTS "agent_config" (
      "id" text PRIMARY KEY NOT NULL,
      "organization_id" text,
      "name" text DEFAULT 'default' NOT NULL,
      "additional_prompt" text,
      "response_style" text DEFAULT 'concise',
      "language" text DEFAULT 'en',
      "default_model" text,
      "max_steps_multiplier" real DEFAULT 1.0,
      "temperature" real DEFAULT 0.7,
      "search_instructions" text,
      "citation_format" text DEFAULT 'inline',
      "is_active" boolean DEFAULT true NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "ai_gateways" (
      "id" text PRIMARY KEY NOT NULL,
      "provider" text NOT NULL,
      "display_name" text NOT NULL,
      "base_url" text,
      "api_key_env_var" text,
      "api_key" text,
      "enabled" boolean DEFAULT true NOT NULL,
      "supported_modalities" jsonb DEFAULT '["language"]'::jsonb NOT NULL,
      "metadata" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "ai_gateway_models" (
      "id" text PRIMARY KEY NOT NULL,
      "gateway_id" text NOT NULL,
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

    CREATE TABLE IF NOT EXISTS "api_usage" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL,
      "organization_id" text,
      "source" text NOT NULL,
      "source_id" text,
      "model" text,
      "input_tokens" integer,
      "output_tokens" integer,
      "duration_ms" integer,
      "metadata" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "usage_stats" (
      "id" text PRIMARY KEY NOT NULL,
      "date" text NOT NULL,
      "user_id" text NOT NULL,
      "organization_id" text,
      "source" text DEFAULT 'web' NOT NULL,
      "model" text NOT NULL,
      "message_count" integer DEFAULT 0 NOT NULL,
      "total_input_tokens" integer DEFAULT 0 NOT NULL,
      "total_output_tokens" integer DEFAULT 0 NOT NULL,
      "total_duration_ms" integer DEFAULT 0 NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "knowledge_kv" (
      "key" text PRIMARY KEY NOT NULL,
      "organization_id" text,
      "value" jsonb NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "artifact_documents" (
      "id" text NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "title" text NOT NULL,
      "content" text,
      "kind" text DEFAULT 'text' NOT NULL,
      "user_id" text NOT NULL,
      "organization_id" text NOT NULL,
      "chat_id" text,
      PRIMARY KEY ("id", "created_at")
    );

    CREATE TABLE IF NOT EXISTS "message_speech_assets" (
      "id" text PRIMARY KEY NOT NULL,
      "message_id" text NOT NULL,
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
      "organization_id" text NOT NULL,
      "user_id" text NOT NULL,
      "chat_id" text,
      "artifact_id" text,
      "kind" text NOT NULL,
      "gateway_id" text,
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

    CREATE TABLE IF NOT EXISTS "artifact_suggestions" (
      "id" text PRIMARY KEY NOT NULL,
      "document_id" text NOT NULL,
      "document_created_at" timestamp with time zone NOT NULL,
      "original_text" text NOT NULL,
      "suggested_text" text NOT NULL,
      "description" text,
      "is_resolved" boolean DEFAULT false NOT NULL,
      "user_id" text NOT NULL,
      "organization_id" text NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "admin_event_logs" (
      "id" text PRIMARY KEY NOT NULL,
      "organization_id" text,
      "actor_user_id" text,
      "level" text DEFAULT 'info' NOT NULL,
      "category" text NOT NULL,
      "action" text NOT NULL,
      "target_type" text,
      "target_id" text,
      "message" text NOT NULL,
      "metadata" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "admin_api_keys" (
      "id" text PRIMARY KEY NOT NULL,
      "organization_id" text NOT NULL,
      "creator_user_id" text NOT NULL,
      "name" text NOT NULL,
      "prefix" text DEFAULT 'sk' NOT NULL,
      "start" text NOT NULL,
      "hashed_secret" text NOT NULL,
      "enabled" boolean DEFAULT true NOT NULL,
      "expires_at" timestamp with time zone,
      "last_used_at" timestamp with time zone,
      "last_used_metadata" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "knowledge_documents" (
      "id" text PRIMARY KEY NOT NULL,
      "organization_id" text NOT NULL,
      "uploader_user_id" text NOT NULL,
      "title" text,
      "filename" text NOT NULL,
      "original_filename" text NOT NULL,
      "media_type" text NOT NULL,
      "size_bytes" integer DEFAULT 0 NOT NULL,
      "checksum_sha256" text NOT NULL,
      "storage_key" text NOT NULL,
      "status" text DEFAULT 'uploaded' NOT NULL,
      "page_count" integer,
      "chunk_count" integer DEFAULT 0 NOT NULL,
      "extraction_metadata" jsonb,
      "error" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "knowledge_ingestion_runs" (
      "id" text PRIMARY KEY NOT NULL,
      "organization_id" text NOT NULL,
      "document_id" text NOT NULL,
      "requested_by_user_id" text,
      "stage" text DEFAULT 'upload' NOT NULL,
      "status" text DEFAULT 'queued' NOT NULL,
      "attempt_count" integer DEFAULT 0 NOT NULL,
      "started_at" timestamp with time zone,
      "finished_at" timestamp with time zone,
      "diagnostics" jsonb,
      "error" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "knowledge_document_chunks" (
      "id" text PRIMARY KEY NOT NULL,
      "organization_id" text NOT NULL,
      "document_id" text NOT NULL,
      "chunk_index" integer NOT NULL,
      "content" text NOT NULL,
      "content_length" integer DEFAULT 0 NOT NULL,
      "token_count" integer DEFAULT 0 NOT NULL,
      "page_number" integer,
      "section_title" text,
      "metadata" jsonb,
      "embedding" vector(1536) NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "apikey" (
      "id" text PRIMARY KEY NOT NULL,
      "configId" text DEFAULT 'default' NOT NULL,
      "name" text,
      "start" text,
      "referenceId" text,
      "prefix" text,
      "key" text NOT NULL,
      "userId" text,
      "refillInterval" integer,
      "refillAmount" integer,
      "lastRefillAt" timestamp with time zone,
      "enabled" boolean DEFAULT true,
      "rateLimitEnabled" boolean DEFAULT true,
      "rateLimitTimeWindow" integer,
      "rateLimitMax" integer,
      "requestCount" integer,
      "remaining" integer,
      "lastRequest" timestamp with time zone,
      "expiresAt" timestamp with time zone,
      "permissions" text,
      "metadata" text,
      "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
      "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
    );

    ALTER TABLE "apikey" ADD COLUMN IF NOT EXISTS "configId" text DEFAULT 'default';
    ALTER TABLE "apikey" ADD COLUMN IF NOT EXISTS "referenceId" text;
    ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "stripeCustomerId" text;
    ALTER TABLE "subscription" ADD COLUMN IF NOT EXISTS "createdAt" timestamp with time zone DEFAULT now();
    ALTER TABLE "subscription" ADD COLUMN IF NOT EXISTS "updatedAt" timestamp with time zone DEFAULT now();
    ALTER TABLE "subscription" ADD COLUMN IF NOT EXISTS "cancelAt" timestamp with time zone;
    ALTER TABLE "subscription" ADD COLUMN IF NOT EXISTS "canceledAt" timestamp with time zone;
    ALTER TABLE "subscription" ADD COLUMN IF NOT EXISTS "endedAt" timestamp with time zone;
    ALTER TABLE "subscription" ADD COLUMN IF NOT EXISTS "billingInterval" text;
    ALTER TABLE "subscription" ADD COLUMN IF NOT EXISTS "stripeScheduleId" text;
    ALTER TABLE "subscription" ADD COLUMN IF NOT EXISTS "limits" jsonb;
    UPDATE "subscription" SET "createdAt" = COALESCE("createdAt", now()) WHERE "createdAt" IS NULL;
    UPDATE "subscription" SET "updatedAt" = COALESCE("updatedAt", now()) WHERE "updatedAt" IS NULL;
    UPDATE "apikey" SET "configId" = COALESCE("configId", 'default') WHERE "configId" IS NULL;
    UPDATE "apikey" SET "referenceId" = COALESCE("referenceId", "userId") WHERE "referenceId" IS NULL;

    DO $$ BEGIN
      ALTER TABLE "apikey" ALTER COLUMN "userId" DROP NOT NULL;
    EXCEPTION
      WHEN others THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "apikey" ALTER COLUMN "configId" SET NOT NULL;
    EXCEPTION
      WHEN others THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "apikey" ALTER COLUMN "referenceId" SET NOT NULL;
    EXCEPTION
      WHEN others THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "subscription" ALTER COLUMN "createdAt" SET NOT NULL;
    EXCEPTION
      WHEN others THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "subscription" ALTER COLUMN "updatedAt" SET NOT NULL;
    EXCEPTION
      WHEN others THEN null;
    END $$;

    ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "organization_id" text;
    ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'web';
    ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "external_thread_id" text;
    ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "active_stream_id" text;
    ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "organization_id" text;
    ALTER TABLE "agent_config" ADD COLUMN IF NOT EXISTS "organization_id" text;
    ALTER TABLE "api_usage" ADD COLUMN IF NOT EXISTS "organization_id" text;
    ALTER TABLE "usage_stats" ADD COLUMN IF NOT EXISTS "organization_id" text;
    ALTER TABLE "knowledge_kv" ADD COLUMN IF NOT EXISTS "organization_id" text;
    ALTER TABLE "messages" ALTER COLUMN "source" TYPE text;
    ALTER TABLE "messages" ALTER COLUMN "source" SET DEFAULT 'web';
    ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "external_message_id" text;
    UPDATE "messages" SET "source" = 'web' WHERE "source" IS NULL;

    DO $$ BEGIN
      ALTER TABLE "chats"
      ADD CONSTRAINT "knowledge_chats_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "chats"
      ADD CONSTRAINT "knowledge_chats_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "messages"
      ADD CONSTRAINT "knowledge_messages_chat_fk"
      FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "api_usage"
      ADD CONSTRAINT "knowledge_api_usage_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "api_usage"
      ADD CONSTRAINT "knowledge_api_usage_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "usage_stats"
      ADD CONSTRAINT "knowledge_usage_stats_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "usage_stats"
      ADD CONSTRAINT "knowledge_usage_stats_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "sources"
      ADD CONSTRAINT "knowledge_sources_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "agent_config"
      ADD CONSTRAINT "knowledge_agent_config_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "knowledge_snapshots"
      ADD CONSTRAINT "knowledge_snapshots_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "knowledge_sync_runs"
      ADD CONSTRAINT "knowledge_sync_runs_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "knowledge_sync_runs"
      ADD CONSTRAINT "knowledge_sync_runs_requested_by_user_fk"
      FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "knowledge_sync_runs"
      ADD CONSTRAINT "knowledge_sync_runs_snapshot_fk"
      FOREIGN KEY ("snapshot_id") REFERENCES "public"."knowledge_snapshots"("id") ON DELETE set null ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "discord_guild_bindings"
      ADD CONSTRAINT "discord_guild_bindings_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "tool_capabilities"
      ADD CONSTRAINT "tool_capabilities_provider_fk"
      FOREIGN KEY ("provider_key") REFERENCES "public"."tool_providers"("key") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "organization_tool_providers"
      ADD CONSTRAINT "organization_tool_providers_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "organization_tool_providers"
      ADD CONSTRAINT "organization_tool_providers_provider_fk"
      FOREIGN KEY ("provider_key") REFERENCES "public"."tool_providers"("key") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "organization_tool_capabilities"
      ADD CONSTRAINT "organization_tool_capabilities_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "organization_tool_capabilities"
      ADD CONSTRAINT "organization_tool_capabilities_capability_fk"
      FOREIGN KEY ("provider_key", "capability_key")
      REFERENCES "public"."tool_capabilities"("provider_key", "key") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "organization_tool_connections"
      ADD CONSTRAINT "organization_tool_connections_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "organization_tool_connections"
      ADD CONSTRAINT "organization_tool_connections_provider_fk"
      FOREIGN KEY ("provider_key") REFERENCES "public"."tool_providers"("key") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "ai_gateway_models"
      ADD CONSTRAINT "ai_gateway_models_gateway_fk"
      FOREIGN KEY ("gateway_id") REFERENCES "public"."ai_gateways"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "artifact_documents"
      ADD CONSTRAINT "knowledge_artifact_documents_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "artifact_documents"
      ADD CONSTRAINT "knowledge_artifact_documents_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "artifact_documents"
      ADD CONSTRAINT "knowledge_artifact_documents_chat_fk"
      FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "message_speech_assets"
      ADD CONSTRAINT "message_speech_assets_message_fk"
      FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "media_generation_jobs"
      ADD CONSTRAINT "media_generation_jobs_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "media_generation_jobs"
      ADD CONSTRAINT "media_generation_jobs_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "media_generation_jobs"
      ADD CONSTRAINT "media_generation_jobs_chat_fk"
      FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "media_generation_jobs"
      ADD CONSTRAINT "media_generation_jobs_gateway_fk"
      FOREIGN KEY ("gateway_id") REFERENCES "public"."ai_gateways"("id") ON DELETE set null ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "artifact_suggestions"
      ADD CONSTRAINT "knowledge_artifact_suggestions_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "artifact_suggestions"
      ADD CONSTRAINT "knowledge_artifact_suggestions_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "artifact_suggestions"
      ADD CONSTRAINT "knowledge_artifact_suggestions_document_fk"
      FOREIGN KEY ("document_id", "document_created_at")
      REFERENCES "public"."artifact_documents"("id", "created_at") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "admin_event_logs"
      ADD CONSTRAINT "admin_event_logs_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "admin_event_logs"
      ADD CONSTRAINT "admin_event_logs_actor_user_fk"
      FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "admin_api_keys"
      ADD CONSTRAINT "admin_api_keys_org_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "admin_api_keys"
      ADD CONSTRAINT "admin_api_keys_creator_user_fk"
      FOREIGN KEY ("creator_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "apikey"
      ADD CONSTRAINT "apikey_user_fk"
      FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    CREATE INDEX IF NOT EXISTS "knowledge_chats_user_id_idx" ON "chats" ("user_id");
    CREATE INDEX IF NOT EXISTS "knowledge_chats_org_id_idx" ON "chats" ("organization_id");
    CREATE INDEX IF NOT EXISTS "ai_gateways_enabled_idx" ON "ai_gateways" ("enabled");
    CREATE INDEX IF NOT EXISTS "ai_gateways_provider_idx" ON "ai_gateways" ("provider");
    CREATE UNIQUE INDEX IF NOT EXISTS "ai_gateways_provider_display_name_idx" ON "ai_gateways" ("provider", "display_name");
    CREATE INDEX IF NOT EXISTS "ai_gateway_models_gateway_id_idx" ON "ai_gateway_models" ("gateway_id");
    CREATE INDEX IF NOT EXISTS "ai_gateway_models_modality_idx" ON "ai_gateway_models" ("modality");
    CREATE INDEX IF NOT EXISTS "ai_gateway_models_approved_idx" ON "ai_gateway_models" ("approved");
    CREATE UNIQUE INDEX IF NOT EXISTS "ai_gateway_models_gateway_raw_model_idx" ON "ai_gateway_models" ("gateway_id", "raw_model_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "ai_gateway_models_alias_idx" ON "ai_gateway_models" ("alias");
    CREATE INDEX IF NOT EXISTS "knowledge_chats_origin_idx" ON "chats" ("origin");
    CREATE INDEX IF NOT EXISTS "knowledge_chats_external_thread_id_idx" ON "chats" ("external_thread_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_chats_share_token_idx" ON "chats" ("share_token");
    CREATE INDEX IF NOT EXISTS "knowledge_messages_chat_id_idx" ON "messages" ("chat_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_messages_external_message_idx" ON "messages" ("chat_id", "external_message_id");
    CREATE INDEX IF NOT EXISTS "message_speech_assets_message_id_idx" ON "message_speech_assets" ("message_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "message_speech_assets_cache_idx" ON "message_speech_assets" ("message_id", "model_id", "voice", "text_hash");
    CREATE UNIQUE INDEX IF NOT EXISTS "message_speech_assets_storage_key_idx" ON "message_speech_assets" ("storage_key");
    CREATE INDEX IF NOT EXISTS "media_generation_jobs_org_id_idx" ON "media_generation_jobs" ("organization_id");
    CREATE INDEX IF NOT EXISTS "media_generation_jobs_chat_id_idx" ON "media_generation_jobs" ("chat_id");
    CREATE INDEX IF NOT EXISTS "media_generation_jobs_status_idx" ON "media_generation_jobs" ("status");
    CREATE INDEX IF NOT EXISTS "media_generation_jobs_kind_idx" ON "media_generation_jobs" ("kind");
    CREATE INDEX IF NOT EXISTS "media_generation_jobs_gateway_id_idx" ON "media_generation_jobs" ("gateway_id");
    CREATE INDEX IF NOT EXISTS "knowledge_sources_type_idx" ON "sources" ("type");
    CREATE INDEX IF NOT EXISTS "knowledge_sources_org_id_idx" ON "sources" ("organization_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "discord_guild_bindings_guild_id_idx" ON "discord_guild_bindings" ("guild_id");
    CREATE INDEX IF NOT EXISTS "discord_guild_bindings_enabled_idx" ON "discord_guild_bindings" ("enabled");
    CREATE INDEX IF NOT EXISTS "tool_providers_type_idx" ON "tool_providers" ("type");
    CREATE INDEX IF NOT EXISTS "tool_providers_auth_type_idx" ON "tool_providers" ("auth_type");
    CREATE INDEX IF NOT EXISTS "tool_capabilities_provider_idx" ON "tool_capabilities" ("provider_key");
    CREATE INDEX IF NOT EXISTS "tool_capabilities_runtime_name_idx" ON "tool_capabilities" ("runtime_name");
    CREATE INDEX IF NOT EXISTS "tool_capabilities_access_mode_idx" ON "tool_capabilities" ("access_mode");
    CREATE INDEX IF NOT EXISTS "organization_tool_providers_provider_idx" ON "organization_tool_providers" ("provider_key");
    CREATE INDEX IF NOT EXISTS "organization_tool_capabilities_provider_idx" ON "organization_tool_capabilities" ("provider_key");
    CREATE INDEX IF NOT EXISTS "organization_tool_connections_status_idx" ON "organization_tool_connections" ("status");
    CREATE INDEX IF NOT EXISTS "knowledge_snapshots_org_id_idx" ON "knowledge_snapshots" ("organization_id");
    CREATE INDEX IF NOT EXISTS "knowledge_snapshots_status_idx" ON "knowledge_snapshots" ("status");
    CREATE INDEX IF NOT EXISTS "knowledge_snapshots_active_idx" ON "knowledge_snapshots" ("is_active");
    CREATE INDEX IF NOT EXISTS "knowledge_snapshots_updated_at_idx" ON "knowledge_snapshots" ("updated_at");
    CREATE INDEX IF NOT EXISTS "knowledge_sync_runs_org_id_idx" ON "knowledge_sync_runs" ("organization_id");
    CREATE INDEX IF NOT EXISTS "knowledge_sync_runs_status_idx" ON "knowledge_sync_runs" ("status");
    CREATE INDEX IF NOT EXISTS "knowledge_sync_runs_snapshot_id_idx" ON "knowledge_sync_runs" ("snapshot_id");
    CREATE INDEX IF NOT EXISTS "knowledge_sync_runs_requested_by_user_id_idx" ON "knowledge_sync_runs" ("requested_by_user_id");
    CREATE INDEX IF NOT EXISTS "knowledge_sync_runs_updated_at_idx" ON "knowledge_sync_runs" ("updated_at");
    CREATE INDEX IF NOT EXISTS "knowledge_api_usage_user_id_idx" ON "api_usage" ("user_id");
    CREATE INDEX IF NOT EXISTS "knowledge_api_usage_org_id_idx" ON "api_usage" ("organization_id");
    CREATE INDEX IF NOT EXISTS "knowledge_api_usage_source_idx" ON "api_usage" ("source");
    CREATE INDEX IF NOT EXISTS "knowledge_api_usage_created_at_idx" ON "api_usage" ("created_at");
    CREATE INDEX IF NOT EXISTS "knowledge_usage_stats_date_idx" ON "usage_stats" ("date");
    CREATE INDEX IF NOT EXISTS "knowledge_usage_stats_org_id_idx" ON "usage_stats" ("organization_id");
    DROP INDEX IF EXISTS "knowledge_usage_stats_unique_idx";
    CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_usage_stats_unique_idx" ON "usage_stats" ("date", "organization_id", "user_id", "source", "model");
    CREATE INDEX IF NOT EXISTS "knowledge_kv_updated_idx" ON "knowledge_kv" ("updated_at");
    CREATE INDEX IF NOT EXISTS "knowledge_kv_org_id_idx" ON "knowledge_kv" ("organization_id");
    CREATE INDEX IF NOT EXISTS "knowledge_artifact_documents_id_idx" ON "artifact_documents" ("id");
    CREATE INDEX IF NOT EXISTS "knowledge_artifact_documents_user_id_idx" ON "artifact_documents" ("user_id");
    CREATE INDEX IF NOT EXISTS "knowledge_artifact_documents_org_id_idx" ON "artifact_documents" ("organization_id");
    CREATE INDEX IF NOT EXISTS "knowledge_artifact_documents_chat_id_idx" ON "artifact_documents" ("chat_id");
    CREATE INDEX IF NOT EXISTS "knowledge_artifact_suggestions_document_id_idx" ON "artifact_suggestions" ("document_id");
    CREATE INDEX IF NOT EXISTS "knowledge_artifact_suggestions_user_id_idx" ON "artifact_suggestions" ("user_id");
    CREATE INDEX IF NOT EXISTS "knowledge_artifact_suggestions_org_id_idx" ON "artifact_suggestions" ("organization_id");
    CREATE INDEX IF NOT EXISTS "admin_event_logs_org_id_idx" ON "admin_event_logs" ("organization_id");
    CREATE INDEX IF NOT EXISTS "admin_event_logs_actor_user_id_idx" ON "admin_event_logs" ("actor_user_id");
    CREATE INDEX IF NOT EXISTS "admin_event_logs_level_idx" ON "admin_event_logs" ("level");
    CREATE INDEX IF NOT EXISTS "admin_event_logs_created_at_idx" ON "admin_event_logs" ("created_at");
    CREATE INDEX IF NOT EXISTS "admin_api_keys_org_id_idx" ON "admin_api_keys" ("organization_id");
    CREATE INDEX IF NOT EXISTS "admin_api_keys_creator_user_id_idx" ON "admin_api_keys" ("creator_user_id");
    CREATE INDEX IF NOT EXISTS "admin_api_keys_enabled_idx" ON "admin_api_keys" ("enabled");
    CREATE INDEX IF NOT EXISTS "admin_api_keys_created_at_idx" ON "admin_api_keys" ("created_at");
    CREATE INDEX IF NOT EXISTS "knowledge_documents_org_id_idx" ON "knowledge_documents" ("organization_id");
    CREATE INDEX IF NOT EXISTS "knowledge_documents_uploader_user_id_idx" ON "knowledge_documents" ("uploader_user_id");
    CREATE INDEX IF NOT EXISTS "knowledge_documents_status_idx" ON "knowledge_documents" ("status");
    CREATE INDEX IF NOT EXISTS "knowledge_documents_created_at_idx" ON "knowledge_documents" ("created_at");
    CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_documents_storage_key_idx" ON "knowledge_documents" ("storage_key");
    CREATE INDEX IF NOT EXISTS "knowledge_ingestion_runs_org_id_idx" ON "knowledge_ingestion_runs" ("organization_id");
    CREATE INDEX IF NOT EXISTS "knowledge_ingestion_runs_document_id_idx" ON "knowledge_ingestion_runs" ("document_id");
    CREATE INDEX IF NOT EXISTS "knowledge_ingestion_runs_status_idx" ON "knowledge_ingestion_runs" ("status");
    CREATE INDEX IF NOT EXISTS "knowledge_ingestion_runs_stage_idx" ON "knowledge_ingestion_runs" ("stage");
    CREATE INDEX IF NOT EXISTS "knowledge_ingestion_runs_updated_at_idx" ON "knowledge_ingestion_runs" ("updated_at");
    CREATE INDEX IF NOT EXISTS "knowledge_document_chunks_org_id_idx" ON "knowledge_document_chunks" ("organization_id");
    CREATE INDEX IF NOT EXISTS "knowledge_document_chunks_document_id_idx" ON "knowledge_document_chunks" ("document_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_document_chunks_document_chunk_idx" ON "knowledge_document_chunks" ("document_id", "chunk_index");
    CREATE INDEX IF NOT EXISTS "apikey_user_id_idx" ON "apikey" ("userId");
    CREATE INDEX IF NOT EXISTS "apikey_key_idx" ON "apikey" ("key");
    CREATE INDEX IF NOT EXISTS "apikey_config_id_idx" ON "apikey" ("configId");
    CREATE INDEX IF NOT EXISTS "apikey_reference_id_idx" ON "apikey" ("referenceId");

    INSERT INTO "tool_providers" ("key", "display_name", "description", "type", "auth_type", "metadata")
    VALUES
      ('built_in.weather', 'Weather', 'Get current weather for a location.', 'built_in', 'system', '{"category":"built_in","icon":"cloud-sun"}'::jsonb),
      ('built_in.knowledge_search', 'Knowledge Search', 'Search uploaded knowledge documents.', 'built_in', 'system', '{"category":"built_in","icon":"book-open"}'::jsonb),
      ('built_in.sandbox', 'Sandbox', 'Inspect synced source content with read-only shell commands.', 'built_in', 'system', '{"category":"built_in","icon":"terminal"}'::jsonb),
      ('built_in.artifacts', 'Artifacts', 'Create and update chat artifacts.', 'built_in', 'system', '{"category":"built_in","icon":"file-text"}'::jsonb),
      ('github', 'GitHub', 'GitHub bot and future GitHub tool connectivity.', 'oauth', 'env', '{"category":"integration","icon":"github"}'::jsonb),
      ('discord', 'Discord', 'Discord bot runtime and guild binding status.', 'inbound_adapter', 'env', '{"category":"integration","icon":"message-square"}'::jsonb)
    ON CONFLICT ("key") DO UPDATE
    SET
      "display_name" = excluded."display_name",
      "description" = excluded."description",
      "type" = excluded."type",
      "auth_type" = excluded."auth_type",
      "metadata" = excluded."metadata",
      "updated_at" = now();

    INSERT INTO "tool_capabilities" (
      "provider_key",
      "key",
      "runtime_name",
      "display_name",
      "description",
      "access_mode",
      "default_enabled",
      "default_approval_mode",
      "default_surface_access",
      "default_rate_limit_mode",
      "default_logging_mode",
      "default_settings",
      "metadata"
    )
    VALUES
      ('built_in.weather', 'getWeather', 'getWeather', 'Get Weather', 'Get current weather and geocoded location data.', 'read', true, 'auto', '{"chat": true, "admin": false}'::jsonb, 'default', 'full', '{"units":"fahrenheit","timeoutMs":8000,"retryCount":1}'::jsonb, '{"settingsSchema":{"units":["fahrenheit","celsius"]}}'::jsonb),
      ('built_in.knowledge_search', 'searchKnowledgeDocuments', 'searchKnowledgeDocuments', 'Search Knowledge Documents', 'Search uploaded knowledge documents for grouped evidence.', 'read', true, 'auto', '{"chat": true, "admin": false}'::jsonb, 'default', 'metadata_only', '{"defaultLimit":5}'::jsonb, '{}'::jsonb),
      ('built_in.sandbox', 'bash', 'bash', 'Sandbox Bash', 'Run one read-only shell command in the synced sandbox.', 'internal', true, 'auto', '{"chat": true, "admin": false}'::jsonb, 'strict', 'metadata_only', '{}'::jsonb, '{}'::jsonb),
      ('built_in.sandbox', 'bash_batch', 'bash_batch', 'Sandbox Bash Batch', 'Run multiple read-only shell commands in the synced sandbox.', 'internal', true, 'auto', '{"chat": true, "admin": false}'::jsonb, 'strict', 'metadata_only', '{}'::jsonb, '{}'::jsonb),
      ('built_in.artifacts', 'createDocument', 'createDocument', 'Create Document', 'Create an artifact document beside the conversation.', 'write', true, 'auto', '{"chat": true, "admin": false}'::jsonb, 'default', 'full', '{}'::jsonb, '{}'::jsonb),
      ('built_in.artifacts', 'updateDocument', 'updateDocument', 'Update Document', 'Update an existing artifact document.', 'write', true, 'auto', '{"chat": true, "admin": false}'::jsonb, 'default', 'full', '{}'::jsonb, '{}'::jsonb),
      ('built_in.artifacts', 'requestSuggestions', 'requestSuggestions', 'Request Suggestions', 'Request suggestions for an artifact document.', 'read', true, 'auto', '{"chat": true, "admin": false}'::jsonb, 'default', 'full', '{}'::jsonb, '{}'::jsonb),
      ('github', 'github.read', NULL, 'GitHub Read Tools', 'Placeholder GitHub read capabilities for the org connection.', 'read', false, 'auto', '{"chat": false, "admin": true}'::jsonb, 'default', 'metadata_only', '{"allowedRepos":[]}'::jsonb, '{"placeholder":true}'::jsonb),
      ('github', 'github.write', NULL, 'GitHub Write Tools', 'Placeholder GitHub write capabilities for the org connection.', 'write', false, 'ask', '{"chat": false, "admin": true}'::jsonb, 'strict', 'full', '{"allowedRepos":[],"writeEnabled":false}'::jsonb, '{"placeholder":true}'::jsonb),
      ('discord', 'discord.status', NULL, 'Discord Runtime', 'Discord bot runtime and guild binding status.', 'status', true, 'auto', '{"chat": false, "admin": true}'::jsonb, 'off', 'metadata_only', '{}'::jsonb, '{"placeholder":true}'::jsonb)
    ON CONFLICT ("provider_key", "key") DO UPDATE
    SET
      "runtime_name" = excluded."runtime_name",
      "display_name" = excluded."display_name",
      "description" = excluded."description",
      "access_mode" = excluded."access_mode",
      "default_enabled" = excluded."default_enabled",
      "default_approval_mode" = excluded."default_approval_mode",
      "default_surface_access" = excluded."default_surface_access",
      "default_rate_limit_mode" = excluded."default_rate_limit_mode",
      "default_logging_mode" = excluded."default_logging_mode",
      "default_settings" = excluded."default_settings",
      "metadata" = excluded."metadata",
      "updated_at" = now();
  `);
}

runMigrate().catch((err) => {
  console.error("❌ Migration failed");
  console.error(err);
  process.exit(1);
});
