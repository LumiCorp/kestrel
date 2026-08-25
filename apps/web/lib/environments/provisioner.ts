import { and, eq, inArray, sql } from "drizzle-orm";
import { WORKSPACE_MACHINE_HEALTH_TIMEOUT_SECONDS } from "@lumi/kestrel-environment-auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { classifyDbError } from "@/lib/db/runtime";
import {
  assertEnvironmentTransition,
  assertWorkspaceTransition,
  ENVIRONMENT_IDLE_TIMEOUT_MINUTES,
  environmentStatusSchema,
  workspaceStatusSchema,
} from "./contracts";
import { environmentLifecycleLockKey } from "./lifecycle-lock";
import { PROVISIONER_OPERATION_TYPES } from "./operation-routing";
import {
  type EnvironmentInfrastructureProvider,
  EnvironmentProviderError,
  KESTREL_WORKSPACE_STOP_CONFIG,
} from "./providers/contracts";
import {
  flyEnvironmentAppName,
  flyEnvironmentNetworkName,
} from "./providers/fly-machines";
import {
  createEnvironmentServiceToken,
  hashEnvironmentServiceToken,
} from "./service-tokens";
import { createAuxiliaryVolumeSnapshot } from "./backup-snapshot";
import {
  assertEnvironmentRuntimeImage,
  type EnvironmentRuntimeImageRole,
} from "@/lib/runtime/images";

export type ProvisioningOperation = {
  id: string;
  attempt: number;
  organizationId: string;
  environmentId: string;
  workspaceId: string | null;
  requestedByUserId: string | null;
  type: string;
  input: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  createdAt?: Date;
};

export interface EnvironmentProvisioningRepository {
  claimOperation(operationId: string): Promise<ProvisioningOperation | null>;
  getEnvironment(environmentId: string): Promise<{
    id: string;
    organizationId: string;
    region: string;
    status: string;
    flyAppName: string | null;
    flyGatewayMachineId: string | null;
    routerUrl?: string | null;
    routerImage: string | null;
    runtimeImage: string | null;
    idleTimeoutMinutes: number;
  } | null>;
  getWorkspace(workspaceId: string): Promise<{
    id: string;
    organizationId: string;
    environmentId: string;
    status: string;
    flyMachineId: string | null;
    flyVolumeId: string | null;
    runtimeImage: string | null;
    sourceType: "blank" | "github";
    sourceResourceId: string | null;
    sourceRepository: string | null;
    sourceDefaultBranch: string | null;
  } | null>;
  listEnvironmentWorkspaces(environmentId: string): Promise<
    Array<{
      id: string;
      status: string;
      flyMachineId: string | null;
      flyVolumeId: string | null;
      runtimeImage: string | null;
    }>
  >;
  beginEnvironmentProvisioning(input: {
    environmentId: string;
    operationId: string;
    attempt: number;
  }): Promise<"prepared" | "superseded">;
  stageEnvironmentAppIdentity(input: {
    environmentId: string;
    operationId: string;
    attempt: number;
    appName: string;
    networkName: string;
  }): Promise<"staged" | "superseded">;
  stageEnvironmentGatewayIdentity(input: {
    environmentId: string;
    operationId?: string | undefined;
    attempt?: number | undefined;
    appName: string;
    gatewayServiceTokenHash: string;
  }): Promise<"staged" | "superseded">;
  setEnvironmentDeleting(
    environmentId: string,
    options?: { organizationTeardown?: boolean },
  ): Promise<void>;
  completeEnvironmentProvision(input: {
    environmentId: string;
    operationId: string;
    attempt: number;
    appName: string;
    networkName: string;
    gatewayMachineId: string;
    routerUrl: string;
    routerImage: string;
    runtimeImage: string;
    gatewayServiceTokenHash: string;
  }): Promise<"completed" | "superseded">;
  failEnvironment(input: {
    environmentId: string;
    code: string;
    message: string;
  }): Promise<void>;
  failEnvironmentProvision(input: {
    environmentId: string;
    operationId: string;
    attempt: number;
    code: string;
    message: string;
    stage?: string | undefined;
    providerRequestId?: string | undefined;
    result?: Record<string, unknown> | undefined;
  }): Promise<"failed" | "superseded">;
  degradeEnvironment(input: {
    environmentId: string;
    code: string;
    message: string;
  }): Promise<void>;
  completeEnvironmentGatewayUpdate(input: {
    environmentId: string;
    routerImage: string;
    gatewayServiceTokenHash?: string | undefined;
  }): Promise<void>;
  completeEnvironmentRuntimeUpdate(input: {
    environmentId: string;
    runtimeImage: string;
  }): Promise<void>;
  completeEnvironmentDelete(environmentId: string): Promise<void>;
  setWorkspaceProvisioning(workspaceId: string): Promise<void>;
  completeWorkspace(input: {
    workspaceId: string;
    volumeId: string;
    machineId: string;
    runtimeImage: string;
    serviceTokenHash: string;
  }): Promise<void>;
  failWorkspace(input: {
    workspaceId: string;
    code: string;
    message: string;
  }): Promise<void>;
  degradeWorkspace(input: {
    workspaceId: string;
    code: string;
    message: string;
  }): Promise<void>;
  setWorkspaceStarting(workspaceId: string): Promise<void>;
  setWorkspaceStopping(workspaceId: string): Promise<void>;
  setWorkspaceDeleting(workspaceId: string): Promise<void>;
  completeWorkspaceStart(workspaceId: string): Promise<void>;
  completeWorkspaceStop(workspaceId: string): Promise<void>;
  completeWorkspaceDelete(workspaceId: string): Promise<void>;
  completeWorkspaceRebuild(input: {
    workspaceId: string;
    runtimeImage: string;
    serviceTokenHash?: string | undefined;
  }): Promise<void>;
  completeStoppedWorkspaceRebuild(input: {
    workspaceId: string;
    runtimeImage: string;
    serviceTokenHash?: string | undefined;
  }): Promise<void>;
  configureStoppedWorkspace?(input: {
    workspaceId: string;
    runtimeImage: string;
    serviceTokenHash?: string | undefined;
  }): Promise<void>;
  updateOperationStage(input: {
    operationId: string;
    attempt?: number | undefined;
    stage: string;
    result?: Record<string, unknown> | undefined;
  }): Promise<void>;
  completeOperation(input: {
    operationId: string;
    stage: string;
    result: Record<string, unknown>;
  }): Promise<void>;
  failOperation(input: {
    operationId: string;
    stage: string;
    code: string;
    message: string;
    providerRequestId?: string | undefined;
    result?: Record<string, unknown> | undefined;
  }): Promise<void>;
  deferOperation(input: {
    operationId: string;
    attempt?: number | undefined;
    stage: string;
    code?: string | undefined;
    message: string;
    providerRequestId?: string | undefined;
    providerFailure?: Record<string, unknown> | undefined;
    retryState?:
      | {
          attempt: number;
          firstFailureAt: string;
          lastError: { code: string; message: string };
          nextAttemptAt: string;
          authoritativeState?: unknown;
        }
      | undefined;
  }): Promise<void>;
}

export const ENVIRONMENT_RETRY_BUDGET_MS = 60 * 60 * 1000;

export function environmentRetryDelaySeconds(attempt: number) {
  return [5, 10, 20, 40, 80][attempt - 1] ?? 120;
}

export function environmentRetryNextAttemptAt(
  firstFailureAt: string,
  attempt: number,
  now = Date.now(),
) {
  const deadline = Date.parse(firstFailureAt) + ENVIRONMENT_RETRY_BUDGET_MS;
  if (now >= deadline) return null;
  return new Date(
    Math.min(deadline, now + environmentRetryDelaySeconds(attempt) * 1000),
  ).toISOString();
}

export class EnvironmentProvisioner {
  private readonly provider: EnvironmentInfrastructureProvider;
  private readonly repository: EnvironmentProvisioningRepository;
  private readonly runtimeImage: string;
  private readonly routerImage: string;
  private readonly ticketPublicKey: string;
  private readonly controlPlaneUrl: string;
  private readonly backupWorkspace: (input: {
    organizationId: string;
    environmentId: string;
    workspaceId: string;
    actorUserId: string;
    reason: "pre_destructive";
    idempotencyKey: string;
    parentLifecycleOperationId?: string | undefined;
    preDestructiveSnapshot?: { id: string; state: string } | undefined;
  }) => Promise<unknown>;

  constructor(input: {
    repository: EnvironmentProvisioningRepository;
    provider: EnvironmentInfrastructureProvider;
    runtimeImage: string;
    routerImage: string;
    requireRuntimeImages?: boolean | undefined;
    ticketPublicKey: string;
    controlPlaneUrl: string;
    backupWorkspace?:
      | ((input: {
          organizationId: string;
          environmentId: string;
          workspaceId: string;
          actorUserId: string;
          reason: "pre_destructive";
          idempotencyKey: string;
          parentLifecycleOperationId?: string | undefined;
          preDestructiveSnapshot?: { id: string; state: string } | undefined;
        }) => Promise<unknown>)
      | undefined;
  }) {
    const {
      repository,
      provider,
      runtimeImage,
      routerImage,
      ticketPublicKey,
      controlPlaneUrl,
      backupWorkspace,
      requireRuntimeImages = true,
    } = input;
    if (requireRuntimeImages && !runtimeImage.trim()) {
      throw new Error("Workspace runtime image is not configured.");
    }
    if (requireRuntimeImages && !routerImage.trim()) {
      throw new Error("Environment router image is not configured.");
    }
    if (!ticketPublicKey.includes("BEGIN PUBLIC KEY")) {
      throw new Error("Environment ticket public key is not configured.");
    }
    if (!/^https?:\/\//u.test(controlPlaneUrl)) {
      throw new Error("Kestrel One control plane URL is not configured.");
    }
    this.repository = repository;
    this.provider = provider;
    this.runtimeImage = runtimeImage;
    this.routerImage = routerImage;
    this.ticketPublicKey = ticketPublicKey;
    this.controlPlaneUrl = controlPlaneUrl;
    this.backupWorkspace =
      backupWorkspace ??
      (async (backupInput) => {
        const { createWorkspaceBackup } = await import("./backups");
        return createWorkspaceBackup(backupInput);
      });
  }

