ALTER TABLE dev_shell_processes
  ADD COLUMN IF NOT EXISTS lifecycle TEXT NOT NULL DEFAULT 'interactive';

ALTER TABLE dev_shell_processes
  ADD COLUMN IF NOT EXISTS retention_leases_json JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE dev_shell_processes
  DROP CONSTRAINT IF EXISTS dev_shell_processes_lifecycle_check;

ALTER TABLE dev_shell_processes
  ADD CONSTRAINT dev_shell_processes_lifecycle_check
  CHECK (lifecycle IN ('interactive', 'retained'));
