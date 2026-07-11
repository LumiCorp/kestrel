CREATE TABLE IF NOT EXISTS dev_shell_sessions (
  shell_session_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  cwd TEXT NOT NULL,
  shell_path TEXT NOT NULL,
  idle_timeout_ms INTEGER NOT NULL DEFAULT 1800000,
  max_read_bytes INTEGER NOT NULL DEFAULT 16384,
  readiness_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_tools_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  env_names_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  transcript_path TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  active_command_id TEXT,
  last_exit_code INTEGER,
  ended_at TIMESTAMPTZ,
  failure_reason TEXT
);

ALTER TABLE dev_shell_sessions
  ADD COLUMN IF NOT EXISTS idle_timeout_ms INTEGER NOT NULL DEFAULT 1800000,
  ADD COLUMN IF NOT EXISTS max_read_bytes INTEGER NOT NULL DEFAULT 16384;

CREATE INDEX IF NOT EXISTS idx_dev_shell_sessions_status_updated
  ON dev_shell_sessions(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS dev_shell_commands (
  command_id TEXT PRIMARY KEY,
  shell_session_id TEXT NOT NULL REFERENCES dev_shell_sessions(shell_session_id) ON DELETE CASCADE,
  command_text TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  exit_code INTEGER,
  stop_signal TEXT,
  transcript_cursor_start INTEGER NOT NULL,
  transcript_cursor_end INTEGER,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dev_shell_commands_session_submitted
  ON dev_shell_commands(shell_session_id, submitted_at DESC);
