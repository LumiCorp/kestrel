UPDATE mission_control_projects
SET authority_epoch = 1
WHERE authority_epoch < 1;

ALTER TABLE mission_control_projects
  ALTER COLUMN authority_epoch SET DEFAULT 1;

ALTER TABLE mission_control_projects
  DROP CONSTRAINT IF EXISTS mission_control_projects_authority_epoch_check;

ALTER TABLE mission_control_projects
  ADD CONSTRAINT mission_control_projects_authority_epoch_check
  CHECK (authority_epoch > 0);
