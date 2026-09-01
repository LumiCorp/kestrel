CREATE TABLE "platform_oauth_registrations" (
	"provider" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"client_id" text,
	"encrypted_client_secret" text,
	"tenant_or_issuer" text,
	"enabled_packs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_oauth_registrations_revision_check" CHECK ("platform_oauth_registrations"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "platform_oauth_registrations" ADD CONSTRAINT "platform_oauth_registrations_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
