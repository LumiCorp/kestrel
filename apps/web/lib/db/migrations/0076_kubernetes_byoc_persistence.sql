CREATE TABLE "environment_provider_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "provider" text NOT NULL,
  "display_name" text NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "support_status" text DEFAULT 'unverified' NOT NULL,
  "configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "qualification_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "connector_id" text,
  "last_seen_at" timestamp with time zone,
  "last_qualified_at" timestamp with time zone,
  "failure_code" text,
  "failure_message" text,
  "encrypted_credential" text,
  "configured_by_user_id" text,
  "attested_by_user_id" text,
  "qualified_by_user_id" text,
  "revoked_by_user_id" text,
  "configured_at" timestamp with time zone,
  "attested_at" timestamp with time zone,
  "qualified_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "environment_provider_connections_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade,
  CONSTRAINT "environment_provider_connections_configured_by_user_id_fk"
    FOREIGN KEY ("configured_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null,
  CONSTRAINT "environment_provider_connections_attested_by_user_id_fk"
    FOREIGN KEY ("attested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null,
  CONSTRAINT "environment_provider_connections_qualified_by_user_id_fk"
    FOREIGN KEY ("qualified_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null,
  CONSTRAINT "environment_provider_connections_revoked_by_user_id_fk"
    FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null,
  CONSTRAINT "environment_provider_connections_provider_check"
    CHECK ("provider" IN ('fly', 'kubernetes')),
  CONSTRAINT "environment_provider_connections_status_check"
    CHECK ("status" IN ('pending', 'enrolling', 'qualifying', 'ready', 'degraded', 'revoked')),
  CONSTRAINT "environment_provider_connections_support_status_check"
    CHECK ("support_status" IN ('unverified', 'qualified', 'certified')),
  CONSTRAINT "environment_provider_connections_configuration_size_check"
    CHECK (octet_length("configuration"::text) <= 65536),
  CONSTRAINT "environment_provider_connections_evidence_size_check"
    CHECK (octet_length("qualification_evidence"::text) <= 262144)
);

CREATE UNIQUE INDEX "environment_provider_connections_org_id_idx"
  ON "environment_provider_connections" ("organization_id", "id");
CREATE UNIQUE INDEX "environment_provider_connections_active_default_idx"
  ON "environment_provider_connections" ("organization_id", "provider")
  WHERE "is_default" = true AND "revoked_at" IS NULL;
CREATE UNIQUE INDEX "environment_provider_connections_connector_idx"
  ON "environment_provider_connections" ("connector_id")
  WHERE "connector_id" IS NOT NULL;
CREATE INDEX "environment_provider_connections_org_status_idx"
  ON "environment_provider_connections" ("organization_id", "provider", "status");

ALTER TABLE "environments"
  ADD COLUMN "provider_connection_id" text,
  ADD COLUMN "provider_placement" jsonb,
  ADD COLUMN "workspace_limit" integer,
  ALTER COLUMN "region" DROP NOT NULL;

ALTER TABLE "environments"
  ADD CONSTRAINT "environments_provider_connection_id_fk"
  FOREIGN KEY ("provider_connection_id") REFERENCES "public"."environment_provider_connections"("id")
  ON DELETE restrict;

CREATE INDEX "environments_provider_connection_idx"
  ON "environments" ("provider_connection_id");

CREATE TABLE "environment_provider_resources" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "environment_id" text NOT NULL,
  "workspace_id" text,
  "provider_connection_id" text NOT NULL,
  "provider" text NOT NULL,
  "resource_role" text NOT NULL,
  "external_id" text NOT NULL,
  "provider_uid" text,
  "desired_revision" text NOT NULL,
  "observed_generation" text,
  "state" text,
  "provider_metadata" jsonb,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "environment_provider_resources_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade,
  CONSTRAINT "environment_provider_resources_environment_id_fk"
    FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade,
  CONSTRAINT "environment_provider_resources_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."environment_workspaces"("id") ON DELETE cascade,
  CONSTRAINT "environment_provider_resources_connection_id_fk"
    FOREIGN KEY ("provider_connection_id") REFERENCES "public"."environment_provider_connections"("id") ON DELETE restrict,
  CONSTRAINT "environment_provider_resources_provider_check"
    CHECK ("provider" IN ('fly', 'kubernetes')),
  CONSTRAINT "environment_provider_resources_role_check"
    CHECK ("resource_role" IN ('environment_scope', 'gateway', 'workspace_compute', 'workspace_storage', 'snapshot', 'edge_route')),
  CONSTRAINT "environment_provider_resources_metadata_size_check"
    CHECK ("provider_metadata" IS NULL OR octet_length("provider_metadata"::text) <= 16384)
);

CREATE UNIQUE INDEX "environment_provider_resources_environment_singleton_idx"
  ON "environment_provider_resources" ("environment_id", "resource_role")
  WHERE "workspace_id" IS NULL AND "deleted_at" IS NULL AND "resource_role" <> 'snapshot';
CREATE UNIQUE INDEX "environment_provider_resources_workspace_singleton_idx"
  ON "environment_provider_resources" ("workspace_id", "resource_role")
  WHERE "workspace_id" IS NOT NULL AND "deleted_at" IS NULL AND "resource_role" <> 'snapshot';
CREATE UNIQUE INDEX "environment_provider_resources_external_idx"
  ON "environment_provider_resources" ("provider_connection_id", "resource_role", "external_id")
  WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "environment_provider_resources_org_id_idx"
  ON "environment_provider_resources" ("organization_id", "id");
CREATE INDEX "environment_provider_resources_environment_idx"
  ON "environment_provider_resources" ("organization_id", "environment_id", "deleted_at");
CREATE INDEX "environment_provider_resources_workspace_idx"
  ON "environment_provider_resources" ("workspace_id", "deleted_at");

CREATE TABLE "infrastructure_connector_enrollment_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "provider_connection_id" text NOT NULL,
  "secret_hash" text NOT NULL,
  "fingerprint" text NOT NULL,
  "signing_public_key" text NOT NULL,
  "encryption_public_key" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "requested_by_user_id" text,
  "approved_by_user_id" text,
  "expires_at" timestamp with time zone NOT NULL,
  "approved_at" timestamp with time zone,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "infrastructure_connector_enrollment_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade,
  CONSTRAINT "infrastructure_connector_enrollment_connection_id_fk"
    FOREIGN KEY ("provider_connection_id") REFERENCES "public"."environment_provider_connections"("id") ON DELETE cascade,
  CONSTRAINT "infrastructure_connector_enrollment_requested_by_user_id_fk"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null,
  CONSTRAINT "infrastructure_connector_enrollment_approved_by_user_id_fk"
    FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null,
  CONSTRAINT "infrastructure_connector_enrollment_status_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected', 'expired', 'consumed'))
);
CREATE UNIQUE INDEX "infrastructure_connector_enrollment_fingerprint_idx"
  ON "infrastructure_connector_enrollment_requests" ("provider_connection_id", "fingerprint");
