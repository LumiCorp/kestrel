ALTER TABLE "threads"
  ADD COLUMN IF NOT EXISTS "runtime_id" text NOT NULL DEFAULT 'kestrel';

ALTER TABLE "threads"
  ADD COLUMN IF NOT EXISTS "runtime_binding_id" text;

ALTER TABLE "threads"
  ADD CONSTRAINT "threads_runtime_id_check"
  CHECK ("runtime_id" IN ('kestrel', 'codex', 'claude'));

CREATE TABLE IF NOT EXISTS "runtime_participants" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "runtime_id" text NOT NULL,
  "display_name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "runtime_participants_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade,
  CONSTRAINT "runtime_participants_runtime_id_check"
    CHECK ("runtime_id" IN ('kestrel', 'codex', 'claude'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "runtime_participants_org_runtime_idx"
  ON "runtime_participants" ("organization_id", "runtime_id");

INSERT INTO "runtime_participants" (
  "id", "organization_id", "runtime_id", "display_name", "created_at"
)
SELECT DISTINCT
  'runtime:' || "organization_id" || ':kestrel',
  "organization_id",
  'kestrel',
  'Kestrel',
  now()
FROM "threads"
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS "runtime_bindings" (
  "id" text PRIMARY KEY NOT NULL,
  "thread_id" text NOT NULL,
  "participant_id" text NOT NULL,
  "runtime_id" text NOT NULL,
  "adapter_contract_version" integer DEFAULT 1 NOT NULL,
  "capability_digest" text,
  "status" text DEFAULT 'ready' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "runtime_bindings_thread_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id")
    ON DELETE cascade,
  CONSTRAINT "runtime_bindings_participant_id_fk"
    FOREIGN KEY ("participant_id") REFERENCES "public"."runtime_participants"("id")
    ON DELETE restrict,
  CONSTRAINT "runtime_bindings_runtime_id_check"
    CHECK ("runtime_id" IN ('kestrel', 'codex', 'claude')),
  CONSTRAINT "runtime_bindings_status_check"
    CHECK ("status" IN ('ready', 'degraded', 'released')),
  CONSTRAINT "runtime_bindings_contract_version_check"
    CHECK ("adapter_contract_version" = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS "runtime_bindings_thread_idx"
  ON "runtime_bindings" ("thread_id");

CREATE INDEX IF NOT EXISTS "runtime_bindings_participant_idx"
  ON "runtime_bindings" ("participant_id");

INSERT INTO "runtime_bindings" (
  "id", "thread_id", "participant_id", "runtime_id",
  "adapter_contract_version", "status", "created_at", "updated_at"
)
SELECT
  'binding:' || "id",
  "id",
  'runtime:' || "organization_id" || ':kestrel',
  'kestrel',
  1,
  'ready',
  "created_at",
  "updated_at"
FROM "threads"
ON CONFLICT DO NOTHING;

UPDATE "threads"
SET "runtime_binding_id" = 'binding:' || "id"
WHERE "runtime_binding_id" IS NULL;
