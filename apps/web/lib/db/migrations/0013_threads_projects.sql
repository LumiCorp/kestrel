CREATE TABLE "projects" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "created_by_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE restrict,
  "name" text NOT NULL,
  "description" text,
  "current_context_revision" integer DEFAULT 1 NOT NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "project_members" (
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "organization_member_id" text NOT NULL REFERENCES "member"("id") ON DELETE cascade,
  "role" text DEFAULT 'member' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("project_id", "organization_member_id"),
  CONSTRAINT "project_members_role_check" CHECK ("role" IN ('owner', 'editor', 'member'))
);

CREATE FUNCTION "enforce_project_has_owner"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_project_id text;
  target_project_ids text[];
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    target_project_ids := ARRAY[NEW."id"];
  ELSIF TG_OP = 'UPDATE' THEN
    target_project_ids := ARRAY[NEW."project_id", OLD."project_id"];
  ELSIF TG_OP = 'DELETE' THEN
    target_project_ids := ARRAY[OLD."project_id"];
  ELSE
    target_project_ids := ARRAY[NEW."project_id"];
  END IF;

  FOREACH target_project_id IN ARRAY target_project_ids LOOP
    IF EXISTS (
      SELECT 1 FROM "projects" WHERE "id" = target_project_id
    ) AND NOT EXISTS (
      SELECT 1
      FROM "project_members"
      WHERE "project_id" = target_project_id AND "role" = 'owner'
    ) THEN
      RAISE EXCEPTION 'project % must retain at least one owner', target_project_id
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "projects_require_owner"
AFTER INSERT OR UPDATE ON "projects"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_project_has_owner"();

CREATE CONSTRAINT TRIGGER "project_members_require_owner"
AFTER INSERT OR UPDATE OR DELETE ON "project_members"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_project_has_owner"();

CREATE TABLE "project_context_revisions" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "revision" integer NOT NULL,
  "project_name" text NOT NULL,
  "instructions" text DEFAULT '' NOT NULL,
  "created_by_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE restrict,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "project_audit_events" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "actor_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "action" text NOT NULL,
  "target_type" text,
  "target_id" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "chats" RENAME TO "threads";
ALTER TABLE "threads" RENAME COLUMN "user_id" TO "created_by_user_id";
ALTER TABLE "threads" ADD COLUMN "project_id" text;
ALTER TABLE "threads" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "threads" ADD COLUMN "archived_at" timestamp with time zone;

ALTER TABLE "messages" RENAME TO "thread_messages";
ALTER TABLE "thread_messages" RENAME COLUMN "chat_id" TO "thread_id";
ALTER TABLE "thread_messages" ADD COLUMN "author_user_id" text;
ALTER TABLE "thread_messages" ADD COLUMN "project_context_revision_id" text;
ALTER TABLE "thread_messages" ADD COLUMN "search_text" text DEFAULT '' NOT NULL;

ALTER TABLE "artifact_documents" RENAME COLUMN "chat_id" TO "thread_id";
ALTER TABLE "media_generation_jobs" RENAME COLUMN "chat_id" TO "thread_id";

ALTER TABLE "knowledge_documents" ADD COLUMN "scope" text DEFAULT 'organization' NOT NULL;
ALTER TABLE "knowledge_documents" ADD COLUMN "project_id" text;
ALTER TABLE "knowledge_documents" ADD COLUMN "archived_at" timestamp with time zone;

CREATE TABLE "project_context_documents" (
  "context_revision_id" text NOT NULL REFERENCES "project_context_revisions"("id") ON DELETE cascade,
  "document_id" text NOT NULL REFERENCES "knowledge_documents"("id") ON DELETE restrict,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("context_revision_id", "document_id")
);

UPDATE "threads" t
SET "updated_at" = greatest(
  t."created_at",
  COALESCE(
    (SELECT max(m."created_at") FROM "thread_messages" m WHERE m."thread_id" = t."id"),
    t."created_at"
  )
);

UPDATE "thread_messages" m
SET "author_user_id" = t."created_by_user_id"
FROM "threads" t
WHERE m."thread_id" = t."id" AND m."role" = 'user';

UPDATE "thread_messages" m
SET "search_text" = COALESCE(
  (
    SELECT string_agg(part.value ->> 'text', E'\n' ORDER BY part.ordinality)
    FROM jsonb_array_elements(COALESCE(m."parts", '[]'::jsonb)) WITH ORDINALITY AS part(value, ordinality)
    WHERE part.value ->> 'type' = 'text'
  ),
  ''
);

ALTER TABLE "threads" DROP CONSTRAINT IF EXISTS "knowledge_chats_user_fk";
ALTER TABLE "threads" DROP CONSTRAINT IF EXISTS "knowledge_chats_org_fk";
ALTER TABLE "threads" ADD CONSTRAINT "threads_created_by_user_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE set null;
ALTER TABLE "threads" ALTER COLUMN "created_by_user_id" DROP NOT NULL;
ALTER TABLE "threads" ADD CONSTRAINT "threads_org_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;
ALTER TABLE "threads" ADD CONSTRAINT "threads_project_fk"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade;

ALTER TABLE "thread_messages" DROP CONSTRAINT IF EXISTS "knowledge_messages_chat_fk";
ALTER TABLE "thread_messages" ADD CONSTRAINT "thread_messages_thread_fk"
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE cascade;
ALTER TABLE "thread_messages" ADD CONSTRAINT "thread_messages_author_user_fk"
  FOREIGN KEY ("author_user_id") REFERENCES "user"("id") ON DELETE set null;