  async process(
    operationId: string,
  ): Promise<"processed" | "not_claimed" | "deferred"> {
    const operation = await this.repository.claimOperation(operationId);
    if (!operation) return "not_claimed";
    try {
      if (operation.type === "environment.provision") {
        await this.provisionEnvironment(operation);
      } else if (operation.type === "environment.update") {
        await this.updateEnvironment(operation);
      } else if (operation.type === "workspace.provision") {
        await this.provisionWorkspace(operation);
      } else if (operation.type === "workspace.start") {
        await this.startWorkspace(operation);
      } else if (operation.type === "workspace.stop") {
        await this.stopWorkspace(operation);
      } else if (operation.type === "workspace.rebuild") {
        await this.rebuildWorkspace(operation);
      } else if (operation.type === "workspace.delete") {
        await this.deleteWorkspace(operation);
      } else if (operation.type === "environment.delete") {
        await this.deleteEnvironment(operation);
      } else {
        throw operationError(
          "ENVIRONMENT_OPERATION_UNSUPPORTED",
          `Operation '${operation.type}' is not handled by the provisioner.`,
        );
      }
      return "processed";
    } catch (error) {
      const environmentPersistenceFailure =
        operation.type === "environment.provision" &&
        error instanceof EnvironmentProvisioningPersistenceError;
      const controlPlaneFailure =
        environmentPersistenceFailure ||
        (!(error instanceof EnvironmentProviderError) &&
          classifyDbError(error).retryable);
      const failure = controlPlaneFailure
        ? {
            code: "ENVIRONMENT_CONTROL_PLANE_RETRYING",
            message:
              error instanceof EnvironmentProvisioningPersistenceError
                ? error.message
                : "Kestrel could not persist Environment operation state. Retrying.",
            retryable: true,
          }
        : safeFailure(error);
      const providerEvidence = readProviderFailureEvidence(error);
      if (failure.retryable) {
        const previousRetry = asRecord(operation.result)?.retryState;
        const firstFailureAt =
          readInputString(asRecord(previousRetry), "firstFailureAt") ??
          new Date().toISOString();
        const retryAttempt = Number(asRecord(previousRetry)?.attempt ?? 0) + 1;
        const nextAttemptAt = environmentRetryNextAttemptAt(
          firstFailureAt,
          retryAttempt,
        );
        if (!nextAttemptAt) {
          await this.terminalizeRetryExhaustion({
            operation,
            code: controlPlaneFailure
              ? "ENVIRONMENT_CONTROL_PLANE_RETRY_EXHAUSTED"
              : "ENVIRONMENT_PROVIDER_RETRY_EXHAUSTED",
            message: controlPlaneFailure
              ? `Automatic control-plane retries were exhausted after one hour. Last failure: ${failure.message}`
              : `Automatic provider retries were exhausted after one hour. Last response: ${failure.message}`,
          });
          return "processed";
        }
        await this.repository.deferOperation({
          operationId: operation.id,
          attempt: operation.attempt,
          stage: controlPlaneFailure
            ? "environment.activation.reconciling"
            : providerEvidence?.phase
              ? `${providerEvidence.phase}.failed`
              : "environment.provider.retrying",
          code: failure.code,
          message: failure.message,
          providerRequestId: providerEvidence?.requestId,
          providerFailure: providerEvidence,
          retryState: {
            attempt: retryAttempt,
            firstFailureAt,
            lastError: { code: failure.code, message: failure.message },
            nextAttemptAt,
            authoritativeState: readAuthoritativeState(error),
          },
        });
        return "deferred";
      }
      if (
        failure.code === "ENVIRONMENT_IS_DEFAULT" ||
        failure.code === "ENVIRONMENT_HAS_PROJECTS" ||
        failure.code === "ENVIRONMENT_HAS_PRIVATE_INFERENCE"
      ) {
        await this.repository.failOperation({
          operationId: operation.id,
          stage: "environment.deletion.blocked",
          ...failure,
        });
        return "processed";
      }
      if (operation.type === "environment.provision") {
        await this.repository.failEnvironmentProvision({
          environmentId: operation.environmentId,
          operationId: operation.id,
          attempt: operation.attempt,
          stage: providerEvidence?.phase
            ? `${providerEvidence.phase}.failed`
            : undefined,
          providerRequestId: providerEvidence?.requestId,
          result: providerEvidence
            ? { providerFailure: providerEvidence }
            : undefined,
          ...failure,
        });
        return "processed";
      }
      if (operation.workspaceId) {
        if (operation.type === "workspace.start") {
          await this.repository.degradeWorkspace({
            workspaceId: operation.workspaceId,
            ...failure,
          });
        } else {
          await this.repository.failWorkspace({
            workspaceId: operation.workspaceId,
            ...failure,
          });
        }
      } else if (operation.type === "environment.update") {
        await this.repository.degradeEnvironment({
          environmentId: operation.environmentId,
          ...failure,
        });
      } else {
        await this.repository.failEnvironment({
          environmentId: operation.environmentId,
          ...failure,
        });
      }
      await this.repository.failOperation({
        operationId: operation.id,
        stage: providerEvidence?.phase
          ? `${providerEvidence.phase}.failed`
          : "environment.activation.failed",
        providerRequestId: providerEvidence?.requestId,
        result: providerEvidence
          ? { providerFailure: providerEvidence }
          : undefined,
        ...failure,
      });
      return "processed";
    }
  }

  private async terminalizeRetryExhaustion(input: {
    operation: ProvisioningOperation;
    code:
      | "ENVIRONMENT_PROVIDER_RETRY_EXHAUSTED"
      | "ENVIRONMENT_CONTROL_PLANE_RETRY_EXHAUSTED";
    message: string;
  }) {
    const { operation, code, message } = input;
    if (operation.type === "environment.provision") {
      await this.repository.failEnvironmentProvision({
        environmentId: operation.environmentId,
        operationId: operation.id,
        attempt: operation.attempt,
        code,
        message,
      });
      return;
    }
    if (operation.workspaceId) {
      await this.repository.failWorkspace({
        workspaceId: operation.workspaceId,
        code,
        message,
      });
    } else if (operation.type === "environment.update") {
      await this.repository.degradeEnvironment({
        environmentId: operation.environmentId,
        code,
        message,
      });
    } else {
      await this.repository.failEnvironment({
        environmentId: operation.environmentId,
        code,
        message,
      });
    }
    await this.repository.failOperation({
      operationId: operation.id,
      stage:
        code === "ENVIRONMENT_CONTROL_PLANE_RETRY_EXHAUSTED"
          ? "environment.control_plane.retry_exhausted"
          : "environment.provider.retry_exhausted",
      code,
      message,
    });
  }

  private async provisionEnvironment(operation: ProvisioningOperation) {
    const begin = await this.persistEnvironmentProvisioning(() =>
      this.repository.beginEnvironmentProvisioning({
        environmentId: operation.environmentId,
        operationId: operation.id,
        attempt: operation.attempt,
      }),
    );
    if (begin === "superseded") return;
    const environment = await this.persistEnvironmentProvisioning(() =>
      this.repository.getEnvironment(operation.environmentId),
    );
    if (
      !environment ||
      environment.organizationId !== operation.organizationId
    ) {
      throw operationError(
        "ENVIRONMENT_NOT_FOUND",
        "Environment provisioning target is unavailable.",
      );
    }
    assertEnvironmentOperationTransition(
      environmentStatusSchema.parse(environment.status),
      "provisioning",
    );
    const appName =
      environment.flyAppName ?? flyEnvironmentAppName(environment.id);
    const networkName = flyEnvironmentNetworkName(environment.id);
    await this.persistEnvironmentProvisioning(() =>
      this.repository.updateOperationStage({
        operationId: operation.id,
        attempt: operation.attempt,
        stage: "environment.runtime.connecting",
      }),
    );
    await this.provider.ensureEnvironmentApp({ appName, networkName });
    const appStaged = await this.persistEnvironmentProvisioning(() =>
      this.repository.stageEnvironmentAppIdentity({
        environmentId: environment.id,
        operationId: operation.id,
        attempt: operation.attempt,
        appName,
        networkName,
      }),
    );
    if (appStaged === "superseded") return;
    await this.persistEnvironmentProvisioning(() =>
      this.repository.updateOperationStage({
        operationId: operation.id,
        attempt: operation.attempt,
        stage: "environment.machine.starting",
      }),
    );
    const gatewayServiceToken = createEnvironmentServiceToken();
    const gateway = await this.provider.ensureEnvironmentGateway({
      appName,
      environmentId: environment.id,
      region: environment.region,
      runtimeImage: this.routerImage,
      ticketPublicKey: this.ticketPublicKey,
      controlPlaneUrl: this.controlPlaneUrl,
      serviceToken: gatewayServiceToken,
    });
    const staged = await this.persistEnvironmentProvisioning(() =>
      this.repository.stageEnvironmentGatewayIdentity({
        environmentId: environment.id,
        operationId: operation.id,
        attempt: operation.attempt,
        appName,
        gatewayServiceTokenHash: hashEnvironmentServiceToken(
          gateway.serviceToken,
        ),
      }),
    );
    if (staged === "superseded") return;
    if (gateway.state !== "started") {
      await this.provider.waitForMachine({
        appName,
        machineId: gateway.machineId,
        state: "started",
        timeoutSeconds: 60,
      });
    }
    await this.persistEnvironmentProvisioning(() =>
      this.repository.updateOperationStage({
        operationId: operation.id,
        attempt: operation.attempt,
        stage: "environment.health.checking",
      }),
    );
    await this.provider.waitForMachineHealth({
      appName,
      machineId: gateway.machineId,
      checkName: "gateway",
      timeoutSeconds: 60,
    });
    await this.persistEnvironmentProvisioning(() =>
      this.repository.completeEnvironmentProvision({
        environmentId: environment.id,
        operationId: operation.id,
        attempt: operation.attempt,
        appName,
        networkName,
        gatewayMachineId: gateway.machineId,
        routerUrl: gateway.routerUrl,
        routerImage: this.routerImage,
        runtimeImage: this.runtimeImage,
        gatewayServiceTokenHash: hashEnvironmentServiceToken(
          gateway.serviceToken,
        ),
      }),
    );
  }