CREATE INDEX "infrastructure_connector_enrollment_expiry_idx"
  ON "infrastructure_connector_enrollment_requests" ("status", "expires_at");

CREATE TABLE "infrastructure_connector_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "provider_connection_id" text NOT NULL,
  "signing_public_key" text NOT NULL,
  "encryption_public_key" text NOT NULL,
  "current_credential_hash" text NOT NULL,
  "previous_credential_hash" text,
  "previous_credential_expires_at" timestamp with time zone,
  "credential_rotated_at" timestamp with time zone,
  "supported_command_versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "supported_result_versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "connector_version" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "last_seen_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "infrastructure_connector_connections_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade,
  CONSTRAINT "infrastructure_connector_connections_provider_connection_id_fk"
    FOREIGN KEY ("provider_connection_id") REFERENCES "public"."environment_provider_connections"("id") ON DELETE cascade,
  CONSTRAINT "infrastructure_connector_connections_status_check"
    CHECK ("status" IN ('active', 'revoked')),
  CONSTRAINT "infrastructure_connector_connections_versions_check"
    CHECK (jsonb_typeof("supported_command_versions") = 'array' AND jsonb_typeof("supported_result_versions") = 'array')
);
CREATE UNIQUE INDEX "infrastructure_connector_connections_provider_idx"
  ON "infrastructure_connector_connections" ("provider_connection_id");
