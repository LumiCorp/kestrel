ALTER TABLE "mcp_servers"
  ADD COLUMN IF NOT EXISTS "oci_egress_policy" jsonb,
  ADD COLUMN IF NOT EXISTS "oci_egress_policy_digest" text,
  ADD COLUMN IF NOT EXISTS "oci_egress_policy_revision" text,
  ADD COLUMN IF NOT EXISTS "oci_egress_policy_source" text;

INSERT INTO "admin_event_logs" (
  "id",
  "organization_id",
  "level",
  "category",
  "action",
  "target_type",
  "target_id",
  "message",
  "metadata"
)
SELECT
  'oci-egress-default-deny-' || "id",
  "organization_id",
  'warn',
  'mcp',
  'mcp.oci_egress.migrated_to_none',
  'mcp_server',
  "id",
  'Legacy OCI MCP networking was changed from unrestricted bridge access to no network.',
  jsonb_build_object(
    'environmentId', "environment_id",
    'imageDigest', "oci_digest",
    'previousNetworkAccess', "network_access",
    'policyRevision', 'legacy:' || "id"
  )
FROM "mcp_servers"
WHERE "source_type" = 'oci'
  AND "network_access" = 'full'
ON CONFLICT ("id") DO NOTHING;

UPDATE "mcp_servers"
SET
  "network_access" = 'none',
  "oci_egress_policy" = '{"mode":"none","version":1}'::jsonb,
  "oci_egress_policy_digest" = 'sha256:59704c11b4f9b612e75f68fac891e4dca743d52d7a946d6d64db287c7b620633',
  "oci_egress_policy_revision" = 'legacy:' || "id",
  "oci_egress_policy_source" = 'custom',
  "updated_at" = now()
WHERE "source_type" = 'oci';

ALTER TABLE "mcp_servers"
  DROP CONSTRAINT IF EXISTS "mcp_servers_oci_egress_policy_check",
  DROP CONSTRAINT IF EXISTS "mcp_servers_oci_network_projection_check";

ALTER TABLE "mcp_servers"
  ADD CONSTRAINT "mcp_servers_oci_egress_policy_check"
  CHECK (
    (
      "source_type" = 'remote'
      AND "oci_egress_policy" IS NULL
      AND "oci_egress_policy_digest" IS NULL
      AND "oci_egress_policy_revision" IS NULL
      AND "oci_egress_policy_source" IS NULL
    )
    OR
    (
      "source_type" = 'oci'
      AND "oci_egress_policy" IS NOT NULL
      AND "oci_egress_policy_digest" ~ '^sha256:[0-9a-f]{64}$'
      AND length("oci_egress_policy_revision") > 0
      AND "oci_egress_policy_source" IN ('custom', 'managed')
    )
  ),
  ADD CONSTRAINT "mcp_servers_oci_network_projection_check"
  CHECK (
    "source_type" <> 'oci'
    OR "network_access" = CASE
      WHEN "oci_egress_policy"->>'mode' = 'unrestricted' THEN 'full'
      ELSE 'none'
    END
  );

ALTER TABLE "mcp_run_grants"
  ADD COLUMN IF NOT EXISTS "execution_profile_id" text,
  ADD COLUMN IF NOT EXISTS "execution_profile_fingerprint" text,
  ADD COLUMN IF NOT EXISTS "oci_egress_bindings" jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE "mcp_run_grants"
SET
  "status" = 'revoked',
  "revoked_at" = now()
WHERE "status" IN ('issued', 'active')
  AND (
    "execution_profile_id" IS NULL
    OR "execution_profile_fingerprint" IS NULL
  );

CREATE TABLE IF NOT EXISTS "mcp_egress_events" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "environment_id" text NOT NULL REFERENCES "environments"("id") ON DELETE cascade,
  "server_id" text NOT NULL REFERENCES "mcp_servers"("id") ON DELETE restrict,
  "grant_id" text REFERENCES "mcp_run_grants"("id") ON DELETE cascade,
  "discovery_job_id" text REFERENCES "mcp_discovery_jobs"("id") ON DELETE cascade,
  "execution_profile_fingerprint" text,
  "policy_revision" text NOT NULL,
  "policy_digest" text NOT NULL,
  "image_digest" text NOT NULL,
  "event_kind" text NOT NULL,
  "network_mode" text NOT NULL,
  "hostname" text,
  "port" integer,
  "protocol" text,
  "selected_address" text,
  "address_family" integer,
  "address_classification" text,
  "denial_reason" text,
  "override_justification" text,
  "override_actor_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_egress_events_organization_environment_fk"
    FOREIGN KEY ("organization_id", "environment_id")
    REFERENCES "environments"("organization_id", "id") ON DELETE cascade,
  CONSTRAINT "mcp_egress_events_owner_check"
    CHECK (num_nonnulls("grant_id", "discovery_job_id") = 1),
  CONSTRAINT "mcp_egress_events_kind_check"
    CHECK ("event_kind" IN (
      'policy.resolved',
      'launch.allowed',
      'launch.denied',
      'gateway.started',
      'gateway.failed',
      'gateway.cleaned',
      'destination.allowed',
      'destination.denied',
      'unrestricted.override_used'
    )),
  CONSTRAINT "mcp_egress_events_mode_check"
    CHECK ("network_mode" IN ('none', 'allow_hosts', 'unrestricted')),
  CONSTRAINT "mcp_egress_events_protocol_check"
    CHECK ("protocol" IS NULL OR "protocol" IN ('http', 'https')),
  CONSTRAINT "mcp_egress_events_address_classification_check"
    CHECK ("address_classification" IS NULL OR "address_classification" IN (
      'public', 'loopback', 'private', 'link_local', 'multicast', 'unspecified',
      'reserved', 'broadcast', 'metadata', 'docker_local', 'malformed'
    )),
  CONSTRAINT "mcp_egress_events_denial_reason_check"
    CHECK ("denial_reason" IS NULL OR "denial_reason" IN (
      'POLICY_MISSING', 'POLICY_MALFORMED', 'POLICY_STALE', 'BINDING_MISMATCH',
      'GATEWAY_UNAVAILABLE', 'NETWORK_ISOLATION_INVALID',
      'DESTINATION_NOT_ALLOWED', 'HOSTNAME_INVALID', 'PORT_NOT_ALLOWED',
      'PROTOCOL_NOT_ALLOWED', 'DNS_RESOLUTION_FAILED', 'ADDRESS_FORBIDDEN',
      'EVIDENCE_UNAVAILABLE', 'GATEWAY_FAILED', 'UNSUPPORTED_PROTOCOL'
    )),
  CONSTRAINT "mcp_egress_events_destination_check"
    CHECK (
      "event_kind" NOT IN ('destination.allowed', 'destination.denied')
      OR ("hostname" IS NOT NULL AND "port" BETWEEN 1 AND 65535 AND "protocol" IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS "mcp_egress_events_server_created_idx"
  ON "mcp_egress_events" ("server_id", "created_at");

CREATE INDEX IF NOT EXISTS "mcp_egress_events_grant_created_idx"
  ON "mcp_egress_events" ("grant_id", "created_at");