  private async persistEnvironmentProvisioning<T>(
    persist: () => Promise<T>,
  ): Promise<T> {
    try {
      return await persist();
    } catch (error) {
      throw new EnvironmentProvisioningPersistenceError(error);
    }
  }

  private async updateEnvironment(operation: ProvisioningOperation) {
    const environment = await this.repository.getEnvironment(
      operation.environmentId,
    );
    if (
      !environment ||
      environment.organizationId !== operation.organizationId ||
      !environment.flyAppName ||
      !environment.flyGatewayMachineId ||
      !["ready", "degraded"].includes(environment.status)
    ) {
      throw operationError(
        "ENVIRONMENT_NOT_READY",
        "Environment update target is unavailable.",
      );
    }
    const runtimeImage = readImmutableImage(
      operation.input?.runtimeImage,
      "Workspace runtime image",
      "workspace-runtime",
    );
    const routerImage = readImmutableImage(
      operation.input?.routerImage,
      "Environment router image",
      "environment-router",
    );
    const workspaceDataMigrationRevision = readInputString(
      operation.input,
      "workspaceDataMigrationRevision",
    );
    const skipWorkspaceBackups =
      operation.input?.skipWorkspaceBackups === true ||
      !workspaceDataMigrationRevision;
    const automaticRollback = operation.input?.automaticRollback !== false;
    if (!skipWorkspaceBackups && !operation.requestedByUserId) {
      throw operationError(
        "ENVIRONMENT_UPDATE_ACTOR_REQUIRED",
        "Environment updates that create backups require an audit actor.",
      );
    }
    const workspaces = await this.repository.listEnvironmentWorkspaces(
      environment.id,
    );
    const checkpoint = readEnvironmentUpdateCheckpoint(operation.result);
    const persistCheckpoint = async (stage: string) => {
      await this.repository.updateOperationStage({
        operationId: operation.id,
        stage,
        result: {
          ...asRecord(operation.result),
          environmentUpdateCheckpoint: checkpoint,
        },
      });
    };
    if (!checkpoint.workspaceStateSnapshotCaptured) {
      checkpoint.initiallyStoppedWorkspaceIds = workspaces
        .filter((workspace) => workspace.status === "stopped")
        .map((workspace) => workspace.id);
      checkpoint.workspaceStateSnapshotCaptured = true;
      await persistCheckpoint("environment.update.state_snapshot");
    }
    const initiallyStoppedWorkspaceIds = new Set(
      checkpoint.initiallyStoppedWorkspaceIds,
    );
    if (!checkpoint.gatewayVerified) {
      await persistCheckpoint("environment.update.gateway");
      try {
        const gateway = await this.provider.updateMachineImage({
          appName: environment.flyAppName,
          machineId: environment.flyGatewayMachineId,
          runtimeImage: routerImage,
          envPatch: {
            KESTREL_CONTROL_PLANE_URL: this.controlPlaneUrl,
          },
        });
        if (gateway.state === "stopped") {
          await this.provider.startMachine({
            appName: environment.flyAppName,
            machineId: environment.flyGatewayMachineId,
          });
        }
        if (gateway.state !== "started") {
          await this.provider.waitForMachine({
            appName: environment.flyAppName,
            machineId: environment.flyGatewayMachineId,
            state: "started",
            timeoutSeconds: 90,
          });
        }
        await this.provider.waitForMachineHealth({
          appName: environment.flyAppName,
          machineId: environment.flyGatewayMachineId,
          checkName: "gateway",
          timeoutSeconds: 90,
        });
      } catch (error) {
        const classifiedError = await classifyEnvironmentGatewayHealthFailure({
          error,
          routerUrl: environment.routerUrl ?? null,
        });
        if (
          automaticRollback &&
          environment.routerImage &&
          environment.routerImage !== routerImage
        ) {
          await this.provider
            .updateMachineImage({
              appName: environment.flyAppName,
              machineId: environment.flyGatewayMachineId,
              runtimeImage: environment.routerImage,
            })
            .then(async (gateway) => {
              if (gateway.state === "stopped") {
                await this.provider.startMachine({
                  appName: environment.flyAppName!,
                  machineId: environment.flyGatewayMachineId!,
                });
              }
              if (gateway.state !== "started") {
                await this.provider.waitForMachine({
                  appName: environment.flyAppName!,
                  machineId: environment.flyGatewayMachineId!,
                  state: "started",
                  timeoutSeconds: 90,
                });
              }
              await this.provider.waitForMachineHealth({
                appName: environment.flyAppName!,
                machineId: environment.flyGatewayMachineId!,
                checkName: "gateway",
                timeoutSeconds: 90,
              });
            })
            .catch(() => {});
        }
        throw classifiedError;
      }
      await this.repository.completeEnvironmentGatewayUpdate({
        environmentId: environment.id,
        routerImage,
      });
      checkpoint.gatewayVerified = true;
      await persistCheckpoint("environment.update.gateway_verified");
    }
    const alreadyUpdatedWorkspaceIds = new Set(checkpoint.verifiedWorkspaceIds);
    if (skipWorkspaceBackups) {
      await persistCheckpoint("environment.update.backups_skipped");
    } else {
      await persistCheckpoint("environment.update.backing_up");
      for (const workspace of workspaces) {
        if (!(workspace.flyMachineId && workspace.flyVolumeId)) continue;
        if (checkpoint.backedUpWorkspaceIds.includes(workspace.id)) continue;
        const backupInput = {
          organizationId: operation.organizationId,
          environmentId: environment.id,
          workspaceId: workspace.id,
          actorUserId: operation.requestedByUserId!,
          reason: "pre_destructive",
          idempotencyKey:
            `environment.update:${operation.id}:backup:` +
            `${workspaceDataMigrationRevision}:${workspace.id}`,
          parentLifecycleOperationId: operation.id,
        } as const;
        if (workspace.status === "failed") {
          const preDestructiveSnapshot =
            await this.createPreDestructiveSnapshot({
              appName: environment.flyAppName,
              volumeId: workspace.flyVolumeId,
            });
          await this.updateWorkspaceRuntime({
            appName: environment.flyAppName,
            workspaceId: workspace.id,
            machineId: workspace.flyMachineId,
            runtimeImage,
            restoreStopped: initiallyStoppedWorkspaceIds.has(workspace.id),
          });
          await this.backupWorkspace({
            ...backupInput,
            preDestructiveSnapshot,
          });
          alreadyUpdatedWorkspaceIds.add(workspace.id);
          checkpoint.verifiedWorkspaceIds = [
            ...new Set([...checkpoint.verifiedWorkspaceIds, workspace.id]),
          ];
          if (initiallyStoppedWorkspaceIds.has(workspace.id)) {
            checkpoint.restoredStoppedWorkspaceIds = [
              ...new Set([
                ...checkpoint.restoredStoppedWorkspaceIds,
                workspace.id,
              ]),
            ];
          }
          checkpoint.backedUpWorkspaceIds = [
            ...new Set([...checkpoint.backedUpWorkspaceIds, workspace.id]),
          ];
          await persistCheckpoint("environment.update.backing_up");
          continue;
        }
        try {
          await this.backupWorkspace(backupInput);
        } catch (error) {
          if (!hasErrorCode(error, "ENVIRONMENT_ACTIVATION_TIMEOUT")) {
            throw error;
          }
          const preDestructiveSnapshot =
            await this.createPreDestructiveSnapshot({
              appName: environment.flyAppName,
              volumeId: workspace.flyVolumeId,
            });
          await this.updateWorkspaceRuntime({
            appName: environment.flyAppName,
            workspaceId: workspace.id,
            machineId: workspace.flyMachineId,
            runtimeImage,
            restoreStopped: initiallyStoppedWorkspaceIds.has(workspace.id),
          });
          await this.backupWorkspace({
            ...backupInput,
            preDestructiveSnapshot,
          });
          alreadyUpdatedWorkspaceIds.add(workspace.id);
        }
        checkpoint.backedUpWorkspaceIds = [
          ...new Set([...checkpoint.backedUpWorkspaceIds, workspace.id]),
        ];
        if (alreadyUpdatedWorkspaceIds.has(workspace.id)) {
          checkpoint.verifiedWorkspaceIds = [
            ...new Set([...checkpoint.verifiedWorkspaceIds, workspace.id]),
          ];
          if (initiallyStoppedWorkspaceIds.has(workspace.id)) {
            checkpoint.restoredStoppedWorkspaceIds = [
              ...new Set([
                ...checkpoint.restoredStoppedWorkspaceIds,
                workspace.id,
              ]),
            ];
          }
        }
        await persistCheckpoint("environment.update.backing_up");
      }
    }
    await persistCheckpoint("environment.update.workspaces");
    const skippedWorkspaceIds: string[] = [];
    let updatedWorkspaceCount = 0;
    for (const workspace of workspaces) {
      if (alreadyUpdatedWorkspaceIds.has(workspace.id)) {
        updatedWorkspaceCount += 1;
        continue;
      }
      if (!workspace.flyMachineId) {
        skippedWorkspaceIds.push(workspace.id);
        continue;
      }
      await this.updateWorkspaceRuntime({
        appName: environment.flyAppName,
        workspaceId: workspace.id,
        machineId: workspace.flyMachineId,
        runtimeImage,
        restoreStopped: initiallyStoppedWorkspaceIds.has(workspace.id),
      });
      checkpoint.verifiedWorkspaceIds = [
        ...new Set([...checkpoint.verifiedWorkspaceIds, workspace.id]),
      ];
      if (initiallyStoppedWorkspaceIds.has(workspace.id)) {
        checkpoint.restoredStoppedWorkspaceIds = [
          ...new Set([
            ...checkpoint.restoredStoppedWorkspaceIds,
            workspace.id,
          ]),
        ];
      }
      updatedWorkspaceCount += 1;
      await persistCheckpoint("environment.update.workspaces");
    }
    await persistCheckpoint("environment.update.verifying");
    await this.repository.completeEnvironmentRuntimeUpdate({
      environmentId: environment.id,
      runtimeImage,
    });
    await this.repository.completeOperation({
      operationId: operation.id,
      stage:
        skippedWorkspaceIds.length > 0
          ? "environment.update.recovery_required"
          : "environment.update.ready",
      result: {
        gatewayMachineId: environment.flyGatewayMachineId,
        routerImage,
        runtimeImage,
        workspaceCount: workspaces.length,
        updatedWorkspaceCount,
        skippedWorkspaceIds,
        ...(checkpoint.restoredStoppedWorkspaceIds.length > 0
          ? {
              restoredStoppedWorkspaceIds:
                checkpoint.restoredStoppedWorkspaceIds,
            }
          : {}),
        ...(skipWorkspaceBackups ? { workspaceBackupsSkipped: true } : {}),
        environmentUpdateCheckpoint: checkpoint,
      },
    });
  }

