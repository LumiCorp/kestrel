DO $$
BEGIN
  IF to_regclass('public.dev_shell_processes') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'dev_shell_processes'
       AND column_name = 'source_write_guard_json'
  ) THEN
    ALTER TABLE public.dev_shell_processes
      ADD COLUMN source_write_guard_json jsonb;
  END IF;
END $$;
