import {
  type EnvironmentReconcileLock,
  withEnvironmentReconcileLock,
} from "./reconcile-lock";

export const ENVIRONMENT_RECONCILE_CRON = "* * * * *";

type EnvironmentReconciliationResult = {
  operationCount: number;
  environmentGatewayCount: number;
  workspaceCount: number;
};

type EnvironmentReconcile = () => Promise<EnvironmentReconciliationResult>;

export async function runScheduledEnvironmentReconciliation(input?: {
  reconcile?: EnvironmentReconcile;
  createLock?: (lockKey: string) => Promise<EnvironmentReconcileLock>;
}) {
  return withEnvironmentReconcileLock({
    run: input?.reconcile ?? loadAndReconcileHostedEnvironments,
    createLock: input?.createLock,
  });
}

async function loadAndReconcileHostedEnvironments() {
  const { reconcileHostedEnvironments } = await import("./reconcile");
  return reconcileHostedEnvironments();
}
