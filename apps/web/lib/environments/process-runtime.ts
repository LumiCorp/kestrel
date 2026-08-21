import { resolveEnvironmentProvider } from "./provider-registry";
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
        ? operation.type === "environment.update" ||
          operation.type === "environment.provision"
          ? await resolveEnvironmentUpdateImages(operation)
          : await resolveAppliedEnvironmentImages(operation.environmentId)
        : { runtimeImage: "", routerImage: "" };
      const provisioner = new EnvironmentProvisioner({
        repository: databaseEnvironmentProvisioningRepository,
        provider: await resolveEnvironmentProvider({
          organizationId: operation.organizationId,
          environmentId: operation.environmentId,
          operationId,
          workspaceId: operation.workspaceId ?? undefined,
        }).then((provider) => {
          if (!provider.legacyLifecycle) {
            throw new Error(
              `Environment ${operation.environmentId} does not use a hosted lifecycle adapter.`,
            );
          }
          return provider.legacyLifecycle;
        }),
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
  const runtimeVersionId = operation.input?.runtimeVersionId;
  if (typeof runtimeVersionId !== "string") {
    throw new Error(
      "Environment lifecycle operation is missing its Runtime Version identity.",
    );
  }
  const images = requireEnvironmentUpdateImages(operation.input);
  const version = await knowledgeDb.query.environmentRuntimeVersions.findFirst({
    where: eq(schema.environmentRuntimeVersions.id, runtimeVersionId),
  });
  if (
    version?.workspaceRuntimeImage !== images.runtimeImage ||
    version.environmentRouterImage !== images.routerImage
  ) {
    throw new Error(
      "Environment update images do not match the immutable Runtime Version.",
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

async function resolveAppliedEnvironmentImages(environmentId: string) {
  const environment = await knowledgeDb.query.environments.findFirst({
    where: eq(schema.environments.id, environmentId),
    columns: { runtimeImage: true, routerImage: true },
  });
  if (!(environment?.runtimeImage && environment.routerImage)) {
    throw new Error(
      "The existing Environment is missing its applied immutable runtime images.",
    );
  }
  return {
    runtimeImage: environment.runtimeImage,
    routerImage: environment.routerImage,
  };
}