ALTER TABLE "thread_messages" ADD CONSTRAINT "thread_messages_context_revision_fk"
  FOREIGN KEY ("project_context_revision_id") REFERENCES "project_context_revisions"("id") ON DELETE set null;

ALTER TABLE "artifact_documents" DROP CONSTRAINT IF EXISTS "knowledge_artifact_documents_chat_fk";
ALTER TABLE "artifact_documents" ADD CONSTRAINT "artifact_documents_thread_fk"
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE set null;

ALTER TABLE "media_generation_jobs" DROP CONSTRAINT IF EXISTS "media_generation_jobs_chat_fk";
ALTER TABLE "media_generation_jobs" ADD CONSTRAINT "media_generation_jobs_thread_fk"
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE set null;

ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_project_fk"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade;
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_scope_check"
  CHECK (
    ("scope" = 'organization' AND "project_id" IS NULL)
    OR ("scope" = 'project' AND "project_id" IS NOT NULL)
  );

DROP INDEX IF EXISTS "knowledge_chats_user_id_idx";
DROP INDEX IF EXISTS "knowledge_chats_org_id_idx";
DROP INDEX IF EXISTS "knowledge_chats_origin_idx";
DROP INDEX IF EXISTS "knowledge_chats_external_thread_id_idx";
DROP INDEX IF EXISTS "knowledge_chats_share_token_idx";
DROP INDEX IF EXISTS "knowledge_messages_chat_id_idx";
DROP INDEX IF EXISTS "knowledge_messages_external_message_idx";
DROP INDEX IF EXISTS "knowledge_artifact_documents_chat_id_idx";
DROP INDEX IF EXISTS "media_generation_jobs_chat_id_idx";
DROP INDEX IF EXISTS "knowledge_documents_org_checksum_idx";

CREATE INDEX "projects_org_id_idx" ON "projects" ("organization_id");
CREATE INDEX "projects_created_by_user_id_idx" ON "projects" ("created_by_user_id");
CREATE INDEX "projects_updated_at_idx" ON "projects" ("updated_at");
CREATE INDEX "projects_archived_at_idx" ON "projects" ("archived_at");
CREATE INDEX "project_members_member_id_idx" ON "project_members" ("organization_member_id");
CREATE INDEX "project_members_role_idx" ON "project_members" ("project_id", "role");
CREATE UNIQUE INDEX "project_context_revisions_project_revision_idx"
  ON "project_context_revisions" ("project_id", "revision");
CREATE INDEX "project_context_revisions_created_by_idx"
  ON "project_context_revisions" ("created_by_user_id");
CREATE INDEX "project_audit_events_project_created_at_idx"
  ON "project_audit_events" ("project_id", "created_at");
CREATE INDEX "project_audit_events_actor_idx" ON "project_audit_events" ("actor_user_id");
CREATE INDEX "project_context_documents_document_id_idx"
  ON "project_context_documents" ("document_id");

CREATE INDEX "threads_created_by_user_id_idx" ON "threads" ("created_by_user_id");
CREATE INDEX "threads_org_id_idx" ON "threads" ("organization_id");
CREATE INDEX "threads_project_id_idx" ON "threads" ("project_id");
CREATE INDEX "threads_origin_idx" ON "threads" ("origin");
CREATE INDEX "threads_external_thread_id_idx" ON "threads" ("external_thread_id");
CREATE INDEX "threads_updated_at_idx" ON "threads" ("updated_at");
CREATE INDEX "threads_archived_at_idx" ON "threads" ("archived_at");
CREATE UNIQUE INDEX "threads_share_token_idx" ON "threads" ("share_token");

CREATE INDEX "thread_messages_thread_id_idx" ON "thread_messages" ("thread_id");
CREATE INDEX "thread_messages_author_user_id_idx" ON "thread_messages" ("author_user_id");
CREATE INDEX "thread_messages_context_revision_idx" ON "thread_messages" ("project_context_revision_id");
CREATE INDEX "thread_messages_created_at_idx" ON "thread_messages" ("created_at");
CREATE UNIQUE INDEX "thread_messages_external_message_idx"
  ON "thread_messages" ("thread_id", "external_message_id");
CREATE INDEX "thread_messages_search_idx"
  ON "thread_messages" USING gin (to_tsvector('simple', COALESCE("search_text", '')));
CREATE INDEX "threads_search_idx"
  ON "threads" USING gin (to_tsvector('simple', COALESCE("title", '')));
CREATE INDEX "projects_search_idx"
  ON "projects" USING gin (to_tsvector('simple', COALESCE("name", '') || ' ' || COALESCE("description", '')));

CREATE INDEX "artifact_documents_thread_id_idx" ON "artifact_documents" ("thread_id");
CREATE INDEX "media_generation_jobs_thread_id_idx" ON "media_generation_jobs" ("thread_id");
CREATE INDEX "knowledge_documents_project_id_idx" ON "knowledge_documents" ("project_id");
CREATE INDEX "knowledge_documents_scope_idx" ON "knowledge_documents" ("scope");
CREATE UNIQUE INDEX "knowledge_documents_org_checksum_idx"
  ON "knowledge_documents" ("organization_id", "checksum_sha256")
  WHERE "project_id" IS NULL;
CREATE UNIQUE INDEX "knowledge_documents_project_checksum_idx"
  ON "knowledge_documents" ("project_id", "checksum_sha256")
  WHERE "project_id" IS NOT NULL;
