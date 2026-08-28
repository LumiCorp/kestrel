CREATE TABLE "platform_personal_oauth_authorization_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
	"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
	"app_key" text NOT NULL REFERENCES "app_definitions"("key") ON DELETE cascade,
	"connection_id" text REFERENCES "app_connections"("id") ON DELETE set null,
	"selected_packs" jsonb NOT NULL,
	"registration_revision" integer NOT NULL,
	"encrypted_pkce_verifier" text NOT NULL,
	"return_target" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_personal_oauth_session_provider_check" CHECK ("provider" IN ('google_workspace', 'microsoft_365')),
	CONSTRAINT "platform_personal_oauth_session_pkce_encrypted_check" CHECK ("encrypted_pkce_verifier" LIKE 'kgc:v1:%')
);
--> statement-breakpoint
CREATE INDEX "platform_personal_oauth_session_expiry_idx" ON "platform_personal_oauth_authorization_sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "platform_personal_oauth_session_user_idx" ON "platform_personal_oauth_authorization_sessions" USING btree ("user_id", "organization_id");
--> statement-breakpoint
CREATE TABLE "platform_personal_oauth_authorizations" (
	"connection_id" text PRIMARY KEY NOT NULL REFERENCES "app_connections"("id") ON DELETE cascade,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"selected_packs" jsonb NOT NULL,
	"granted_scopes" jsonb NOT NULL,
	"encrypted_token_payload" text NOT NULL,
	"expires_at" timestamp with time zone,
	"registration_revision" integer NOT NULL,
	"reconnect_required" boolean DEFAULT false NOT NULL,
	"failure_code" text,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_personal_oauth_authorization_provider_check" CHECK ("provider" IN ('google_workspace', 'microsoft_365')),
	CONSTRAINT "platform_personal_oauth_authorization_token_encrypted_check" CHECK ("encrypted_token_payload" LIKE 'kgc:v1:%')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "platform_personal_oauth_authorization_identity_idx" ON "platform_personal_oauth_authorizations" USING btree ("provider", "provider_account_id", "connection_id");
