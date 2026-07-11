ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS current_state_json JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE sessions s
SET current_state_json = COALESCE(sv.state_json, '{}'::jsonb)
FROM session_versions sv
WHERE sv.session_id = s.session_id
  AND sv.version = s.current_version;

ALTER TABLE session_versions
  ADD COLUMN IF NOT EXISTS state_patch_json JSONB;

ALTER TABLE session_versions
  ADD COLUMN IF NOT EXISTS snapshot_kind TEXT NOT NULL DEFAULT 'full';

UPDATE session_versions
SET snapshot_kind = 'full'
WHERE snapshot_kind IS NULL OR snapshot_kind = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'session_versions_snapshot_kind_check'
  ) THEN
    ALTER TABLE session_versions
      ADD CONSTRAINT session_versions_snapshot_kind_check
      CHECK (snapshot_kind IN ('full', 'delta'));
  END IF;
END $$;