CREATE UNIQUE INDEX "infrastructure_connector_connections_org_id_idx"
  ON "infrastructure_connector_connections" ("organization_id", "id");

CREATE TABLE "infrastructure_connector_replica_presence" (
  "connector_id" text NOT NULL,
  "replica_id" text NOT NULL,
  "connector_version" text NOT NULL,
  "supported_command_versions" jsonb NOT NULL,
  "supported_result_versions" jsonb NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("connector_id", "replica_id"),
  CONSTRAINT "infrastructure_connector_replica_presence_connector_id_fk"
    FOREIGN KEY ("connector_id") REFERENCES "public"."infrastructure_connector_connections"("id") ON DELETE cascade,
  CONSTRAINT "infrastructure_connector_replica_presence_versions_check"
    CHECK (jsonb_typeof("supported_command_versions") = 'array' AND jsonb_typeof("supported_result_versions") = 'array')
);
CREATE INDEX "infrastructure_connector_replica_presence_seen_idx"
  ON "infrastructure_connector_replica_presence" ("last_seen_at");

CREATE TABLE "infrastructure_connector_request_nonces" (
  "connector_id" text NOT NULL,
  "nonce" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("connector_id", "nonce"),
  CONSTRAINT "infrastructure_connector_request_nonces_connector_id_fk"
    FOREIGN KEY ("connector_id") REFERENCES "public"."infrastructure_connector_connections"("id") ON DELETE cascade
);
CREATE INDEX "infrastructure_connector_request_nonces_expiry_idx"
  ON "infrastructure_connector_request_nonces" ("expires_at");

CREATE TABLE "infrastructure_connector_commands" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "provider_connection_id" text NOT NULL,
  "connector_id" text,
  "operation_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "command_type" text NOT NULL,
  "desired_revision" text NOT NULL,
  "envelope" jsonb NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "claim_token_hash" text,
  "claim_expires_at" timestamp with time zone,
  "attempt" integer DEFAULT 0 NOT NULL,
  "event_cursor" integer DEFAULT 0 NOT NULL,
  "result" jsonb,
  "error_code" text,
  "error_message" text,
  "claimed_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "infrastructure_connector_commands_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade,
  CONSTRAINT "infrastructure_connector_commands_provider_connection_id_fk"
    FOREIGN KEY ("provider_connection_id") REFERENCES "public"."environment_provider_connections"("id") ON DELETE cascade,
  CONSTRAINT "infrastructure_connector_commands_connector_id_fk"
    FOREIGN KEY ("connector_id") REFERENCES "public"."infrastructure_connector_connections"("id") ON DELETE restrict,
  CONSTRAINT "infrastructure_connector_commands_operation_id_fk"
    FOREIGN KEY ("operation_id") REFERENCES "public"."environment_operations"("id") ON DELETE cascade,
  CONSTRAINT "infrastructure_connector_commands_status_check"
    CHECK ("status" IN ('queued', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT "infrastructure_connector_commands_attempt_check" CHECK ("attempt" >= 0),
  CONSTRAINT "infrastructure_connector_commands_event_cursor_check" CHECK ("event_cursor" >= 0),
  CONSTRAINT "infrastructure_connector_commands_envelope_size_check"
    CHECK (octet_length("envelope"::text) <= 262144)
);
CREATE UNIQUE INDEX "infrastructure_connector_commands_operation_idx"
  ON "infrastructure_connector_commands" ("operation_id");
CREATE UNIQUE INDEX "infrastructure_connector_commands_idempotency_idx"
  ON "infrastructure_connector_commands" ("provider_connection_id", "idempotency_key");
CREATE UNIQUE INDEX "infrastructure_connector_commands_org_id_idx"
  ON "infrastructure_connector_commands" ("organization_id", "id");
CREATE INDEX "infrastructure_connector_commands_claim_idx"
  ON "infrastructure_connector_commands" ("provider_connection_id", "status", "claim_expires_at", "created_at");

CREATE TABLE "infrastructure_connector_command_events" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "command_id" text NOT NULL,
  "sequence" integer NOT NULL,
  "event" jsonb NOT NULL,
  "payload_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "infrastructure_connector_command_events_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade,
  CONSTRAINT "infrastructure_connector_command_events_command_id_fk"
    FOREIGN KEY ("command_id") REFERENCES "public"."infrastructure_connector_commands"("id") ON DELETE cascade,
  CONSTRAINT "infrastructure_connector_command_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "infrastructure_connector_command_events_size_check"
    CHECK (octet_length("event"::text) <= 65536)
);
CREATE UNIQUE INDEX "infrastructure_connector_command_events_sequence_idx"
  ON "infrastructure_connector_command_events" ("command_id", "sequence");
