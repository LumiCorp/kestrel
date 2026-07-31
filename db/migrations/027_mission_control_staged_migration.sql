CREATE TABLE IF NOT EXISTS mission_control_migration_source_bindings (
  source_id TEXT PRIMARY KEY CHECK (length(btrim(source_id)) > 0),
  project_id UUID NOT NULL
    REFERENCES mission_control_projects(project_id) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL
    CHECK (source_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  action_id TEXT NOT NULL CHECK (length(btrim(action_id)) > 0),
  bound_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mission_control_migration_bindings_project
  ON mission_control_migration_source_bindings (project_id, source_id);
