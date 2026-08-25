ALTER TABLE orchestration_interaction_requests
  ADD COLUMN IF NOT EXISTS run_id TEXT;

UPDATE orchestration_interaction_requests AS interaction
   SET run_id = interaction.metadata_json->>'conversationRunId'
 WHERE interaction.run_id IS NULL
   AND NULLIF(interaction.metadata_json->>'conversationRunId', '') IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM runs
      WHERE runs.run_id = interaction.metadata_json->>'conversationRunId'
   );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'orchestration_interaction_requests_run_id_fkey'
  ) THEN
    ALTER TABLE orchestration_interaction_requests
      ADD CONSTRAINT orchestration_interaction_requests_run_id_fkey
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_orchestration_interaction_requests_run_id
  ON orchestration_interaction_requests(run_id)
  WHERE run_id IS NOT NULL;
