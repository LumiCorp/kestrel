import type { EnvironmentOperationType } from "./contracts";

export const PROVISIONER_OPERATION_TYPES = [
  "environment.provision",
  "environment.update",
  "environment.delete",
  "workspace.provision",
  "workspace.start",
  "workspace.stop",
  "workspace.rebuild",
  "workspace.delete",
] as const satisfies readonly EnvironmentOperationType[];

export const RESOURCE_MUTATING_OPERATION_TYPES = [
  "environment.provision",
  "environment.update",
  "environment.delete",
  "workspace.provision",
  "workspace.rebuild",
  "workspace.delete",
  "workspace.restore",
] as const satisfies readonly EnvironmentOperationType[];

export function isProvisionerOperationType(
  type: EnvironmentOperationType
): type is (typeof PROVISIONER_OPERATION_TYPES)[number] {
  return PROVISIONER_OPERATION_TYPES.includes(
    type as (typeof PROVISIONER_OPERATION_TYPES)[number]
  );
}
