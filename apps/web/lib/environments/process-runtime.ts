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
    columns: { organizationId: true, environmentId: true, type: true },
  });
  if (!operation) throw new Error("Environment operation was not found.");
  const locked = await withEnvironmentOperationLock({
    environmentId: operation.environmentId,
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
      if (operation.type === "workspace.provision") {
        const { settleWorkspaceProvisionDependency } =
          await import("./dependency");
        const dependency =
          await settleWorkspaceProvisionDependency(operationId);
        if (dependency === "blocked") return "blocked" as const;
        if (dependency === "terminal") return "processed" as const;
      }
      const { getStableFlyEnvironmentImages } =
        await import("@/lib/releases/store");
      const stableImages = await getStableFlyEnvironmentImages();
      const provisioner = new EnvironmentProvisioner({
        repository: databaseEnvironmentProvisioningRepository,
        provider: await createFlyProviderClient(operation.organizationId),
        runtimeImage:
          stableImages?.runtimeImage ??
          process.env.KESTREL_WORKSPACE_RUNTIME_IMAGE?.trim() ??
          "",
        routerImage:
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
