CREATE TABLE "browser_personal_domain_revision_sets" (
  "organization_id" text NOT NULL,
  "environment_id" text NOT NULL,
  "user_id" text NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "browser_personal_domain_revision_sets_pk"
    PRIMARY KEY ("organization_id", "environment_id", "user_id"),
  CONSTRAINT "browser_personal_domain_revision_sets_revision_check"
    CHECK ("revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "browser_personal_domains" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "environment_id" text NOT NULL,
  "user_id" text NOT NULL,
  "canonical_domain" text NOT NULL,
  "scheme" text DEFAULT 'https' NOT NULL,
  "include_subdomains" boolean DEFAULT true NOT NULL,
  "port" integer DEFAULT 443 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "personal_revision" integer NOT NULL,
  "approval_id" text NOT NULL,
  "source_interaction_id" text,
  "source_prepared_invocation_id" text NOT NULL,
  "approval_authority_revision" text NOT NULL,
  "approved_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "browser_personal_domains_canonical_domain_check"
    CHECK (
      "canonical_domain" <> ''
      AND "canonical_domain" = btrim("canonical_domain")
      AND "canonical_domain" = lower("canonical_domain")
      AND left("canonical_domain", 1) <> '.'
      AND right("canonical_domain", 1) <> '.'
      AND "canonical_domain" !~ '[/:*[:space:]]'
    ),
  CONSTRAINT "browser_personal_domains_public_authority_check"
    CHECK (
      "scheme" = 'https'
      AND "include_subdomains" = true
      AND "port" = 443
    ),
  CONSTRAINT "browser_personal_domains_revision_check"
    CHECK ("personal_revision" > 0),
  CONSTRAINT "browser_personal_domains_lifecycle_check"
    CHECK (
      ("status" = 'active' AND "revoked_at" IS NULL AND "revoked_by_user_id" IS NULL)
      OR
      ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
    )
);
--> statement-breakpoint
ALTER TABLE "browser_personal_domain_revision_sets"
  ADD CONSTRAINT "browser_personal_domain_revision_sets_organization_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "browser_personal_domain_revision_sets"
  ADD CONSTRAINT "browser_personal_domain_revision_sets_environment_id_fk"
  FOREIGN KEY ("environment_id") REFERENCES "environments"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "browser_personal_domain_revision_sets"
  ADD CONSTRAINT "browser_personal_domain_revision_sets_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "user"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "browser_personal_domain_revision_sets"
  ADD CONSTRAINT "browser_personal_domain_revision_sets_environment_fk"
  FOREIGN KEY ("organization_id", "environment_id")
  REFERENCES "environments"("organization_id", "id")
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "browser_personal_domains"
  ADD CONSTRAINT "browser_personal_domains_organization_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "browser_personal_domains"
  ADD CONSTRAINT "browser_personal_domains_environment_id_fk"
  FOREIGN KEY ("environment_id") REFERENCES "environments"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "browser_personal_domains"
  ADD CONSTRAINT "browser_personal_domains_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "user"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "browser_personal_domains"
  ADD CONSTRAINT "browser_personal_domains_revoked_by_user_fk"
  FOREIGN KEY ("revoked_by_user_id") REFERENCES "user"("id")
  ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "browser_personal_domains"
  ADD CONSTRAINT "browser_personal_domains_source_interaction_fk"
  FOREIGN KEY ("source_interaction_id") REFERENCES "thread_interactions"("id")
  ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "browser_personal_domains"
  ADD CONSTRAINT "browser_personal_domains_environment_fk"
  FOREIGN KEY ("organization_id", "environment_id")
  REFERENCES "environments"("organization_id", "id")
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "browser_personal_domains"
  ADD CONSTRAINT "browser_personal_domains_revision_set_fk"
  FOREIGN KEY ("organization_id", "environment_id", "user_id")
  REFERENCES "browser_personal_domain_revision_sets"(
    "organization_id", "environment_id", "user_id"
  )
  ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "browser_personal_domains_identity_idx"
  ON "browser_personal_domains" (
    "organization_id", "environment_id", "user_id", "canonical_domain"
  );
--> statement-breakpoint
CREATE INDEX "browser_personal_domains_active_lookup_idx"
  ON "browser_personal_domains" (
    "organization_id", "environment_id", "user_id", "status", "canonical_domain"
  );