  private async configureStoppedWorkspaceRuntime(input: {
    appName: string;
    workspaceId: string;
    machineId: string;
    runtimeImage: string;
  }) {
    if (!this.repository.configureStoppedWorkspace) {
      throw operationError(
        "ENVIRONMENT_UNAVAILABLE",
        "Stopped Workspace image persistence is unavailable.",
      );
    }
    const machine = await this.provider.updateMachineImage({
      appName: input.appName,
      machineId: input.machineId,
      runtimeImage: input.runtimeImage,
      envPatch: {
        KESTREL_CONTROL_PLANE_URL: this.controlPlaneUrl,
        KESTREL_ONE_APP_URL: this.controlPlaneUrl,
      },
      stopConfig: KESTREL_WORKSPACE_STOP_CONFIG,
    });
    if (machine.state !== "stopped") {
      await this.provider.waitForMachine({
        appName: input.appName,
        machineId: input.machineId,
        state: "stopped",
        timeoutSeconds: 90,
      });
    }
    await this.repository.configureStoppedWorkspace({
      workspaceId: input.workspaceId,
      runtimeImage: input.runtimeImage,
    });
  }

  private async createPreDestructiveSnapshot(input: {
    appName: string;
    volumeId: string;
  }) {
    const snapshot = await createAuxiliaryVolumeSnapshot({
      ...input,
      createSnapshot: (snapshotInput) =>
        this.provider.createVolumeSnapshot(snapshotInput),
    });
    return snapshot.id ? { id: snapshot.id, state: snapshot.state } : undefined;
  }

  private async updateWorkspaceRuntime(input: {
    appName: string;
    workspaceId: string;
    machineId: string;
    runtimeImage: string;
    restoreStopped?: boolean | undefined;
  }) {
    await this.repository.setWorkspaceStarting(input.workspaceId);
    try {
      const machine = await this.provider.updateMachineImage({
        appName: input.appName,
        machineId: input.machineId,
        runtimeImage: input.runtimeImage,
        envPatch: {
          KESTREL_CONTROL_PLANE_URL: this.controlPlaneUrl,
          KESTREL_ONE_APP_URL: this.controlPlaneUrl,
        },
        stopConfig: KESTREL_WORKSPACE_STOP_CONFIG,
      });
      const startedExplicitly =
        machine.state === "stopped" ||
        (input.restoreStopped && machine.state !== "started");
      if (startedExplicitly) {
        await this.provider.startMachine({
          appName: input.appName,
          machineId: input.machineId,
        });
      }
      if (machine.state !== "started" && !startedExplicitly) {
        await this.provider.waitForMachine({
          appName: input.appName,
          machineId: input.machineId,
          state: "started",
          timeoutSeconds: WORKSPACE_MACHINE_HEALTH_TIMEOUT_SECONDS,
        });
      }
      // A successful Workspace health check is the authoritative readiness proof
      // after an explicit start. Fly's state wait can observe a stale stopped
      // snapshot during the same start/stop verification cycle.
      await this.provider.waitForMachineHealth({
        appName: input.appName,
        machineId: input.machineId,
        checkName: "workspace",
        timeoutSeconds: WORKSPACE_MACHINE_HEALTH_TIMEOUT_SECONDS,
      });
      if (input.restoreStopped) {
        await this.repository.setWorkspaceStopping(input.workspaceId);
        await this.provider.stopMachine({
          appName: input.appName,
          machineId: input.machineId,
        });
        await this.provider.waitForMachine({
          appName: input.appName,
          machineId: input.machineId,
          state: "stopped",
          timeoutSeconds: 60,
        });
        await this.repository.completeStoppedWorkspaceRebuild({
          workspaceId: input.workspaceId,
          runtimeImage: input.runtimeImage,
        });
      } else {
        await this.repository.completeWorkspaceRebuild({
          workspaceId: input.workspaceId,
          runtimeImage: input.runtimeImage,
        });
      }
    } catch (error) {
      if (input.restoreStopped) {
        await this.provider
          .stopMachine({
            appName: input.appName,
            machineId: input.machineId,
          })
          .then(() =>
            this.provider.waitForMachine({
              appName: input.appName,
              machineId: input.machineId,
              state: "stopped",
              timeoutSeconds: 60,
            }),
          )
          .catch(() => undefined);
      }
      const failure = safeFailure(error);
      if (!failure.retryable) {
        await this.repository.failWorkspace({
          workspaceId: input.workspaceId,
          code: failure.code,
          message: failure.message,
        });
      }
      throw error;
    }
  }

