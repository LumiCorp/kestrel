CREATE TABLE IF NOT EXISTS session_product_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  project_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  task_graph_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  workspace_checkpoint_state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
