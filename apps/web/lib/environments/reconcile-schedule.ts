import {
  type EnvironmentReconcileLock,
  withEnvironmentReconcileLock,
} from "./reconcile-lock";

export const ENVIRONMENT_RECONCILE_CRON = "* * * * *";

type EnvironmentReconciliationResult = {
  operationCount: number;
  operationFailureCount: number;
  repairedExecutionCount: number;
  environmentGatewayCount: number;
  workspaceCount: number;
  adoptedVolumeCount: number;
  degradedWorkspaceCount: number;
  finalizedPreviewCount: number;
};

type EnvironmentReconcile = () => Promise<EnvironmentReconciliationResult>;
type BrowserDownloadReconcile = () => Promise<void>;

export async function runScheduledEnvironmentReconciliation(input?: {
  reconcile?: EnvironmentReconcile;
  reconcileBrowserDownloads?: BrowserDownloadReconcile;
  createLock?: (lockKey: string) => Promise<EnvironmentReconcileLock>;
}) {
  return withEnvironmentReconcileLock({
    run: async () => {
      await (input?.reconcileBrowserDownloads ??
        loadAndReconcileHostedBrowserDownloads)();
      return await (input?.reconcile ?? loadAndReconcileHostedEnvironments)();
    },
    createLock: input?.createLock,
  });
}

async function loadAndReconcileHostedEnvironments() {
  const { reconcileHostedEnvironments } = await import("./reconcile");
  return reconcileHostedEnvironments();
}

async function loadAndReconcileHostedBrowserDownloads() {
  const { reconcileHostedBrowserDownloadStaging } = await import(
    "@/lib/files/service"
  );
  await reconcileHostedBrowserDownloadStaging();
}