  private async provisionWorkspace(operation: ProvisioningOperation) {
    if (!operation.workspaceId) {
      throw operationError(
        "WORKSPACE_NOT_FOUND",
        "Workspace provisioning operation has no Workspace.",
      );
    }
    const [environment, workspace] = await Promise.all([
      this.repository.getEnvironment(operation.environmentId),
      this.repository.getWorkspace(operation.workspaceId),
    ]);
    if (
      !(environment && workspace) ||
      environment.organizationId !== operation.organizationId ||
      workspace.organizationId !== operation.organizationId ||
      workspace.environmentId !== environment.id
    ) {
      throw operationError(
        "WORKSPACE_NOT_FOUND",
        "Workspace provisioning target is unavailable.",
      );
    }
    if (environment.status !== "ready" || !environment.flyAppName) {
      throw operationError(
        "ENVIRONMENT_DEPENDENCY_UNAVAILABLE",
        "The parent Environment is unavailable for Workspace provisioning.",
      );
    }
    assertWorkspaceOperationTransition(
      workspaceStatusSchema.parse(workspace.status),
      "provisioning",
    );
    await this.repository.setWorkspaceProvisioning(workspace.id);
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.workspace.mounting",
    });
    let volumeId: string | undefined;
    let machineId: string | undefined;
    try {
      const volume = await this.provider.ensureWorkspaceVolume({
        appName: environment.flyAppName,
        workspaceId: workspace.id,
        region: environment.region,
      });
      volumeId = volume.id;
      await this.repository.updateOperationStage({
        operationId: operation.id,
        stage: "environment.machine.starting",
        result: { provisionalVolumeId: volume.id },
      });
      const workspaceServiceToken = createEnvironmentServiceToken();
      const machine = await this.provider.ensureWorkspaceMachine({
        appName: environment.flyAppName,
        environmentId: environment.id,
        organizationId: operation.organizationId,
        workspaceId: workspace.id,
        volumeId: volume.id,
        region: environment.region,
        runtimeImage: environment.runtimeImage ?? this.runtimeImage,
        ticketPublicKey: this.ticketPublicKey,
        controlPlaneUrl: this.controlPlaneUrl,
        serviceToken: workspaceServiceToken,
        source: {
          type: workspace.sourceType,
          ...(workspace.sourceResourceId
            ? { resourceId: workspace.sourceResourceId }
            : {}),
          ...(workspace.sourceRepository
            ? { repository: workspace.sourceRepository }
            : {}),
          ...(workspace.sourceDefaultBranch
            ? { defaultBranch: workspace.sourceDefaultBranch }
            : {}),
        },
        idleTimeoutMinutes:
          environment.idleTimeoutMinutes || ENVIRONMENT_IDLE_TIMEOUT_MINUTES,
      });
      machineId = machine.id;
      await this.repository.updateOperationStage({
        operationId: operation.id,
        stage: "environment.machine.starting",
        result: {
          provisionalVolumeId: volume.id,
          provisionalMachineId: machine.id,
        },
      });
      if (machine.state !== "started") {
        await this.provider.waitForMachine({
          appName: environment.flyAppName,
          machineId: machine.id,
          state: "started",
          timeoutSeconds: WORKSPACE_MACHINE_HEALTH_TIMEOUT_SECONDS,
        });
      }
      await this.repository.updateOperationStage({
        operationId: operation.id,
        stage: "environment.health.checking",
        result: {
          provisionalVolumeId: volume.id,
          provisionalMachineId: machine.id,
        },
      });
      await this.provider.waitForMachineHealth({
        appName: environment.flyAppName,
        machineId: machine.id,
        checkName: "workspace",
        timeoutSeconds: WORKSPACE_MACHINE_HEALTH_TIMEOUT_SECONDS,
      });
      await this.repository.completeWorkspace({
        workspaceId: workspace.id,
        volumeId: volume.id,
        machineId: machine.id,
        runtimeImage: environment.runtimeImage ?? this.runtimeImage,
        serviceTokenHash: hashEnvironmentServiceToken(workspaceServiceToken),
      });
      await this.repository.completeOperation({
        operationId: operation.id,
        stage: "environment.activation.ready",
        result: {
          volumeId: volume.id,
          machineId: machine.id,
          runtimeContractRevision: 2,
        },
      });
    } catch (error) {
      await cleanupFailedWorkspaceProvisioning({
        provider: this.provider,
        appName: environment.flyAppName,
        operationId: operation.id,
        machineId,
        volumeId,
      });
      throw error;
    }
  }

  private async startWorkspace(operation: ProvisioningOperation) {
    if (!operation.workspaceId) {
      throw operationError(
        "WORKSPACE_NOT_FOUND",
        "Workspace start target is unavailable.",
      );
    }
    const [environment, workspace] = await Promise.all([
      this.repository.getEnvironment(operation.environmentId),
      this.repository.getWorkspace(operation.workspaceId),
    ]);
    if (
      !environment?.flyAppName ||
      environment.organizationId !== operation.organizationId ||
      !workspace?.flyMachineId ||
      workspace.organizationId !== operation.organizationId ||
      workspace.environmentId !== environment.id
    ) {
      throw operationError(
        "WORKSPACE_NOT_FOUND",
        "Workspace start target is unavailable.",
      );
    }
    assertWorkspaceOperationTransition(
      workspaceStatusSchema.parse(workspace.status),
      "starting",
    );
    const desiredRuntimeImage = environment.runtimeImage ?? this.runtimeImage;
    if (workspace.runtimeImage !== desiredRuntimeImage) {
      await this.configureStoppedWorkspaceRuntime({
        appName: environment.flyAppName,
        workspaceId: workspace.id,
        machineId: workspace.flyMachineId,
        runtimeImage: desiredRuntimeImage,
      });
    }
    await this.repository.setWorkspaceStarting(workspace.id);
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.machine.starting",
    });
    await this.provider.startMachine({
      appName: environment.flyAppName,
      machineId: workspace.flyMachineId,
    });
    await this.provider.waitForMachine({
      appName: environment.flyAppName,
      machineId: workspace.flyMachineId,
      state: "started",
      timeoutSeconds: WORKSPACE_MACHINE_HEALTH_TIMEOUT_SECONDS,
    });
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.health.checking",
    });
    await this.provider.waitForMachineHealth({
      appName: environment.flyAppName,
      machineId: workspace.flyMachineId,
      checkName: "workspace",
      timeoutSeconds: WORKSPACE_MACHINE_HEALTH_TIMEOUT_SECONDS,
    });
    await this.repository.completeWorkspaceStart(workspace.id);
    await this.repository.completeOperation({
      operationId: operation.id,
      stage: "environment.activation.ready",
      result: { machineId: workspace.flyMachineId },
    });
  }

  private async stopWorkspace(operation: ProvisioningOperation) {
    if (!operation.workspaceId) {
      throw operationError(
        "WORKSPACE_NOT_FOUND",
        "Workspace stop target is unavailable.",
      );
    }
    const [environment, workspace] = await Promise.all([
      this.repository.getEnvironment(operation.environmentId),
      this.repository.getWorkspace(operation.workspaceId),
    ]);
    if (
      !environment?.flyAppName ||
      environment.organizationId !== operation.organizationId ||
      !workspace?.flyMachineId ||
      workspace.organizationId !== operation.organizationId ||
      workspace.environmentId !== environment.id
    ) {
      throw operationError(
        "WORKSPACE_NOT_FOUND",
        "Workspace stop target is unavailable.",
      );
    }
    const workspaceStatus = workspaceStatusSchema.parse(workspace.status);
    if (workspaceStatus !== "stopping") {
      assertWorkspaceOperationTransition(workspaceStatus, "stopping");
      await this.repository.setWorkspaceStopping(workspace.id);
    }
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.machine.stopping",
    });
    await this.provider.stopMachine({
      appName: environment.flyAppName,
      machineId: workspace.flyMachineId,
    });
    await this.provider.waitForMachine({
      appName: environment.flyAppName,
      machineId: workspace.flyMachineId,
      state: "stopped",
      timeoutSeconds: 60,
    });
    await this.repository.completeWorkspaceStop(workspace.id);
    await this.repository.completeOperation({
      operationId: operation.id,
      stage: "environment.machine.stopped",
      result: { machineId: workspace.flyMachineId },
    });
  }

  private async deleteWorkspace(operation: ProvisioningOperation) {
    if (!operation.workspaceId) {
      throw operationError(
        "WORKSPACE_NOT_FOUND",
        "Workspace deletion target is unavailable.",
      );
    }
    const [environment, workspace] = await Promise.all([
      this.repository.getEnvironment(operation.environmentId),
      this.repository.getWorkspace(operation.workspaceId),
    ]);
    if (
      !environment?.flyAppName ||
      environment.organizationId !== operation.organizationId ||
      !workspace ||
      workspace.organizationId !== operation.organizationId ||
      workspace.environmentId !== environment.id
    ) {
      throw operationError(
        "WORKSPACE_NOT_FOUND",
        "Workspace deletion target is unavailable.",
      );
    }
    assertWorkspaceOperationTransition(
      workspaceStatusSchema.parse(workspace.status),
      "deleting",
    );
    await this.repository.setWorkspaceDeleting(workspace.id);
    if (workspace.flyMachineId) {
      await this.provider.deleteMachine({
        appName: environment.flyAppName,
        machineId: workspace.flyMachineId,
      });
    }
    if (workspace.flyVolumeId) {
      await this.provider.deleteVolume({
        appName: environment.flyAppName,
        volumeId: workspace.flyVolumeId,
      });
    }
    await this.repository.completeWorkspaceDelete(workspace.id);
    await this.repository.completeOperation({
      operationId: operation.id,
      stage: "workspace.deleted",
      result: {
        machineId: workspace.flyMachineId,
        volumeId: workspace.flyVolumeId,
      },
    });
  }

  private async deleteEnvironment(operation: ProvisioningOperation) {
    const environment = await this.repository.getEnvironment(
      operation.environmentId,
    );
    if (
      !environment ||
      environment.organizationId !== operation.organizationId
    ) {
      throw operationError(
        "ENVIRONMENT_NOT_FOUND",
        "Environment deletion target is unavailable.",
      );
    }
    assertEnvironmentOperationTransition(
      environmentStatusSchema.parse(environment.status),
      "deleting",
    );
    await this.repository.setEnvironmentDeleting(environment.id, {
      organizationTeardown:
        typeof operation.input?.organizationDeletionOperationId === "string",
    });
    if (environment.flyAppName) {
      await this.provider.deleteEnvironmentApp({
        appName: environment.flyAppName,
      });
    }
    await this.repository.completeEnvironmentDelete(environment.id);
    await this.repository.completeOperation({
      operationId: operation.id,
      stage: "environment.deleted",
      result: { appName: environment.flyAppName },
    });
  }

  private async rebuildWorkspace(operation: ProvisioningOperation) {
    if (!operation.workspaceId) {
      throw operationError(
        "WORKSPACE_NOT_FOUND",
        "Workspace rebuild target is unavailable.",
      );
    }
    const [environment, workspace] = await Promise.all([
      this.repository.getEnvironment(operation.environmentId),
      this.repository.getWorkspace(operation.workspaceId),
    ]);
    if (
      !(environment?.flyAppName && environment.runtimeImage) ||
      environment.organizationId !== operation.organizationId ||
      !workspace?.flyMachineId ||
      workspace.organizationId !== operation.organizationId ||
      workspace.environmentId !== environment.id
    ) {
      throw operationError(
        "WORKSPACE_NOT_FOUND",
        "Workspace rebuild target is unavailable.",
      );
    }
    assertWorkspaceOperationTransition(
      workspaceStatusSchema.parse(workspace.status),
      "starting",
    );
    await this.repository.setWorkspaceStarting(workspace.id);
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.machine.starting",
    });
    const machine = await this.provider.updateMachineImage({
      appName: environment.flyAppName,
      machineId: workspace.flyMachineId,
      runtimeImage: environment.runtimeImage,
      stopConfig: KESTREL_WORKSPACE_STOP_CONFIG,
    });
    if (machine.state !== "started") {
      await this.provider.waitForMachine({
        appName: environment.flyAppName,
        machineId: workspace.flyMachineId,
        state: "started",
        timeoutSeconds: WORKSPACE_MACHINE_HEALTH_TIMEOUT_SECONDS,
      });
    }
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.health.checking",
    });
    await this.provider.waitForMachineHealth({
      appName: environment.flyAppName,
      machineId: workspace.flyMachineId,
      checkName: "workspace",
      timeoutSeconds: WORKSPACE_MACHINE_HEALTH_TIMEOUT_SECONDS,
    });
    await this.repository.completeWorkspaceRebuild({
      workspaceId: workspace.id,
      runtimeImage: environment.runtimeImage,
    });
    await this.repository.completeOperation({
      operationId: operation.id,
      stage: "environment.activation.ready",
      result: {
        machineId: workspace.flyMachineId,
        runtimeImage: environment.runtimeImage,
      },
    });
  }
}

