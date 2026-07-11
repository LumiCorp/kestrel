ALTER TABLE dev_shell_sessions
  ALTER COLUMN max_read_bytes SET DEFAULT 131072;

UPDATE dev_shell_sessions
SET max_read_bytes = 131072
WHERE max_read_bytes = 16384;
