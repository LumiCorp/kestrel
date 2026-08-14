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
      type: true,
      input: true,
    },
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
      const images =
        operation.type === "environment.update"
          ? requireEnvironmentUpdateImages(operation.input)
          : await resolveStableEnvironmentImages();
      const provisioner = new EnvironmentProvisioner({
        repository: databaseEnvironmentProvisioningRepository,
        provider: await createFlyProviderClient(operation.organizationId),
        runtimeImage: images.runtimeImage,
        routerImage: images.routerImage,
        ticketPublicKey:
          process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
        controlPlaneUrl: process.env.KESTREL_ONE_APP_URL ?? "",
      });
      return provisioner.process(operationId);
    },
  });
  return locked.acquired ? locked.result : "not_claimed";
}

function requireEnvironmentUpdateImages(input: Record<string, unknown> | null) {
  const runtimeImage = input?.runtimeImage;
  const routerImage = input?.routerImage;
  if (!(typeof runtimeImage === "string" && typeof routerImage === "string")) {
    throw new Error(
      "Environment update operation is missing its immutable candidate images.",
    );
  }
  return { runtimeImage, routerImage };
}

async function resolveStableEnvironmentImages() {
  const { requireStableFlyEnvironmentImages } =
    await import("@/lib/releases/store");
  return requireStableFlyEnvironmentImages();
}