CREATE INDEX "infrastructure_connector_command_events_org_command_idx"
  ON "infrastructure_connector_command_events" ("organization_id", "command_id");

ALTER TABLE "environment_operations"
  ADD COLUMN "connector_command_id" text;
ALTER TABLE "environment_operations"
  ADD CONSTRAINT "environment_operations_connector_command_id_fk"
  FOREIGN KEY ("connector_command_id") REFERENCES "public"."infrastructure_connector_commands"("id")
  ON DELETE set null;
CREATE UNIQUE INDEX "environment_operations_connector_command_idx"
  ON "environment_operations" ("connector_command_id")
  WHERE "connector_command_id" IS NOT NULL;

INSERT INTO "environment_provider_connections" (
  "id", "organization_id", "provider", "display_name", "is_default",
  "status", "support_status", "configuration", "qualification_evidence",
  "encrypted_credential", "configured_at", "created_at", "updated_at",
  "failure_code", "failure_message"
)
SELECT
  'organization-fly:' || active."organization_id",
  active."organization_id",
  'fly',
  'Fly.io',
  true,
  CASE WHEN ai."status" = 'ready' AND ai."enabled" = true THEN 'ready' ELSE 'degraded' END,
  'certified',
  jsonb_build_object(
    'contract', 'fly-connection-configuration-v1',
    'organizationSlug', NULLIF(ai."metadata" ->> 'organizationSlug', '')
  ),
  jsonb_build_array(jsonb_build_object(
    'level', 'production',
    'phase', 'slice-2-fly-backfill'
  )),
  ai."api_key",
  COALESCE(ai."updated_at", now()),
  COALESCE(ai."created_at", now()),
  now(),
  CASE WHEN ai."id" IS NULL THEN 'PROVIDER_NOT_CONFIGURED' ELSE NULL END,
  CASE WHEN ai."id" IS NULL THEN 'Legacy Fly authority is incomplete.' ELSE NULL END
FROM (
  SELECT DISTINCT "organization_id"
  FROM "environments"
  WHERE "provider" = 'fly' AND "archived_at" IS NULL
) active
LEFT JOIN "ai_provider_connections" ai
  ON ai."organization_id" = active."organization_id" AND ai."provider" = 'fly'
ON CONFLICT ("id") DO NOTHING;

UPDATE "environments" environment
SET "provider_connection_id" = 'organization-fly:' || environment."organization_id"
WHERE environment."provider" = 'fly'
  AND environment."provider_connection_id" IS NULL
  AND EXISTS (
    SELECT 1 FROM "environment_provider_connections" connection
    WHERE connection."id" = 'organization-fly:' || environment."organization_id"
  );

INSERT INTO "environment_provider_resources" (
  "id", "organization_id", "environment_id", "workspace_id",
  "provider_connection_id", "provider", "resource_role", "external_id",
  "desired_revision", "observed_generation", "state", "provider_metadata"
)
SELECT
  'fly-resource:' || md5(environment."id" || ':environment_scope'),
  environment."organization_id", environment."id", NULL,
  environment."provider_connection_id", 'fly', 'environment_scope',
  environment."fly_app_name", 'legacy-v1', environment."fly_app_name",
  environment."status",
  '{"contract":"provider-resource-metadata-v1","source":"legacy_backfill"}'::jsonb
