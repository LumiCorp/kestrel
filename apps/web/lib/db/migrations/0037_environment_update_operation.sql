ALTER TABLE "environment_operations"
  DROP CONSTRAINT IF EXISTS "environment_operations_type_check";

ALTER TABLE "environment_operations"
  ADD CONSTRAINT "environment_operations_type_check" CHECK (
    "type" IN (
      'environment.provision', 'environment.update', 'environment.delete',
      'workspace.provision', 'workspace.start', 'workspace.stop',
      'workspace.rebuild', 'workspace.delete', 'workspace.backup',
      'workspace.restore', 'workspace.reconcile'
    )
  );