export const databaseEnvironmentProvisioningRepository: EnvironmentProvisioningRepository =
  {
    async claimOperation(operationId) {
      const now = new Date();
      const [claimed] = await knowledgeDb
        .update(schema.environmentOperations)
        .set({
          status: "running",
          stage: "environment.activation.requested",
          attempt: sql`${schema.environmentOperations.attempt} + 1`,
          startedAt: now,
          updatedAt: now,
          errorCode: null,
          errorMessage: null,
        })
        .where(
          and(
            eq(schema.environmentOperations.id, operationId),
            inArray(schema.environmentOperations.status, ["queued", "running"]),
            inArray(
              schema.environmentOperations.type,
              PROVISIONER_OPERATION_TYPES,
            ),
          ),
        )
        .returning({
          id: schema.environmentOperations.id,
          attempt: schema.environmentOperations.attempt,
          organizationId: schema.environmentOperations.organizationId,
          environmentId: schema.environmentOperations.environmentId,
          workspaceId: schema.environmentOperations.workspaceId,
          requestedByUserId: schema.environmentOperations.requestedByUserId,
          type: schema.environmentOperations.type,
          input: schema.environmentOperations.input,
          result: schema.environmentOperations.result,
          createdAt: schema.environmentOperations.createdAt,
        });
      return claimed ?? null;
    },
    getEnvironment(environmentId) {
      return knowledgeDb.query.environments
        .findFirst({
          where: (table, { eq }) => eq(table.id, environmentId),
          columns: {
            id: true,
            organizationId: true,
            region: true,
            status: true,
            flyAppName: true,
            flyGatewayMachineId: true,
            routerUrl: true,
            routerImage: true,
            runtimeImage: true,
            idleTimeoutMinutes: true,
          },
        })
        .then((value) => value ?? null);
    },
    getWorkspace(workspaceId) {
      return knowledgeDb.query.environmentWorkspaces
        .findFirst({
          where: (table, { eq }) => eq(table.id, workspaceId),
          columns: {
            id: true,
            organizationId: true,
            environmentId: true,
            status: true,
            flyMachineId: true,
            flyVolumeId: true,
            runtimeImage: true,
            sourceType: true,
            sourceResourceId: true,
            sourceRepository: true,
            sourceDefaultBranch: true,
          },
        })
        .then((value) => {
          if (!value) return null;
          if (value?.sourceType === "desktop") {
            throw new Error(
              "Desktop workspaces are not provisioned by the Fly lifecycle worker.",
            );
          }
          return {
            id: value.id,
            organizationId: value.organizationId,
            environmentId: value.environmentId,
            status: value.status,
            flyMachineId: value.flyMachineId,
            flyVolumeId: value.flyVolumeId,
            runtimeImage: value.runtimeImage,
            sourceType: value.sourceType,
            sourceResourceId: value.sourceResourceId,
            sourceRepository: value.sourceRepository,
            sourceDefaultBranch: value.sourceDefaultBranch,
          };
        });
    },
    listEnvironmentWorkspaces(environmentId) {
      return knowledgeDb.query.environmentWorkspaces.findMany({
        where: (table, { and, eq, isNull }) =>
          and(eq(table.environmentId, environmentId), isNull(table.deletedAt)),
        columns: {
          id: true,
          status: true,
          flyMachineId: true,
          flyVolumeId: true,
          runtimeImage: true,
        },
      });
    },
    async beginEnvironmentProvisioning(input) {
      const now = new Date();
      return knowledgeDb.transaction(async (transaction) => {
        await transaction.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(input.environmentId)}, 0))`,
        );
        const [operation] = await transaction
          .update(schema.environmentOperations)
          .set({ updatedAt: now })
          .where(
            and(
              eq(schema.environmentOperations.id, input.operationId),
              eq(
                schema.environmentOperations.environmentId,
                input.environmentId,
              ),
              eq(schema.environmentOperations.status, "running"),
              eq(schema.environmentOperations.attempt, input.attempt),
            ),
          )
          .returning({ id: schema.environmentOperations.id });
        if (!operation) return "superseded" as const;
        const currentEnvironment =
          await transaction.query.environments.findFirst({
            where: (table, { eq }) => eq(table.id, input.environmentId),
            columns: { status: true },
          });
        if (
          !(
            currentEnvironment &&
            ["requested", "provisioning", "failed"].includes(
              currentEnvironment.status,
            )
          )
        ) {
          return "superseded" as const;
        }
        const [updatedEnvironment] = await transaction
          .update(schema.environments)
          .set({
            status: "provisioning",
            failureCode: null,
            failureMessage: null,
            updatedAt: now,
          })
          .where(eq(schema.environments.id, input.environmentId))
          .returning({ id: schema.environments.id });
        return updatedEnvironment
          ? ("prepared" as const)
          : ("superseded" as const);
      });
    },
    async stageEnvironmentGatewayIdentity(input) {
      const { attempt, operationId } = input;
      if (operationId === undefined || attempt === undefined) {
        await knowledgeDb
          .update(schema.environments)
          .set({
            flyAppName: input.appName,
            gatewayServiceTokenHash: input.gatewayServiceTokenHash,
            updatedAt: new Date(),
          })
          .where(eq(schema.environments.id, input.environmentId));
        return "staged" as const;
      }
      const now = new Date();
      return knowledgeDb.transaction(async (transaction) => {
        await transaction.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(input.environmentId)}, 0))`,
        );
        const [operation] = await transaction
          .update(schema.environmentOperations)
          .set({ updatedAt: now })
          .where(
            and(
              eq(schema.environmentOperations.id, operationId),
              eq(
                schema.environmentOperations.environmentId,
                input.environmentId,
              ),
              eq(schema.environmentOperations.status, "running"),
              eq(schema.environmentOperations.attempt, attempt),
            ),
          )
          .returning({ id: schema.environmentOperations.id });
        if (!operation) return "superseded" as const;
        const [environment] = await transaction
          .update(schema.environments)
          .set({
            flyAppName: input.appName,
            gatewayServiceTokenHash: input.gatewayServiceTokenHash,
            updatedAt: now,
          })
          .where(eq(schema.environments.id, input.environmentId))
          .returning({ id: schema.environments.id });
        return environment ? ("staged" as const) : ("superseded" as const);
      });
    },
    async stageEnvironmentAppIdentity(input) {
      const now = new Date();
      return knowledgeDb.transaction(async (transaction) => {
        await transaction.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(input.environmentId)}, 0))`,
        );
        const [operation] = await transaction
          .update(schema.environmentOperations)
          .set({ updatedAt: now })
          .where(
            and(
              eq(schema.environmentOperations.id, input.operationId),
              eq(
                schema.environmentOperations.environmentId,
                input.environmentId,
              ),
              eq(schema.environmentOperations.status, "running"),
              eq(schema.environmentOperations.attempt, input.attempt),
            ),
          )
          .returning({ id: schema.environmentOperations.id });
        if (!operation) return "superseded" as const;
        const [environment] = await transaction
          .update(schema.environments)
          .set({
            flyAppName: input.appName,
            flyNetworkName: input.networkName,
            updatedAt: now,
          })
          .where(eq(schema.environments.id, input.environmentId))
          .returning({ id: schema.environments.id });
        return environment ? ("staged" as const) : ("superseded" as const);
      });
    },
    async setEnvironmentDeleting(environmentId, options) {
      await knowledgeDb.transaction(async (transaction) => {
        await transaction.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(environmentId)}, 0))`,
        );
        const [environment] = await transaction
          .update(schema.environments)
          .set({ status: "deleting", updatedAt: new Date() })
          .where(eq(schema.environments.id, environmentId))
          .returning({
            id: schema.environments.id,
            isDefault: schema.environments.isDefault,
          });
        if (!environment) {
          throw operationError(
            "ENVIRONMENT_NOT_FOUND",
            "Environment deletion target is unavailable.",
          );
        }
        if (environment.isDefault && !options?.organizationTeardown) {
          throw operationError(
            "ENVIRONMENT_IS_DEFAULT",
            "Select another default Environment before deleting this Environment.",
          );
        }
        const project = await transaction.query.projects.findFirst({
          where: (table, { eq }) => eq(table.environmentId, environmentId),
          columns: { id: true },
        });
        if (project && !options?.organizationTeardown) {
          throw operationError(
            "ENVIRONMENT_HAS_PROJECTS",
            "Move every Project to another Environment before deleting this Environment.",
          );
        }
        const [deployment, gateway] = await Promise.all([
          transaction.query.aiDeployments.findFirst({
            where: (table, { and, eq, isNull }) =>
              and(
                eq(table.environmentId, environmentId),
                isNull(table.deletedAt),
              ),
            columns: { id: true },
          }),
          transaction.query.aiGateways.findFirst({
            where: (table, { eq }) => eq(table.environmentId, environmentId),
            columns: { id: true },
          }),
        ]);
        if ((deployment || gateway) && !options?.organizationTeardown) {
          throw operationError(
            "ENVIRONMENT_HAS_PRIVATE_INFERENCE",
            "Remove private inference before deleting this Environment.",
          );
        }
      });
    },
    async completeEnvironmentProvision(input) {
      const now = new Date();
      return knowledgeDb.transaction(async (transaction) => {
        await transaction.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(input.environmentId)}, 0))`,
        );
        const [operation] = await transaction
          .update(schema.environmentOperations)
          .set({ updatedAt: now })
          .where(
            and(
              eq(schema.environmentOperations.id, input.operationId),
              eq(
                schema.environmentOperations.environmentId,
                input.environmentId,
              ),
              eq(schema.environmentOperations.status, "running"),
              eq(schema.environmentOperations.attempt, input.attempt),
            ),
          )
          .returning({ id: schema.environmentOperations.id });
        if (!operation) return "superseded" as const;
        const [environment] = await transaction
          .update(schema.environments)
          .set({
            status: "ready",
            flyAppName: input.appName,
            flyNetworkName: input.networkName,
            flyGatewayMachineId: input.gatewayMachineId,
            routerUrl: input.routerUrl,
            routerImage: input.routerImage,
            runtimeImage: input.runtimeImage,
            gatewayServiceTokenHash: input.gatewayServiceTokenHash,
            lastHealthAt: now,
            failureCode: null,
            failureMessage: null,
            updatedAt: now,
          })
          .where(eq(schema.environments.id, input.environmentId))
          .returning({ id: schema.environments.id });
        if (!environment) return "superseded" as const;
        const [completed] = await transaction
          .update(schema.environmentOperations)
          .set({
            status: "completed",
            stage: "environment.activation.ready",
            result: {
              appName: input.appName,
              networkName: input.networkName,
              gatewayMachineId: input.gatewayMachineId,
              routerUrl: input.routerUrl,
            },
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.environmentOperations.id, input.operationId),
              eq(schema.environmentOperations.status, "running"),
              eq(schema.environmentOperations.attempt, input.attempt),
            ),
          )
          .returning({ id: schema.environmentOperations.id });
        return completed ? ("completed" as const) : ("superseded" as const);
      });
    },
    async failEnvironment(input) {
      await knowledgeDb
        .update(schema.environments)
        .set({
          status: "failed",
          failureCode: input.code,
          failureMessage: input.message,
          updatedAt: new Date(),
        })
        .where(eq(schema.environments.id, input.environmentId));
    },
    async failEnvironmentProvision(input) {
      const now = new Date();
      return knowledgeDb.transaction(async (transaction) => {
        await transaction.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(input.environmentId)}, 0))`,
        );
        const [operation] = await transaction
          .update(schema.environmentOperations)
          .set({ updatedAt: now })
          .where(
            and(
              eq(schema.environmentOperations.id, input.operationId),
              eq(
                schema.environmentOperations.environmentId,
                input.environmentId,
              ),
              eq(schema.environmentOperations.status, "running"),
              eq(schema.environmentOperations.attempt, input.attempt),
            ),
          )
          .returning({
            id: schema.environmentOperations.id,
            result: schema.environmentOperations.result,
          });
        if (!operation) return "superseded" as const;
        const [environment] = await transaction
          .update(schema.environments)
          .set({
            status: "failed",
            failureCode: input.code,
            failureMessage: input.message,
            updatedAt: now,
          })
          .where(eq(schema.environments.id, input.environmentId))
          .returning({ id: schema.environments.id });
        if (!environment) return "superseded" as const;
        const [failed] = await transaction
          .update(schema.environmentOperations)
          .set({
            status: "failed",
            stage: input.stage ?? "environment.activation.failed",
            ...(input.providerRequestId
              ? { providerRequestId: input.providerRequestId }
              : {}),
            ...(input.result
              ? { result: { ...(operation.result ?? {}), ...input.result } }
              : {}),
            errorCode: input.code,
            errorMessage: input.message,
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.environmentOperations.id, input.operationId),
              eq(schema.environmentOperations.status, "running"),
              eq(schema.environmentOperations.attempt, input.attempt),
            ),
          )
          .returning({ id: schema.environmentOperations.id });
        return failed ? ("failed" as const) : ("superseded" as const);
      });
    },
    async degradeEnvironment(input) {
      await knowledgeDb
        .update(schema.environments)
        .set({
          status: "degraded",
          failureCode: input.code,
          failureMessage: input.message,
          updatedAt: new Date(),
        })
        .where(eq(schema.environments.id, input.environmentId));
    },
    async completeEnvironmentGatewayUpdate(input) {
      await knowledgeDb
        .update(schema.environments)
        .set({
          status: "ready",
          routerImage: input.routerImage,
          ...(input.gatewayServiceTokenHash
            ? { gatewayServiceTokenHash: input.gatewayServiceTokenHash }
            : {}),
          lastHealthAt: new Date(),
          failureCode: null,
          failureMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.environments.id, input.environmentId));
    },
    async completeEnvironmentRuntimeUpdate(input) {
      await knowledgeDb
        .update(schema.environments)
        .set({
          status: "ready",
          runtimeImage: input.runtimeImage,
          lastHealthAt: new Date(),
          failureCode: null,
          failureMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.environments.id, input.environmentId));
    },
    async completeEnvironmentDelete(environmentId) {
      const now = new Date();
      await knowledgeDb.transaction(async (transaction) => {
        await transaction
          .delete(schema.threadExecutionBindings)
          .where(
            eq(schema.threadExecutionBindings.environmentId, environmentId),
          );
        await transaction
          .delete(schema.projectEnvironmentBindings)
          .where(
            eq(schema.projectEnvironmentBindings.environmentId, environmentId),
          );
        await transaction
          .update(schema.environmentWorkspaces)
          .set({
            status: "deleted",
            flyMachineId: null,
            flyVolumeId: null,
            deletedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.environmentWorkspaces.environmentId, environmentId));
        await transaction
          .update(schema.environments)
          .set({
            status: "deleted",
            isDefault: false,
            flyAppName: null,
            flyNetworkName: null,
            flyGatewayMachineId: null,
            routerUrl: null,
            routerImage: null,
            archivedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.environments.id, environmentId));
      });
    },
    async setWorkspaceProvisioning(workspaceId) {
      await knowledgeDb
        .update(schema.environmentWorkspaces)
        .set({
          status: "provisioning",
          failureCode: null,
          failureMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.environmentWorkspaces.id, workspaceId));
    },
    async completeWorkspace(input) {
      await knowledgeDb
        .update(schema.environmentWorkspaces)
        .set({
          status: "ready",
          flyVolumeId: input.volumeId,
          flyMachineId: input.machineId,
          runtimeImage: input.runtimeImage,
          serviceTokenHash: input.serviceTokenHash,
          lastActivityAt: new Date(),
          lastHealthAt: new Date(),
          failureCode: null,
          failureMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.environmentWorkspaces.id, input.workspaceId));
    },
    async failWorkspace(input) {
      await knowledgeDb
        .update(schema.environmentWorkspaces)
        .set({
          status: "failed",
          failureCode: input.code,
          failureMessage: input.message,
          updatedAt: new Date(),
        })
        .where(eq(schema.environmentWorkspaces.id, input.workspaceId));
    },
    async degradeWorkspace(input) {
      await knowledgeDb
        .update(schema.environmentWorkspaces)
        .set({
          status: "degraded",
          failureCode: input.code,
          failureMessage: input.message,
          updatedAt: new Date(),
        })
        .where(eq(schema.environmentWorkspaces.id, input.workspaceId));
    },
    async setWorkspaceStarting(workspaceId) {
      await knowledgeDb
        .update(schema.environmentWorkspaces)
        .set({ status: "starting", updatedAt: new Date() })
        .where(eq(schema.environmentWorkspaces.id, workspaceId));
    },
    async setWorkspaceStopping(workspaceId) {
      await knowledgeDb
        .update(schema.environmentWorkspaces)
        .set({ status: "stopping", updatedAt: new Date() })
        .where(eq(schema.environmentWorkspaces.id, workspaceId));
    },
    async setWorkspaceDeleting(workspaceId) {
      await knowledgeDb
        .update(schema.environmentWorkspaces)
        .set({ status: "deleting", updatedAt: new Date() })
        .where(eq(schema.environmentWorkspaces.id, workspaceId));
    },
    async completeWorkspaceStart(workspaceId) {
      const now = new Date();
      await knowledgeDb
        .update(schema.environmentWorkspaces)
        .set({
          status: "ready",
          lastActivityAt: now,
          lastHealthAt: now,
          updatedAt: now,
        })
        .where(eq(schema.environmentWorkspaces.id, workspaceId));
    },
    async completeWorkspaceStop(workspaceId) {
      await knowledgeDb
        .update(schema.environmentWorkspaces)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(eq(schema.environmentWorkspaces.id, workspaceId));
    },
    async completeWorkspaceDelete(workspaceId) {
      const now = new Date();
      await knowledgeDb.transaction(async (transaction) => {
        const workspace =
          await transaction.query.environmentWorkspaces.findFirst({
            where: (table, { eq }) => eq(table.id, workspaceId),
            columns: { projectId: true },
          });
        await transaction
          .delete(schema.threadExecutionBindings)
          .where(eq(schema.threadExecutionBindings.workspaceId, workspaceId));
        if (workspace?.projectId) {
          await transaction
            .delete(schema.projectEnvironmentBindings)
            .where(
              eq(
                schema.projectEnvironmentBindings.projectId,
                workspace.projectId,
              ),
            );
        }
        await transaction
          .update(schema.environmentWorkspaces)
          .set({
            status: "deleted",
            flyMachineId: null,
            flyVolumeId: null,
            deletedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.environmentWorkspaces.id, workspaceId));
      });
    },
    async completeWorkspaceRebuild(input) {
      const now = new Date();
      await knowledgeDb
        .update(schema.environmentWorkspaces)
        .set({
          status: "ready",
          runtimeImage: input.runtimeImage,
          ...(input.serviceTokenHash
            ? { serviceTokenHash: input.serviceTokenHash }
            : {}),
          lastActivityAt: now,
          lastHealthAt: now,
          updatedAt: now,
        })
        .where(eq(schema.environmentWorkspaces.id, input.workspaceId));
    },
    async completeStoppedWorkspaceRebuild(input) {
      const now = new Date();
      await knowledgeDb
        .update(schema.environmentWorkspaces)
        .set({
          status: "stopped",
          runtimeImage: input.runtimeImage,
          ...(input.serviceTokenHash
            ? { serviceTokenHash: input.serviceTokenHash }
            : {}),
          failureCode: null,
          failureMessage: null,
          lastHealthAt: now,
          updatedAt: now,
        })
        .where(eq(schema.environmentWorkspaces.id, input.workspaceId));
    },
    async configureStoppedWorkspace(input) {
      await knowledgeDb
        .update(schema.environmentWorkspaces)
        .set({
          status: "stopped",
          runtimeImage: input.runtimeImage,
          ...(input.serviceTokenHash
            ? { serviceTokenHash: input.serviceTokenHash }
            : {}),
          failureCode: null,
          failureMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.environmentWorkspaces.id, input.workspaceId));
    },
    async updateOperationStage(input) {
      await knowledgeDb
        .update(schema.environmentOperations)
        .set({
          stage: input.stage,
          ...(input.result !== undefined ? { result: input.result } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.environmentOperations.id, input.operationId),
            eq(schema.environmentOperations.status, "running"),
            ...(input.attempt === undefined
              ? []
              : [eq(schema.environmentOperations.attempt, input.attempt)]),
          ),
        );
    },
    async completeOperation(input) {
      const now = new Date();
      await knowledgeDb
        .update(schema.environmentOperations)
        .set({
          status: "completed",
          stage: input.stage,
          result: input.result,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.environmentOperations.id, input.operationId));
    },
    async failOperation(input) {
      const now = new Date();
      const current = input.result
        ? await knowledgeDb.query.environmentOperations.findFirst({
            where: (table, { eq }) => eq(table.id, input.operationId),
            columns: { result: true },
          })
        : null;
      await knowledgeDb
        .update(schema.environmentOperations)
        .set({
          status: "failed",
          stage: input.stage,
          ...(input.providerRequestId
            ? { providerRequestId: input.providerRequestId }
            : {}),
          ...(input.result
            ? { result: { ...(current?.result ?? {}), ...input.result } }
            : {}),
          errorCode: input.code,
          errorMessage: input.message,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.environmentOperations.id, input.operationId));
    },
    async deferOperation(input) {
      await knowledgeDb.transaction(async (transaction) => {
        const current = input.retryState
          ? await transaction.query.environmentOperations.findFirst({
              where: (table, { eq }) => eq(table.id, input.operationId),
              columns: { result: true },
            })
          : null;
        const [operation] = await transaction
          .update(schema.environmentOperations)
          .set({
            status: "queued",
            stage: input.stage,
            errorCode: input.code ?? null,
            errorMessage: input.message,
            ...(input.providerRequestId
              ? { providerRequestId: input.providerRequestId }
              : {}),
            ...(input.retryState
              ? {
                  result: {
                    ...(current?.result ?? {}),
                    retryState: input.retryState,
                    ...(input.providerFailure
                      ? { providerFailure: input.providerFailure }
                      : {}),
                  },
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.environmentOperations.id, input.operationId),
              eq(schema.environmentOperations.status, "running"),
              ...(input.attempt === undefined
                ? []
                : [eq(schema.environmentOperations.attempt, input.attempt)]),
            ),
          )
          .returning({ input: schema.environmentOperations.input });
      });
    },
  };

