CREATE TABLE "platform_email_config" (
  "id" text PRIMARY KEY NOT NULL,
  "provider" text DEFAULT 'resend' NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "credential_source" text DEFAULT 'environment' NOT NULL,
  "encrypted_api_key" text,
  "from_name" text DEFAULT 'Kestrel One' NOT NULL,
  "from_email" text NOT NULL,
  "reply_to" text,
  "last_tested_at" timestamp with time zone,
  "last_test_message_id" text,
  "last_test_config_fingerprint" text,
  "last_error_code" text,
  "updated_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_email_config_provider_check" CHECK ("provider" IN ('resend')),
  CONSTRAINT "platform_email_config_credential_source_check" CHECK ("credential_source" IN ('stored', 'environment')),
  CONSTRAINT "platform_email_config_updated_by_user_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE set null
);

CREATE UNIQUE INDEX "platform_email_config_singleton_idx"
  ON "platform_email_config" ((true));
