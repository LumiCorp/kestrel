CREATE TABLE IF NOT EXISTS "kestrel_schema_reconciliations" (
  "key" text PRIMARY KEY NOT NULL,
  "details" jsonb NOT NULL,
  "reconciled_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF to_regclass('public.platform_email_config') IS NULL THEN
    RAISE EXCEPTION 'Schema reconciliation is missing platform_email_config';
  END IF;
  IF to_regclass('public.ai_deployment_profiles') IS NULL
     OR to_regclass('public.ai_deployments') IS NULL
     OR to_regclass('public.ai_deployment_runs') IS NULL THEN
    RAISE EXCEPTION 'Schema reconciliation is missing managed RunPod tables';
  END IF;
  IF to_regclass('public.environments_org_id_idx') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'projects'
         AND column_name = 'environment_id'
     ) THEN
    RAISE EXCEPTION 'Schema reconciliation is missing Project Environment ownership';
  END IF;
  IF to_regclass('public.mcp_credentials') IS NULL
     OR to_regclass('public.mcp_servers') IS NULL
     OR to_regclass('public.mcp_invocations') IS NULL THEN
    RAISE EXCEPTION 'Schema reconciliation is missing hosted MCP tables';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'mcp_interaction_checkpoints'
      AND column_name = 'processing_expires_at'
  ) THEN
    RAISE EXCEPTION 'Schema reconciliation is missing MCP interaction hardening';
  END IF;
END $$;

INSERT INTO "kestrel_schema_reconciliations" ("key", "details")
VALUES (
  '2026-07-skipped-migrations',
  '{"verified":["0014_platform_email_config","0015_managed_runpod_deployments","0018_environment_project_ownership","0019_hosted_mcp_control_plane","0020_environment_router_upgrade","0021_mcp_interaction_hardening","0022_mcp_sampling_processing_deadline"]}'::jsonb
)
ON CONFLICT ("key") DO UPDATE
SET "details" = excluded."details",
    "reconciled_at" = now();