function operationError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

class EnvironmentProvisioningPersistenceError extends Error {
  readonly code = "ENVIRONMENT_CONTROL_PLANE_RETRYING";

  constructor(_cause: unknown) {
    super("Kestrel could not record Environment provisioning state. Retrying.");
    this.name = "EnvironmentProvisioningPersistenceError";
  }
}

async function cleanupFailedWorkspaceProvisioning(input: {
  provider: EnvironmentInfrastructureProvider;
  appName: string;
  operationId: string;
  machineId?: string | undefined;
  volumeId?: string | undefined;
}) {
  const failures: string[] = [];
  if (input.machineId) {
    await input.provider
      .deleteMachine({
        appName: input.appName,
        machineId: input.machineId,
      })
      .catch((error) =>
        failures.push(
          error instanceof Error ? error.message : "machine cleanup failed",
        ),
      );
  }
  if (input.volumeId) {
    await input.provider
      .deleteVolume({
        appName: input.appName,
        volumeId: input.volumeId,
      })
      .catch((error) =>
        failures.push(
          error instanceof Error ? error.message : "volume cleanup failed",
        ),
      );
  }
  if (failures.length > 0) {
    console.error("Workspace provisioning cleanup failed.", {
      operationId: input.operationId,
      resourceFailureCount: failures.length,
      messages: failures.map((message) => message.slice(0, 300)),
    });
  }
}