FROM "environments" environment
WHERE environment."provider" = 'fly'
  AND environment."provider_connection_id" IS NOT NULL
  AND environment."fly_app_name" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "environment_provider_resources" (
  "id", "organization_id", "environment_id", "workspace_id",
  "provider_connection_id", "provider", "resource_role", "external_id",
  "desired_revision", "observed_generation", "state", "provider_metadata"
)
SELECT
  'fly-resource:' || md5(environment."id" || ':gateway'),
  environment."organization_id", environment."id", NULL,
  environment."provider_connection_id", 'fly', 'gateway',
  environment."fly_gateway_machine_id", 'legacy-v1', environment."fly_gateway_machine_id",
  environment."status",
  '{"contract":"provider-resource-metadata-v1","source":"legacy_backfill"}'::jsonb
FROM "environments" environment
WHERE environment."provider" = 'fly'
  AND environment."provider_connection_id" IS NOT NULL
  AND environment."fly_gateway_machine_id" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "environment_provider_resources" (
  "id", "organization_id", "environment_id", "workspace_id",
  "provider_connection_id", "provider", "resource_role", "external_id",
  "desired_revision", "observed_generation", "state", "provider_metadata"
)
SELECT
  'fly-resource:' || md5(workspace."id" || ':workspace_compute'),
  workspace."organization_id", workspace."environment_id", workspace."id",
  environment."provider_connection_id", 'fly', 'workspace_compute',
  workspace."fly_machine_id", 'legacy-v1', workspace."fly_machine_id",
  workspace."status",
  '{"contract":"provider-resource-metadata-v1","source":"legacy_backfill"}'::jsonb
FROM "environment_workspaces" workspace
JOIN "environments" environment ON environment."id" = workspace."environment_id"
WHERE environment."provider" = 'fly'
  AND environment."provider_connection_id" IS NOT NULL
  AND workspace."fly_machine_id" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "environment_provider_resources" (
  "id", "organization_id", "environment_id", "workspace_id",
  "provider_connection_id", "provider", "resource_role", "external_id",
  "desired_revision", "observed_generation", "state", "provider_metadata"
)
SELECT
  'fly-resource:' || md5(workspace."id" || ':workspace_storage'),
  workspace."organization_id", workspace."environment_id", workspace."id",
  environment."provider_connection_id", 'fly', 'workspace_storage',
  workspace."fly_volume_id", 'legacy-v1', workspace."fly_volume_id",
  workspace."status",
  '{"contract":"provider-resource-metadata-v1","source":"legacy_backfill"}'::jsonb
FROM "environment_workspaces" workspace
JOIN "environments" environment ON environment."id" = workspace."environment_id"
WHERE environment."provider" = 'fly'
  AND environment."provider_connection_id" IS NOT NULL
  AND workspace."fly_volume_id" IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE "environments" DROP CONSTRAINT IF EXISTS "environments_provider_check";
ALTER TABLE "environments"
  ADD CONSTRAINT "environments_provider_check"
  CHECK ("provider" IN ('fly', 'desktop', 'kubernetes'));
ALTER TABLE "environments" DROP CONSTRAINT IF EXISTS "environments_provider_identity_check";
ALTER TABLE "environments"
  ADD CONSTRAINT "environments_provider_identity_check"
  CHECK (
    "provider" = 'fly'
    OR (
      "provider" = 'desktop'
      AND "provider_connection_id" IS NULL
      AND "fly_app_name" IS NULL
      AND "fly_network_name" IS NULL
      AND "fly_gateway_machine_id" IS NULL
    )
    OR (
      "provider" = 'kubernetes'
      AND "provider_connection_id" IS NOT NULL
      AND "workspace_limit" IS NOT NULL
      AND "workspace_limit" > 0
      AND "region" IS NULL
      AND "fly_app_name" IS NULL
      AND "fly_network_name" IS NULL
      AND "fly_gateway_machine_id" IS NULL
    )
  );
ALTER TABLE "environments"
  ADD CONSTRAINT "environments_workspace_limit_check"
  CHECK ("workspace_limit" IS NULL OR "workspace_limit" > 0);

