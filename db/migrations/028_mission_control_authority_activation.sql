CREATE TABLE IF NOT EXISTS mission_control_legacy_source_locks (
  source_id TEXT PRIMARY KEY CHECK (length(btrim(source_id)) > 0),
  project_id UUID NOT NULL
    REFERENCES mission_control_projects(project_id) ON DELETE CASCADE,
  authority_epoch BIGINT NOT NULL CHECK (authority_epoch > 0),
  source_fingerprint TEXT NOT NULL
    CHECK (source_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  frozen_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mission_control_legacy_locks_project
  ON mission_control_legacy_source_locks (project_id, source_id);
