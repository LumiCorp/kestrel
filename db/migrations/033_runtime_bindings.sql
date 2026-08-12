CREATE TABLE IF NOT EXISTS local_runtime_environment_identity (
  identity_key TEXT PRIMARY KEY CHECK (identity_key = 'local'),
  environment_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS local_runtime_bindings (
  canonical_thread_id TEXT PRIMARY KEY,
  runner_session_id TEXT NOT NULL UNIQUE,
  binding_id TEXT NOT NULL UNIQUE,
  participant_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL CHECK (runtime_id IN ('kestrel', 'codex', 'claude')),
  environment_id TEXT NOT NULL,
  capability_digest TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'degraded', 'released')),
  native_session_state TEXT NOT NULL CHECK (
    native_session_state IN ('uninitialized', 'ready', 'degraded', 'released')
  ),
  latest_loss_code TEXT,
  source_binding_id TEXT,
  forked_from_thread_id TEXT,
  recovery_policy TEXT CHECK (
    recovery_policy IS NULL OR recovery_policy IN ('fork_to_kestrel', 'fork_to_same_runtime')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_local_runtime_bindings_binding
  ON local_runtime_bindings (binding_id, environment_id);

CREATE INDEX IF NOT EXISTS idx_local_runtime_bindings_runner_session
  ON local_runtime_bindings (runner_session_id, environment_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_local_runtime_bindings_source_recovery
  ON local_runtime_bindings (source_binding_id)
  WHERE source_binding_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS local_runtime_binding_release_outbox (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL UNIQUE,
  participant_id TEXT NOT NULL,
  canonical_thread_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL CHECK (runtime_id IN ('codex', 'claude')),
  environment_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'released', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  acknowledgement_event_id TEXT UNIQUE,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_local_runtime_binding_release_pending
  ON local_runtime_binding_release_outbox (state, created_at);
