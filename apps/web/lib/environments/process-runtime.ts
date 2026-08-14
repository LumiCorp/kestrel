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
      const runtimeImagesRequired = operationRequiresRuntimeImages(
        operation.type,
      );
      const images = runtimeImagesRequired
        ? operation.type === "environment.update"
          ? await resolveEnvironmentUpdateImages(operation)
          : await resolveStableEnvironmentImages()
        : { runtimeImage: "", routerImage: "" };
      const provisioner = new EnvironmentProvisioner({
        repository: databaseEnvironmentProvisioningRepository,
        provider: await createFlyProviderClient(operation.organizationId),
        runtimeImage: images.runtimeImage,
        routerImage: images.routerImage,
        requireRuntimeImages: runtimeImagesRequired,
        ticketPublicKey:
          process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
        controlPlaneUrl: process.env.KESTREL_ONE_APP_URL ?? "",
      });
      return provisioner.process(operationId);
    },
  });
  return locked.acquired ? locked.result : "not_claimed";
}

export function operationRequiresRuntimeImages(type: string) {
  return type !== "environment.delete" && type !== "workspace.delete";
}

async function resolveEnvironmentUpdateImages(operation: {
  environmentId: string;
  input: Record<string, unknown> | null;
}) {
  const releaseTargetId = operation.input?.releaseTargetId;
  if (typeof releaseTargetId !== "string") {
    return resolveStableEnvironmentImages();
  }
  const releaseId = operation.input?.releaseId;
  if (typeof releaseId !== "string") {
    throw new Error(
      "Release Environment update operation is missing its release identity.",
    );
  }
  const target = await knowledgeDb.query.flyImageReleaseTargets.findFirst({
    where: eq(schema.flyImageReleaseTargets.id, releaseTargetId),
    columns: {
      releaseId: true,
      targetKind: true,
      environmentId: true,
      status: true,
    },
  });
  if (
    !target ||
    target.releaseId !== releaseId ||
    target.targetKind !== "environment" ||
    target.environmentId !== operation.environmentId ||
    target.status !== "applying"
  ) {
    throw new Error(
      "Release Environment update operation is not bound to its release target.",
    );
  }
  const images = requireEnvironmentUpdateImages(operation.input);
  const components = await knowledgeDb.query.flyImageReleaseComponents.findMany({
    where: eq(schema.flyImageReleaseComponents.releaseId, releaseId),
    columns: { role: true, image: true },
  });
  if (
    components.find((component) => component.role === "workspace-runtime")
      ?.image !== images.runtimeImage ||
    components.find((component) => component.role === "environment-router")
      ?.image !== images.routerImage
  ) {
    throw new Error(
      "Release Environment update images do not match the immutable release manifest.",
    );
  }
  return images;
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
