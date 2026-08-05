export const RELEASE_CONTROLLER_CONTRACT_REVISION = 1;
export const RELEASE_CONTROLLER_HEARTBEAT_MAX_AGE_MS = 90_000;

const CONTROLLER_QUEUE_SUFFIX = `controller-v${RELEASE_CONTROLLER_CONTRACT_REVISION}`;

export const RELEASE_CONTROLLER_QUEUES = {
  environmentOperation: `environment.operation.${CONTROLLER_QUEUE_SUFFIX}`,
  environmentReconcile: `environment.reconcile.${CONTROLLER_QUEUE_SUFFIX}`,
  flyImageRelease: `fly-image.release.${CONTROLLER_QUEUE_SUFFIX}`,
  organizationDeletion: `organization.deletion.${CONTROLLER_QUEUE_SUFFIX}`,
} as const;

export const LEGACY_RELEASE_CONTROLLER_QUEUES = {
  environmentOperation: "environment.operation",
  environmentReconcile: "environment.reconcile",
  flyImageRelease: "fly-image.release",
  organizationDeletion: "organization.deletion",
  organizationDeletionV2: "organization.deletion.v2",
} as const;
