CREATE TABLE "organization_feature_flags" (
  "organization_id" text NOT NULL,
  "key" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "updated_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_feature_flags_pk"
    PRIMARY KEY ("organization_id", "key"),
  CONSTRAINT "organization_feature_flags_organization_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "organization_feature_flags_updated_by_user_fk"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT
);

CREATE INDEX "organization_feature_flags_enabled_idx"
  ON "organization_feature_flags" ("key", "enabled");
