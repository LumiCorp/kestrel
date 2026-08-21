DROP INDEX "infrastructure_connector_commands_operation_idx";

CREATE INDEX "infrastructure_connector_commands_operation_idx"
  ON "infrastructure_connector_commands" ("operation_id")
  WHERE "operation_id" IS NOT NULL;

ALTER TABLE "environment_operations"
  DROP CONSTRAINT IF EXISTS "environment_operations_type_check";

ALTER TABLE "environment_operations"
  ADD CONSTRAINT "environment_operations_type_check" CHECK (
    "type" IN (
      'environment.provision', 'environment.update', 'environment.delete',
      'environment.reconcile',
      'workspace.provision', 'workspace.start', 'workspace.stop',
      'workspace.rebuild', 'workspace.delete', 'workspace.backup',
      'workspace.restore', 'workspace.reconcile'
    )
  );