CREATE OR REPLACE FUNCTION "kestrel_bind_fly_environment_provider"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  legacy_connection "ai_provider_connections"%ROWTYPE;
BEGIN
  IF NEW."provider" = 'fly' AND NEW."provider_connection_id" IS NULL THEN
    SELECT * INTO legacy_connection
    FROM "ai_provider_connections"
    WHERE "organization_id" = NEW."organization_id" AND "provider" = 'fly';

    INSERT INTO "environment_provider_connections" (
      "id", "organization_id", "provider", "display_name", "is_default",
      "status", "support_status", "configuration", "qualification_evidence",
      "encrypted_credential", "configured_at", "created_at", "updated_at",
      "failure_code", "failure_message"
    ) VALUES (
      'organization-fly:' || NEW."organization_id", NEW."organization_id", 'fly', 'Fly.io', true,
      CASE WHEN legacy_connection."status" = 'ready' AND legacy_connection."enabled" = true THEN 'ready' ELSE 'degraded' END,
      'certified',
      jsonb_build_object(
        'contract', 'fly-connection-configuration-v1',
        'organizationSlug', NULLIF(legacy_connection."metadata" ->> 'organizationSlug', '')
      ),
      '[{"level":"production","phase":"slice-2-fly-mixed-version"}]'::jsonb,
      legacy_connection."api_key", COALESCE(legacy_connection."updated_at", now()), now(), now(),
      CASE WHEN legacy_connection."id" IS NULL THEN 'PROVIDER_NOT_CONFIGURED' ELSE NULL END,
      CASE WHEN legacy_connection."id" IS NULL THEN 'Legacy Fly authority is incomplete.' ELSE NULL END
    ) ON CONFLICT ("id") DO NOTHING;
    NEW."provider_connection_id" := 'organization-fly:' || NEW."organization_id";
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "environments_bind_fly_provider"
  BEFORE INSERT OR UPDATE OF "provider", "provider_connection_id", "organization_id"
  ON "environments"
  FOR EACH ROW EXECUTE FUNCTION "kestrel_bind_fly_environment_provider"();

CREATE OR REPLACE FUNCTION "kestrel_validate_environment_provider_binding"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bound_provider text;
  bound_organization_id text;
  bound_revoked_at timestamp with time zone;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."provider" IS DISTINCT FROM NEW."provider" THEN
      RAISE EXCEPTION 'Environment provider is immutable';
    END IF;
    IF OLD."provider_connection_id" IS NOT NULL
       AND OLD."provider_connection_id" IS DISTINCT FROM NEW."provider_connection_id" THEN
      RAISE EXCEPTION 'Environment provider connection is immutable';
    END IF;
  END IF;
  IF NEW."provider_connection_id" IS NOT NULL THEN
    SELECT "provider", "organization_id", "revoked_at"
    INTO bound_provider, bound_organization_id, bound_revoked_at
    FROM "environment_provider_connections"
    WHERE "id" = NEW."provider_connection_id";
    IF bound_provider IS DISTINCT FROM NEW."provider"
       OR bound_organization_id IS DISTINCT FROM NEW."organization_id"
       OR bound_revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Environment provider connection does not match its organization and provider';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "environments_validate_provider_binding"
  BEFORE INSERT OR UPDATE OF "provider", "provider_connection_id", "organization_id"
  ON "environments"
  FOR EACH ROW EXECUTE FUNCTION "kestrel_validate_environment_provider_binding"();

