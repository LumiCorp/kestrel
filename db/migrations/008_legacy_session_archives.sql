CREATE TABLE IF NOT EXISTS legacy_session_archives (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_legacy_session_archives_session_created
  ON legacy_session_archives(session_id, created_at DESC);

ALTER TABLE region_work_items
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error_json JSONB;

ALTER TABLE region_work_items
  DROP CONSTRAINT IF EXISTS region_work_items_status_check;

ALTER TABLE region_work_items
  ADD CONSTRAINT region_work_items_status_check
  CHECK (status IN ('PENDING', 'CLAIMED', 'DONE', 'FAILED'));

CREATE INDEX IF NOT EXISTS idx_region_work_items_session_status_id
  ON region_work_items(session_id, status, id);
