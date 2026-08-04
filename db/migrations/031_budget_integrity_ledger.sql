CREATE TABLE IF NOT EXISTS budget_repository_states (
  repository_id TEXT PRIMARY KEY,
  state_json JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budget_ledger_entries (
  repository_id TEXT NOT NULL REFERENCES budget_repository_states(repository_id) ON DELETE RESTRICT,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  entry_id TEXT NOT NULL CHECK (entry_id ~ '^sha256:[0-9a-f]{64}$'),
  allocation_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'allocation.opened',
    'allocation.closed',
    'child.reserved',
    'child.committed',
    'reservation.opened',
    'reservation.committed',
    'reservation.released'
  )),
  entry_json JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (repository_id, sequence),
  UNIQUE (repository_id, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_budget_ledger_allocation_sequence
  ON budget_ledger_entries (repository_id, allocation_id, sequence);
