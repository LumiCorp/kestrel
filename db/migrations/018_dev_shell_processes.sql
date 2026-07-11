CREATE TABLE IF NOT EXISTS dev_shell_processes (
  process_id text PRIMARY KEY,
  command_text text NOT NULL,
  status text NOT NULL,
  workspace_root text NOT NULL,
  cwd text NOT NULL,
  shell_path text NOT NULL,
  idle_timeout_ms integer NOT NULL,
  max_read_bytes integer NOT NULL,
  readiness_json jsonb NOT NULL,
  requested_tools_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  env_names_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  transcript_path text NOT NULL,
  output_cursor bigint NOT NULL DEFAULT 0,
  submitted_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  exit_code integer,
  stop_signal text,
  failure_reason text
);

CREATE INDEX IF NOT EXISTS dev_shell_processes_status_updated_idx
  ON dev_shell_processes (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS dev_shell_processes_workspace_updated_idx
  ON dev_shell_processes (workspace_root, updated_at DESC);
