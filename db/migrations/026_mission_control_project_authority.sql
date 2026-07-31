CREATE TABLE IF NOT EXISTS mission_control_projects (
  project_id UUID PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  authority_epoch BIGINT NOT NULL DEFAULT 0 CHECK (authority_epoch >= 0),
  document_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mission_control_action_receipts (
  project_id UUID NOT NULL
    REFERENCES mission_control_projects(project_id) ON DELETE CASCADE,
  action_id TEXT NOT NULL CHECK (length(btrim(action_id)) > 0),
  request_fingerprint TEXT NOT NULL
    CHECK (length(btrim(request_fingerprint)) > 0),
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, action_id)
);

CREATE TABLE IF NOT EXISTS mission_control_outbox (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL
    REFERENCES mission_control_projects(project_id) ON DELETE CASCADE,
  action_id TEXT NOT NULL CHECK (length(btrim(action_id)) > 0),
  effect_id TEXT NOT NULL CHECK (length(btrim(effect_id)) > 0),
  effect_type TEXT NOT NULL CHECK (length(btrim(effect_type)) > 0),
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  UNIQUE (project_id, effect_id)
);

CREATE INDEX IF NOT EXISTS idx_mission_control_outbox_pending
  ON mission_control_outbox (project_id, id)
  WHERE status = 'PENDING';
