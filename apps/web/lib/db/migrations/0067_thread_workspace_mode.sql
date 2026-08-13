ALTER TABLE "threads"
  ADD COLUMN IF NOT EXISTS "workspace_mode" text,
  ADD COLUMN IF NOT EXISTS "workspace_base_ref" text;

UPDATE "threads"
SET "workspace_mode" = 'legacy'
WHERE "workspace_mode" IS NULL;

ALTER TABLE "threads"
  ALTER COLUMN "workspace_mode" SET DEFAULT 'primary',
  ALTER COLUMN "workspace_mode" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'threads_workspace_mode_check'
      AND conrelid = 'threads'::regclass
  ) THEN
    ALTER TABLE "threads"
      ADD CONSTRAINT "threads_workspace_mode_check"
      CHECK ("workspace_mode" IN ('primary', 'isolated', 'legacy'));
  END IF;
END $$;