CREATE OR REPLACE FUNCTION "kestrel_sync_fly_environment_resources"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."provider" <> 'fly' OR NEW."provider_connection_id" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."fly_app_name" IS NOT NULL THEN
    INSERT INTO "environment_provider_resources" (
      "id", "organization_id", "environment_id", "provider_connection_id",
      "provider", "resource_role", "external_id", "desired_revision",
      "observed_generation", "state", "provider_metadata", "deleted_at", "updated_at"
    ) VALUES (
      'fly-resource:' || md5(NEW."id" || ':environment_scope'), NEW."organization_id", NEW."id",
      NEW."provider_connection_id", 'fly', 'environment_scope', NEW."fly_app_name", 'legacy-v1',
      NEW."fly_app_name", NEW."status",
      '{"contract":"provider-resource-metadata-v1","source":"legacy_dual_write"}'::jsonb, NULL, now()
    )
    ON CONFLICT ("environment_id", "resource_role")
      WHERE "workspace_id" IS NULL AND "deleted_at" IS NULL AND "resource_role" <> 'snapshot'
    DO UPDATE SET
      "external_id" = excluded."external_id",
      "observed_generation" = excluded."observed_generation",
      "state" = excluded."state",
      "provider_metadata" = excluded."provider_metadata",
      "updated_at" = now()
    WHERE "environment_provider_resources"."external_id" = excluded."external_id"
      OR "environment_provider_resources"."provider_metadata" ->> 'source'
        IN ('legacy_backfill', 'legacy_dual_write', 'read_repair');
  ELSE
    UPDATE "environment_provider_resources"
    SET "deleted_at" = now(), "state" = 'deleted', "updated_at" = now()
    WHERE "environment_id" = NEW."id" AND "workspace_id" IS NULL
      AND "resource_role" = 'environment_scope' AND "deleted_at" IS NULL;
  END IF;

  IF NEW."fly_gateway_machine_id" IS NOT NULL THEN
    INSERT INTO "environment_provider_resources" (
      "id", "organization_id", "environment_id", "provider_connection_id",
      "provider", "resource_role", "external_id", "desired_revision",
      "observed_generation", "state", "provider_metadata", "deleted_at", "updated_at"
    ) VALUES (
      'fly-resource:' || md5(NEW."id" || ':gateway'), NEW."organization_id", NEW."id",
      NEW."provider_connection_id", 'fly', 'gateway', NEW."fly_gateway_machine_id", 'legacy-v1',
      NEW."fly_gateway_machine_id", NEW."status",
      '{"contract":"provider-resource-metadata-v1","source":"legacy_dual_write"}'::jsonb, NULL, now()
    )
    ON CONFLICT ("environment_id", "resource_role")
      WHERE "workspace_id" IS NULL AND "deleted_at" IS NULL AND "resource_role" <> 'snapshot'
    DO UPDATE SET
      "external_id" = excluded."external_id",
      "observed_generation" = excluded."observed_generation",
      "state" = excluded."state",
      "provider_metadata" = excluded."provider_metadata",
      "updated_at" = now()
    WHERE "environment_provider_resources"."external_id" = excluded."external_id"
      OR "environment_provider_resources"."provider_metadata" ->> 'source'
        IN ('legacy_backfill', 'legacy_dual_write', 'read_repair');
  ELSE
    UPDATE "environment_provider_resources"
    SET "deleted_at" = now(), "state" = 'deleted', "updated_at" = now()
    WHERE "environment_id" = NEW."id" AND "workspace_id" IS NULL
      AND "resource_role" = 'gateway' AND "deleted_at" IS NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "environments_sync_fly_provider_resources"
  AFTER INSERT OR UPDATE OF "fly_app_name", "fly_gateway_machine_id", "status", "provider_connection_id"
  ON "environments"
  FOR EACH ROW EXECUTE FUNCTION "kestrel_sync_fly_environment_resources"();

CREATE OR REPLACE FUNCTION "kestrel_sync_fly_workspace_resources"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  environment_provider text;
  connection_id text;
