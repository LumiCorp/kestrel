import { createFlyProviderClient } from "./fly-connection";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { eq } from "drizzle-orm";
import {
  databaseEnvironmentProvisioningRepository,
  EnvironmentProvisioner,
} from "./provisioner";
import { withEnvironmentOperationLock } from "./reconcile-lock";
import {
  parseEnvironmentWorkerAttempt,
  type EnvironmentWorkerAttempt,
} from "./worker-failure";

export async function processEnvironmentOperation(
  operationId: string,
  options: {
    workerSignal?: AbortSignal | undefined;
    workerAttempt?: EnvironmentWorkerAttempt | undefined;
  } = {},
) {
  const operation = await knowledgeDb.query.environmentOperations.findFirst({
    where: eq(schema.environmentOperations.id, operationId),
    columns: {
      organizationId: true,
      environmentId: true,
      workspaceId: true,
      type: true,
      input: true,
    },
  });
  if (!operation) throw new Error("Environment operation was not found.");
  const locked = await withEnvironmentOperationLock({
    environmentId:
      operation.type === "workspace.rebuild" &&
      typeof operation.input?.targetGeneration === "number" &&
      operation.workspaceId
        ? `workspace:${operation.workspaceId}`
        : operation.environmentId,
    run: async () => {
      if (operation.type === "workspace.backup") {
        const { processQueuedWorkspaceBackup } = await import("./backups");
        return processQueuedWorkspaceBackup({
          operationId,
          signal: options.workerSignal,
          workerAttempt:
            options.workerAttempt ??
            parseEnvironmentWorkerAttempt({
              retryCount: 0,
              retryLimit: 0,
            }),
        });
      }
      const { getStableFlyEnvironmentImages } =
        await import("@/lib/releases/store");
      const { getActivePlatformEnvironmentImages } =
        await import("@/lib/runtime-deployments/store");
      const [platformImages, stableImages] = await Promise.all([
        getActivePlatformEnvironmentImages(),
        getStableFlyEnvironmentImages(),
      ]);
      const provisioner = new EnvironmentProvisioner({
        repository: databaseEnvironmentProvisioningRepository,
        provider: await createFlyProviderClient(operation.organizationId),
        runtimeImage:
          platformImages?.runtimeImage ??
          stableImages?.runtimeImage ??
          process.env.KESTREL_WORKSPACE_RUNTIME_IMAGE?.trim() ??
          "",
        routerImage:
          platformImages?.routerImage ??
          stableImages?.routerImage ??
          process.env.KESTREL_ENVIRONMENT_ROUTER_IMAGE?.trim() ??
          "",
        ticketPublicKey:
          process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
        controlPlaneUrl: process.env.KESTREL_ONE_APP_URL ?? "",
      });
      return provisioner.process(operationId);
    },
  });
  return locked.acquired ? locked.result : "not_claimed";
}
