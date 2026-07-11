DO $$
BEGIN
  IF to_regclass('public.dev_shell_processes') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'dev_shell_processes'
       AND column_name = 'delivered_cursor'
  ) AND NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'dev_shell_processes'
       AND column_name = 'output_cursor'
  ) THEN
    ALTER TABLE public.dev_shell_processes
      RENAME COLUMN delivered_cursor TO output_cursor;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'dev_shell_processes'
       AND column_name = 'output_cursor'
  ) THEN
    ALTER TABLE public.dev_shell_processes
      ADD COLUMN output_cursor bigint NOT NULL DEFAULT 0;
  END IF;

  ALTER TABLE public.dev_shell_processes
    ALTER COLUMN output_cursor SET DEFAULT 0;

  UPDATE public.dev_shell_processes
     SET output_cursor = 0
   WHERE output_cursor IS NULL;

  ALTER TABLE public.dev_shell_processes
    ALTER COLUMN output_cursor SET NOT NULL;
END $$;