BEGIN
  SELECT "provider", "provider_connection_id" INTO environment_provider, connection_id
  FROM "environments" WHERE "id" = NEW."environment_id";
  IF environment_provider <> 'fly' OR connection_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."fly_machine_id" IS NOT NULL THEN
    INSERT INTO "environment_provider_resources" (
      "id", "organization_id", "environment_id", "workspace_id", "provider_connection_id",
      "provider", "resource_role", "external_id", "desired_revision",
      "observed_generation", "state", "provider_metadata", "deleted_at", "updated_at"
    ) VALUES (
      'fly-resource:' || md5(NEW."id" || ':workspace_compute'), NEW."organization_id", NEW."environment_id", NEW."id",
      connection_id, 'fly', 'workspace_compute', NEW."fly_machine_id", 'legacy-v1',
      NEW."fly_machine_id", NEW."status",
      '{"contract":"provider-resource-metadata-v1","source":"legacy_dual_write"}'::jsonb, NULL, now()
    )
    ON CONFLICT ("workspace_id", "resource_role")
      WHERE "workspace_id" IS NOT NULL AND "deleted_at" IS NULL AND "resource_role" <> 'snapshot'
    DO UPDATE SET
      "external_id" = excluded."external_id",
      "observed_generation" = excluded."observed_generation",
      "state" = excluded."state",
      "provider_metadata" = excluded."provider_metadata",
      "updated_at" = now()
    WHERE "environment_provider_resources"."external_id" = excluded."external_id"
      OR "environment_provider_resources"."provider_metadata" ->> 'source'
        IN ('legacy_backfill', 'legacy_dual_write', 'read_repair');
  ELSE
    UPDATE "environment_provider_resources"
    SET "deleted_at" = now(), "state" = 'deleted', "updated_at" = now()
    WHERE "workspace_id" = NEW."id" AND "resource_role" = 'workspace_compute' AND "deleted_at" IS NULL;
  END IF;

  IF NEW."fly_volume_id" IS NOT NULL THEN
    INSERT INTO "environment_provider_resources" (
      "id", "organization_id", "environment_id", "workspace_id", "provider_connection_id",
      "provider", "resource_role", "external_id", "desired_revision",
      "observed_generation", "state", "provider_metadata", "deleted_at", "updated_at"
    ) VALUES (
      'fly-resource:' || md5(NEW."id" || ':workspace_storage'), NEW."organization_id", NEW."environment_id", NEW."id",
      connection_id, 'fly', 'workspace_storage', NEW."fly_volume_id", 'legacy-v1',
      NEW."fly_volume_id", NEW."status",
      '{"contract":"provider-resource-metadata-v1","source":"legacy_dual_write"}'::jsonb, NULL, now()
    )
    ON CONFLICT ("workspace_id", "resource_role")
      WHERE "workspace_id" IS NOT NULL AND "deleted_at" IS NULL AND "resource_role" <> 'snapshot'
    DO UPDATE SET
      "external_id" = excluded."external_id",
      "observed_generation" = excluded."observed_generation",
      "state" = excluded."state",
      "provider_metadata" = excluded."provider_metadata",
      "updated_at" = now()
    WHERE "environment_provider_resources"."external_id" = excluded."external_id"
      OR "environment_provider_resources"."provider_metadata" ->> 'source'
        IN ('legacy_backfill', 'legacy_dual_write', 'read_repair');
  ELSE
    UPDATE "environment_provider_resources"
    SET "deleted_at" = now(), "state" = 'deleted', "updated_at" = now()
    WHERE "workspace_id" = NEW."id" AND "resource_role" = 'workspace_storage' AND "deleted_at" IS NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "environment_workspaces_sync_fly_provider_resources"
  AFTER INSERT OR UPDATE OF "fly_machine_id", "fly_volume_id", "status"
  ON "environment_workspaces"
  FOR EACH ROW EXECUTE FUNCTION "kestrel_sync_fly_workspace_resources"();

INSERT INTO "kestrel_schema_reconciliations" ("key", "details")
SELECT
  '2026-08-kubernetes-byoc-slice-2',
  jsonb_build_object(
    'eligibleFlyEnvironments', count(*) FILTER (WHERE environment."provider" = 'fly' AND environment."archived_at" IS NULL),
    'migratedFlyEnvironments', count(*) FILTER (WHERE environment."provider" = 'fly' AND environment."archived_at" IS NULL AND environment."provider_connection_id" IS NOT NULL),
    'incompleteFlyEnvironments', count(*) FILTER (WHERE environment."provider" = 'fly' AND environment."archived_at" IS NULL AND environment."provider_connection_id" IS NULL),
    'providerResources', (SELECT count(*) FROM "environment_provider_resources" WHERE "provider" = 'fly'),
    'mixedVersionDualWrite', true,
    'legacyColumnsRetained', true
  )
FROM "environments" environment
ON CONFLICT ("key") DO UPDATE
SET "details" = excluded."details", "reconciled_at" = now();