function readImmutableImage(
  value: unknown,
  label: string,
  role: EnvironmentRuntimeImageRole,
) {
  if (typeof value !== "string") {
    throw operationError(
      "ENVIRONMENT_IMAGE_INVALID",
      `${label} must use its approved fixed production repository and reference.`,
    );
  }
  try {
    assertEnvironmentRuntimeImage(role, value);
  } catch {
    throw operationError(
      "ENVIRONMENT_IMAGE_INVALID",
      `${label} must use its approved fixed production repository and reference.`,
    );
  }
  return value;
}

function assertEnvironmentOperationTransition(
  current: Parameters<typeof assertEnvironmentTransition>[0],
  next: Parameters<typeof assertEnvironmentTransition>[1],
) {
  if (current !== next) assertEnvironmentTransition(current, next);
}

function assertWorkspaceOperationTransition(
  current: Parameters<typeof assertWorkspaceTransition>[0],
  next: Parameters<typeof assertWorkspaceTransition>[1],
) {
  if (current !== next) assertWorkspaceTransition(current, next);
}

function safeFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown };
    return {
      code:
        typeof candidate.code === "string"
          ? candidate.code.slice(0, 120)
          : "ENVIRONMENT_PROVISIONING_FAILED",
      message: error.message.slice(0, 500),
      retryable:
        error instanceof EnvironmentProviderError &&
        (error.code === "FLY_PROVIDER_UNAVAILABLE" ||
          error.status === 408 ||
          error.status === 429 ||
          ([409, 412].includes(error.status ?? 0) &&
            readAuthoritativeState(error) !== undefined) ||
          (error.status !== undefined && error.status >= 500)),
    };
  }
  return {
    code: "ENVIRONMENT_PROVISIONING_FAILED",
    message: "Environment provisioning failed.",
    retryable: false,
  };
}

function readProviderFailureEvidence(error: unknown) {
  if (!(error instanceof EnvironmentProviderError)) return;
  const evidence = {
    phase: error.phase,
    status: error.status,
    requestId: error.requestId,
    detail: error.providerDetail,
  };
  return Object.values(evidence).some((value) => value !== undefined)
    ? evidence
    : undefined;
}

export async function classifyEnvironmentGatewayHealthFailure(input: {
  error: unknown;
  routerUrl: string | null;
  fetchImpl?: typeof fetch | undefined;
}) {
  if (
    !(input.error instanceof EnvironmentProviderError) ||
    input.error.code !== "FLY_MACHINE_UNHEALTHY" ||
    !input.routerUrl
  ) {
    return input.error;
  }
  try {
    const response = await (input.fetchImpl ?? fetch)(
      new URL("/health", input.routerUrl),
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(3000),
      },
    );
    const health = (await response.json()) as {
      service?: unknown;
      gatewayConfig?: {
        acceptedVersions?: unknown;
        activeVersion?: unknown;
        lastFailure?: { code?: unknown; receivedVersion?: unknown } | null;
      };
    };
    const failure = health.gatewayConfig?.lastFailure;
    if (
      health.service !== "environment-router" ||
      (failure?.code !== "UNSUPPORTED_VERSION" &&
        failure?.code !== "INVALID_CONFIG")
    ) {
      return input.error;
    }
    const accepted = Array.isArray(health.gatewayConfig?.acceptedVersions)
      ? health.gatewayConfig.acceptedVersions.filter(Number.isInteger)
      : [];
    const received = Number.isInteger(failure.receivedVersion)
      ? failure.receivedVersion
      : null;
    return Object.assign(
      new Error(
        `Environment Router configuration is unready (${failure.code}; received version ${received ?? "unknown"}; accepts [${accepted.join(", ")}]).`,
      ),
      {
        code: "ENVIRONMENT_GATEWAY_CONFIGURATION_UNREADY",
        gatewayConfig: {
          code: failure.code,
          receivedVersion: received,
          acceptedVersions: accepted,
        },
      },
    );
  } catch {
    return input.error;
  }
}

function hasErrorCode(error: unknown, code: string) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: unknown }).code === code
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readInputString(value: unknown, key: string) {
  const candidate = asRecord(value)?.[key];
  return typeof candidate === "string" ? candidate : null;
}

type EnvironmentUpdateCheckpoint = {
  gatewayVerified: boolean;
  backedUpWorkspaceIds: string[];
  verifiedWorkspaceIds: string[];
  configuredStoppedWorkspaceIds: string[];
  workspaceStateSnapshotCaptured: boolean;
  initiallyStoppedWorkspaceIds: string[];
  restoredStoppedWorkspaceIds: string[];
};

function readEnvironmentUpdateCheckpoint(
  result: unknown,
): EnvironmentUpdateCheckpoint {
  const checkpoint = asRecord(asRecord(result)?.environmentUpdateCheckpoint);
  return {
    gatewayVerified: checkpoint?.gatewayVerified === true,
    backedUpWorkspaceIds: readStringArray(checkpoint?.backedUpWorkspaceIds),
    verifiedWorkspaceIds: readStringArray(checkpoint?.verifiedWorkspaceIds),
    configuredStoppedWorkspaceIds: readStringArray(
      checkpoint?.configuredStoppedWorkspaceIds,
    ),
    workspaceStateSnapshotCaptured:
      checkpoint?.workspaceStateSnapshotCaptured === true,
    initiallyStoppedWorkspaceIds: readStringArray(
      checkpoint?.initiallyStoppedWorkspaceIds,
    ),
    restoredStoppedWorkspaceIds: readStringArray(
      checkpoint?.restoredStoppedWorkspaceIds,
    ),
  };
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (candidate): candidate is string => typeof candidate === "string",
      )
    : [];
}

function readAuthoritativeState(error: unknown) {
  return asRecord(error)?.authoritativeState;
}
