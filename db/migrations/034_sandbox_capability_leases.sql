CREATE TABLE IF NOT EXISTS sandbox_capability_leases (
  lease_id TEXT PRIMARY KEY,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  transition TEXT NOT NULL CHECK (transition IN ('requested', 'denied', 'issued', 'invoking', 'consumed', 'exhausted', 'revoked', 'expired', 'cancelled', 'cleaned')),
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  binding_json JSONB NOT NULL,
  usage_json JSONB NOT NULL,
  issued_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('denied', 'completed', 'failed', 'exhausted', 'revoked', 'expired', 'cancelled')),
  terminal_reason TEXT,
  cleaned_at TIMESTAMPTZ,
  result_json JSONB,
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, tool_call_id)
);

CREATE TABLE IF NOT EXISTS sandbox_capability_lease_transitions (
  lease_id TEXT NOT NULL REFERENCES sandbox_capability_leases(lease_id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  transition TEXT NOT NULL CHECK (transition IN ('requested', 'denied', 'issued', 'invoking', 'consumed', 'exhausted', 'revoked', 'expired', 'cancelled', 'cleaned')),
  binding_digest TEXT NOT NULL,
  record_json JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (lease_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_sandbox_capability_leases_recovery
  ON sandbox_capability_leases(occurred_at, lease_id)
  WHERE cleaned_at IS NULL AND transition NOT IN ('requested', 'denied', 'cleaned');

CREATE TABLE IF NOT EXISTS sandbox_capability_child_reservations (
  reservation_id TEXT PRIMARY KEY,
  parent_lease_id TEXT NOT NULL REFERENCES sandbox_capability_leases(lease_id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released', 'revoked')),
  decision_id TEXT NOT NULL UNIQUE,
  parent_binding_digest TEXT NOT NULL,
  child_run_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  child_tool_call_id TEXT NOT NULL,
  request_limit BIGINT NOT NULL CHECK (request_limit > 0),
  response_byte_limit BIGINT NOT NULL CHECK (response_byte_limit > 0),
  requests_committed BIGINT NOT NULL DEFAULT 0 CHECK (requests_committed >= 0),
  response_bytes_committed BIGINT NOT NULL DEFAULT 0 CHECK (response_bytes_committed >= 0),
  record_json JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (parent_lease_id, child_run_id, child_tool_call_id)
);

CREATE TABLE IF NOT EXISTS sandbox_capability_child_reservation_transitions (
  reservation_id TEXT NOT NULL REFERENCES sandbox_capability_child_reservations(reservation_id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released', 'revoked')),
  record_json JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (reservation_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_sandbox_capability_child_parent
  ON sandbox_capability_child_reservations(parent_lease_id, status, reservation_id);
