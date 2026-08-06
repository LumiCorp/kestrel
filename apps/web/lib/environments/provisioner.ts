import { and, eq, inArray, sql } from "drizzle-orm";
import { WORKSPACE_READINESS_TIMEOUT_SECONDS } from "@lumi/kestrel-environment-auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
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
    routerImage: string | null;
    runtimeImage: string | null;
    targetRouterImage?: string | null;
    targetRuntimeImage?: string | null;
    targetSourceRevision?: string | null;
    targetGeneration?: number | null;
    idleTimeoutMinutes: number;
  } | null>;
  getWorkspace(workspaceId: string): Promise<{
    id: string;
    createdByUserId?: string;
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
  countActiveEnvironmentExecutions?(environmentId: string): Promise<number>;
  beginEnvironmentProvisioning(input: {
    environmentId: string;
    operationId: string;
    attempt: number;
  }): Promise<"prepared" | "superseded">;
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
  }): Promise<"failed" | "superseded">;
  degradeEnvironment(input: {
    environmentId: string;
    code: string;
    message: string;
  }): Promise<void>;
  degradeWorkspace?(input: {
    workspaceId: string;
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
  configureStoppedWorkspace?(input: {
    workspaceId: string;
    runtimeImage: string;
    serviceTokenHash?: string | undefined;
  }): Promise<void>;
  markWorkspaceReleaseVerified?(input: {
    workspaceId: string;
    runtimeImage: string;
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
  }): Promise<void>;
  deferOperation(input: {
    operationId: string;
    attempt?: number | undefined;
    stage: string;
    code?: string | undefined;
    message: string;
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
  prepareSafetyRollback?(input: {
    operationId: string;
    imageField: "routerImage" | "runtimeImage";
    priorImage: string;
    rejectedImage: string;
  }): Promise<void>;
  rejectPlatformGeneration?(input: {
    environmentId: string;
    targetGeneration: number;
    code: string;
    message: string;
  }): Promise<void>;
}

export const RELEASE_RETRY_BUDGET_MS = 60 * 60 * 1000;

export function releaseRetryDelaySeconds(attempt: number) {
  return [5, 10, 20, 40, 80][attempt - 1] ?? 120;
}

export function releaseRetryNextAttemptAt(
  firstFailureAt: string,
  attempt: number,
  now = Date.now(),
) {
  const deadline = Date.parse(firstFailureAt) + RELEASE_RETRY_BUDGET_MS;
  if (now >= deadline) return null;
  return new Date(
    Math.min(deadline, now + releaseRetryDelaySeconds(attempt) * 1000),
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
    parentReleaseTargetId?: string | undefined;
    preDestructiveSnapshot?: { id: string; state: string } | undefined;
  }) => Promise<unknown>;

  constructor(input: {
    repository: EnvironmentProvisioningRepository;
    provider: EnvironmentInfrastructureProvider;
    runtimeImage: string;
    routerImage: string;
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
          parentReleaseTargetId?: string | undefined;
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
    } = input;
    if (!runtimeImage.trim()) {
      throw new Error("Workspace runtime image is not configured.");
    }
    if (!routerImage.trim()) {
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
      } else if (operation.type === "environment.gateway.update") {
        await this.updateEnvironmentGateway(operation);
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
      if (
        operation.type === "environment.provision" &&
        error instanceof EnvironmentProvisioningPersistenceError
      ) {
        await this.repository.deferOperation({
          operationId: operation.id,
          attempt: operation.attempt,
          stage: "environment.activation.reconciling",
          code: error.code,
          message: error.message,
        });
        return "deferred";
      }
      const failure = safeFailure(error);
      if (failure.code === "ENVIRONMENT_DRAINING") {
        await this.repository.deferOperation({
          operationId: operation.id,
          attempt: operation.attempt,
          stage: "platform.gateway.draining",
          code: failure.code,
          message: failure.message,
        });
        return "deferred";
      }
      if (failure.code === "ENVIRONMENT_NOT_READY") {
        if (readInputNumber(operation.input, "targetGeneration") !== null) {
          await this.repository.failOperation({
            operationId: operation.id,
            stage: "platform.resource.blocked",
            code: failure.code,
            message: failure.message,
          });
          return "processed";
        }
        await this.repository.deferOperation({
          operationId: operation.id,
          attempt: operation.attempt,
          stage: "environment.runtime.connecting",
          code: failure.code,
          message: failure.message,
        });
        return "deferred";
      }
      if (failure.retryable) {
        const releaseTargetId = readInputString(
          operation.input,
          "releaseTargetId",
        );
        const previousRetry = asRecord(operation.result)?.retryState;
        const firstFailureAt =
          readInputString(asRecord(previousRetry), "firstFailureAt") ??
          new Date().toISOString();
        const retryAttempt =
          Number(asRecord(previousRetry)?.attempt ?? 0) + 1;
        const budgetNextAttemptAt = releaseRetryNextAttemptAt(
          firstFailureAt,
          retryAttempt,
        );
        const targetGeneration = readInputNumber(
          operation.input,
          "targetGeneration",
        );
        const retryDeadline = readInputString(
          operation.input,
          "retryDeadline",
        );
        const safetyRollback = operation.input?.safetyRollback === true;
        const resourceDeadlineExhausted =
          targetGeneration !== null &&
          retryDeadline !== null &&
          Date.now() >= Date.parse(retryDeadline);
        if (
          !safetyRollback &&
          ((releaseTargetId && !budgetNextAttemptAt) || resourceDeadlineExhausted)
        ) {
          await this.repository.failOperation({
            operationId: operation.id,
            stage: "environment.provider.retry_exhausted",
            code: "ENVIRONMENT_PROVIDER_RETRY_EXHAUSTED",
            message: `Automatic provider retries were exhausted after one hour. Last response: ${failure.message}`,
          });
          if (operation.workspaceId && targetGeneration !== null) {
            await this.repository.degradeWorkspace?.({
              workspaceId: operation.workspaceId,
              code: "ENVIRONMENT_PROVIDER_RETRY_EXHAUSTED",
              message: failure.message,
            });
          } else if (targetGeneration !== null) {
            await this.repository.degradeEnvironment({
              environmentId: operation.environmentId,
              code: "ENVIRONMENT_PROVIDER_RETRY_EXHAUSTED",
              message: failure.message,
            });
          }
          return "processed";
        }
        await this.repository.deferOperation({
          operationId: operation.id,
          attempt: operation.attempt,
          stage: "environment.provider.retrying",
          code: failure.code,
          message: failure.message,
          retryState: {
            attempt: retryAttempt,
            firstFailureAt,
            lastError: { code: failure.code, message: failure.message },
            nextAttemptAt:
              boundedRetryTime({
                attempt: retryAttempt,
                retryDeadline: safetyRollback ? null : retryDeadline,
                budgetNextAttemptAt,
              }),
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
          ...failure,
        });
        return "processed";
      }
      const targetGeneration = readInputNumber(
        operation.input,
        "targetGeneration",
      );
      if (operation.workspaceId && targetGeneration !== null) {
        await this.repository.degradeWorkspace?.({
          workspaceId: operation.workspaceId,
          ...failure,
        });
      } else if (operation.workspaceId) {
        await this.repository.failWorkspace({
          workspaceId: operation.workspaceId,
          ...failure,
        });
      } else if (
        operation.type === "environment.update" ||
        operation.type === "environment.gateway.update"
      ) {
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
        stage: "environment.activation.failed",
        ...failure,
      });
      return "processed";
    }
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

  private async updateEnvironmentGateway(operation: ProvisioningOperation) {
    const environment = await this.repository.getEnvironment(
      operation.environmentId,
    );
    if (
      !environment?.flyAppName ||
      !environment.flyGatewayMachineId ||
      !["ready", "degraded"].includes(environment.status)
    ) {
      throw operationError(
        "ENVIRONMENT_NOT_READY",
        "Environment gateway update target is unavailable.",
      );
    }
    const targetGeneration = readRequiredGeneration(operation.input);
    if (environment.targetGeneration !== targetGeneration) {
      await this.completeSupersededOperation(operation);
      return;
    }
    const activeExecutionCount =
      await this.repository.countActiveEnvironmentExecutions?.(environment.id);
    if ((activeExecutionCount ?? 0) > 0) {
      throw operationError(
        "ENVIRONMENT_DRAINING",
        `Waiting for ${activeExecutionCount} active Environment execution(s) to finish.`,
      );
    }
    const routerImage = readImmutableImage(
      operation.input?.routerImage,
      "Environment router image",
    );
    const priorImage = readOptionalImmutableImage(
      operation.input?.priorImage,
      "Prior Environment router image",
    );
    const safetyRollback = operation.input?.safetyRollback === true;
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: safetyRollback
        ? "platform.gateway.safety_rollback"
        : "platform.gateway.applying",
    });
    try {
      const gateway = await this.provider.updateMachineImage({
        appName: environment.flyAppName,
        machineId: environment.flyGatewayMachineId,
        runtimeImage: routerImage,
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
      await this.repository.updateOperationStage({
        operationId: operation.id,
        stage: safetyRollback
          ? "platform.gateway.safety_rollback_verifying"
          : "platform.gateway.verifying",
      });
      await this.provider.waitForMachineHealth({
        appName: environment.flyAppName,
        machineId: environment.flyGatewayMachineId,
        checkName: "gateway",
        timeoutSeconds: 90,
      });
    } catch (error) {
      if (
        !safetyRollback &&
        hasErrorCode(error, "FLY_MACHINE_UNHEALTHY") &&
        priorImage &&
        priorImage !== routerImage
      ) {
        if (!this.repository.prepareSafetyRollback) {
          throw operationError(
            "PLATFORM_RUNTIME_ROLLBACK_UNAVAILABLE",
            "Safety rollback persistence is unavailable.",
          );
        }
        await this.repository.prepareSafetyRollback({
          operationId: operation.id,
          imageField: "routerImage",
          priorImage,
          rejectedImage: routerImage,
        });
        throw new EnvironmentProviderError(
          "FLY_PROVIDER_UNAVAILABLE",
          "The desired gateway image failed health verification; safety rollback is pending.",
        );
      }
      throw error;
    }
    const current = await this.repository.getEnvironment(environment.id);
    if (current?.targetGeneration !== targetGeneration) {
      await this.completeSupersededOperation(operation);
      return;
    }
    await this.repository.completeEnvironmentGatewayUpdate({
      environmentId: environment.id,
      routerImage,
    });
    if (safetyRollback) {
      const rejectedImage = readInputString(operation.input, "rejectedImage");
      const message = `Gateway image ${rejectedImage ?? "unknown"} failed health verification and was rolled back.`;
      await this.repository.rejectPlatformGeneration?.({
        environmentId: environment.id,
        targetGeneration,
        code: "PLATFORM_RUNTIME_GATEWAY_HEALTH_REJECTED",
        message,
      });
      await this.repository.failOperation({
        operationId: operation.id,
        stage: "platform.gateway.rolled_back",
        code: "PLATFORM_RUNTIME_GATEWAY_HEALTH_REJECTED",
        message,
      });
      return;
    }
    await this.repository.completeOperation({
      operationId: operation.id,
      stage: "platform.gateway.ready",
      result: { targetGeneration, routerImage },
    });
  }

  private async completeSupersededOperation(operation: ProvisioningOperation) {
    await this.repository.completeOperation({
      operationId: operation.id,
      stage: "platform.resource.superseded",
      result: {
        targetGeneration: readInputNumber(operation.input, "targetGeneration"),
        superseded: true,
      },
    });
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
      !operation.requestedByUserId ||
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
    );
    const routerImage = readImmutableImage(
      operation.input?.routerImage,
      "Environment router image",
    );
    const workspaceDataMigrationRevision = readInputString(
      operation.input,
      "workspaceDataMigrationRevision",
    );
    const skipWorkspaceBackups =
      operation.input?.skipWorkspaceBackups === true ||
      !workspaceDataMigrationRevision;
    const preserveStoppedWorkspaces =
      operation.input?.preserveStoppedWorkspaces === true;
    const automaticRollback = operation.input?.automaticRollback !== false;
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
    if (!checkpoint.gatewayVerified) {
      await persistCheckpoint("environment.update.gateway");
      try {
        const gateway = await this.provider.updateMachineImage({
          appName: environment.flyAppName,
          machineId: environment.flyGatewayMachineId,
          runtimeImage: routerImage,
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
        throw error;
      }
      await this.repository.completeEnvironmentGatewayUpdate({
        environmentId: environment.id,
        routerImage,
      });
      checkpoint.gatewayVerified = true;
      await persistCheckpoint("environment.update.gateway_verified");
    }
    const alreadyUpdatedWorkspaceIds = new Set(
      checkpoint.verifiedWorkspaceIds,
    );
    if (skipWorkspaceBackups) {
      await persistCheckpoint("environment.update.backups_skipped");
    } else {
      await persistCheckpoint("environment.update.backing_up");
      for (const workspace of workspaces) {
        if (!(workspace.flyMachineId && workspace.flyVolumeId)) continue;
        if (preserveStoppedWorkspaces && workspace.status === "stopped") {
          continue;
        }
        if (checkpoint.backedUpWorkspaceIds.includes(workspace.id)) continue;
        const backupInput = {
          organizationId: operation.organizationId,
          environmentId: environment.id,
          workspaceId: workspace.id,
          actorUserId: operation.requestedByUserId,
          reason: "pre_destructive",
          idempotencyKey:
            `environment.update:${operation.id}:backup:` +
            `${workspaceDataMigrationRevision}:${workspace.id}`,
          parentLifecycleOperationId: operation.id,
          parentReleaseTargetId:
            typeof operation.input?.releaseTargetId === "string"
              ? operation.input.releaseTargetId
              : undefined,
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
          });
          await this.backupWorkspace({
            ...backupInput,
            preDestructiveSnapshot,
          });
          alreadyUpdatedWorkspaceIds.add(workspace.id);
          checkpoint.verifiedWorkspaceIds = [
            ...new Set([...checkpoint.verifiedWorkspaceIds, workspace.id]),
          ];
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
        }
        await persistCheckpoint("environment.update.backing_up");
      }
    }
    await persistCheckpoint("environment.update.workspaces");
    const skippedWorkspaceIds: string[] = [];
    const configuredUnverifiedWorkspaceIds: string[] = [];
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
      if (preserveStoppedWorkspaces && workspace.status === "stopped") {
        if (checkpoint.configuredStoppedWorkspaceIds.includes(workspace.id)) {
          configuredUnverifiedWorkspaceIds.push(workspace.id);
          updatedWorkspaceCount += 1;
          continue;
        }
        await this.configureStoppedWorkspaceRuntime({
          appName: environment.flyAppName,
          workspaceId: workspace.id,
          machineId: workspace.flyMachineId,
          runtimeImage,
        });
        configuredUnverifiedWorkspaceIds.push(workspace.id);
        checkpoint.configuredStoppedWorkspaceIds = [
          ...new Set([...checkpoint.configuredStoppedWorkspaceIds, workspace.id]),
        ];
        updatedWorkspaceCount += 1;
        await persistCheckpoint("environment.update.workspaces");
        continue;
      }
      await this.updateWorkspaceRuntime({
        appName: environment.flyAppName,
        workspaceId: workspace.id,
        machineId: workspace.flyMachineId,
        runtimeImage,
      });
      checkpoint.verifiedWorkspaceIds = [
        ...new Set([...checkpoint.verifiedWorkspaceIds, workspace.id]),
      ];
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
        ...(configuredUnverifiedWorkspaceIds.length > 0
          ? { configuredUnverifiedWorkspaceIds }
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
    return snapshot.id
      ? { id: snapshot.id, state: snapshot.state }
      : undefined;
  }

  private async updateWorkspaceRuntime(input: {
    appName: string;
    workspaceId: string;
    machineId: string;
    runtimeImage: string;
  }) {
    await this.repository.setWorkspaceStarting(input.workspaceId);
    try {
      const machine = await this.provider.updateMachineImage({
        appName: input.appName,
        machineId: input.machineId,
        runtimeImage: input.runtimeImage,
        stopConfig: KESTREL_WORKSPACE_STOP_CONFIG,
      });
      if (machine.state === "stopped") {
        await this.provider.startMachine({
          appName: input.appName,
          machineId: input.machineId,
        });
      }
      if (machine.state !== "started") {
        await this.provider.waitForMachine({
          appName: input.appName,
          machineId: input.machineId,
          state: "started",
          timeoutSeconds: WORKSPACE_READINESS_TIMEOUT_SECONDS,
        });
      }
      await this.provider.waitForMachineHealth({
        appName: input.appName,
        machineId: input.machineId,
        checkName: "workspace",
        timeoutSeconds: WORKSPACE_READINESS_TIMEOUT_SECONDS,
      });
      await this.repository.completeWorkspaceRebuild({
        workspaceId: input.workspaceId,
        runtimeImage: input.runtimeImage,
      });
    } catch (error) {
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
        "ENVIRONMENT_NOT_READY",
        "Environment must be ready before its Workspace can be provisioned.",
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
        runtimeImage:
          environment.targetRuntimeImage ??
          environment.runtimeImage ??
          this.runtimeImage,
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
          timeoutSeconds: WORKSPACE_READINESS_TIMEOUT_SECONDS,
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
        timeoutSeconds: WORKSPACE_READINESS_TIMEOUT_SECONDS,
      });
      await this.repository.completeWorkspace({
        workspaceId: workspace.id,
        volumeId: volume.id,
        machineId: machine.id,
        runtimeImage:
          environment.targetRuntimeImage ??
          environment.runtimeImage ??
          this.runtimeImage,
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
    const desiredRuntimeImage =
      environment.targetRuntimeImage ??
      environment.runtimeImage ??
      this.runtimeImage;
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
      timeoutSeconds: WORKSPACE_READINESS_TIMEOUT_SECONDS,
    });
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.health.checking",
    });
    await this.provider.waitForMachineHealth({
      appName: environment.flyAppName,
      machineId: workspace.flyMachineId,
      checkName: "workspace",
      timeoutSeconds: WORKSPACE_READINESS_TIMEOUT_SECONDS,
    });
    await this.repository.completeWorkspaceStart(workspace.id);
    if (
      process.env.KESTREL_PLATFORM_RUNTIME_RECONCILIATION_MODE !== "active"
    ) {
      await this.repository.markWorkspaceReleaseVerified?.({
        workspaceId: workspace.id,
        runtimeImage: desiredRuntimeImage,
      });
    }
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
    const targetGeneration = readInputNumber(operation.input, "targetGeneration");
    const runtimeImage =
      targetGeneration === null
        ? environment?.runtimeImage
        : readImmutableImage(
            operation.input?.runtimeImage,
            "Workspace runtime image",
          );
    if (
      !(environment?.flyAppName && runtimeImage) ||
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
    if (
      targetGeneration !== null &&
      environment.targetGeneration !== targetGeneration
    ) {
      await this.completeSupersededOperation(operation);
      return;
    }
    const priorImage = readOptionalImmutableImage(
      operation.input?.priorImage,
      "Prior Workspace runtime image",
    );
    const safetyRollback = operation.input?.safetyRollback === true;
    const workspaceDataMigrationRevision = readInputString(
      operation.input,
      "workspaceDataMigrationRevision",
    );
    const migrationBackupCompleted =
      asRecord(operation.result)?.migrationBackupCompleted === true;
    if (
      targetGeneration !== null &&
      workspaceDataMigrationRevision &&
      !migrationBackupCompleted
    ) {
      if (!workspace.flyVolumeId) {
        throw operationError(
          "WORKSPACE_VOLUME_MISSING",
          "Workspace data migration requires a recoverable volume.",
        );
      }
      if (!workspace.createdByUserId) {
        throw operationError(
          "WORKSPACE_BACKUP_ACTOR_MISSING",
          "Workspace data migration requires a durable backup actor.",
        );
      }
      await this.repository.updateOperationStage({
        operationId: operation.id,
        stage: "platform.workspace.backing_up",
      });
      await this.backupWorkspace({
        organizationId: operation.organizationId,
        environmentId: operation.environmentId,
        workspaceId: workspace.id,
        actorUserId: workspace.createdByUserId,
        reason: "pre_destructive",
        idempotencyKey:
          `platform-runtime:${targetGeneration}:migration:` +
          `${workspaceDataMigrationRevision}:${workspace.id}`,
        parentLifecycleOperationId: operation.id,
      });
      await this.repository.updateOperationStage({
        operationId: operation.id,
        stage: "platform.workspace.backup_ready",
        result: {
          ...(operation.result ?? {}),
          migrationBackupCompleted: true,
        },
      });
    }
    assertWorkspaceOperationTransition(
      workspaceStatusSchema.parse(workspace.status),
      "starting",
    );
    await this.repository.setWorkspaceStarting(workspace.id);
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: safetyRollback
        ? "platform.workspace.safety_rollback"
        : "platform.workspace.applying",
    });
    try {
      const machine = await this.provider.updateMachineImage({
        appName: environment.flyAppName,
        machineId: workspace.flyMachineId,
        runtimeImage,
        stopConfig: KESTREL_WORKSPACE_STOP_CONFIG,
      });
      if (machine.state !== "started") {
        await this.provider.waitForMachine({
          appName: environment.flyAppName,
          machineId: workspace.flyMachineId,
          state: "started",
          timeoutSeconds: WORKSPACE_READINESS_TIMEOUT_SECONDS,
        });
      }
      await this.repository.updateOperationStage({
        operationId: operation.id,
        stage: safetyRollback
          ? "platform.workspace.safety_rollback_verifying"
          : "platform.workspace.verifying",
      });
      await this.provider.waitForMachineHealth({
        appName: environment.flyAppName,
        machineId: workspace.flyMachineId,
        checkName: "workspace",
        timeoutSeconds: WORKSPACE_READINESS_TIMEOUT_SECONDS,
      });
    } catch (error) {
      if (
        targetGeneration !== null &&
        !safetyRollback &&
        hasErrorCode(error, "FLY_MACHINE_UNHEALTHY") &&
        priorImage &&
        priorImage !== runtimeImage
      ) {
        if (!this.repository.prepareSafetyRollback) {
          throw operationError(
            "PLATFORM_RUNTIME_ROLLBACK_UNAVAILABLE",
            "Safety rollback persistence is unavailable.",
          );
        }
        await this.repository.prepareSafetyRollback({
          operationId: operation.id,
          imageField: "runtimeImage",
          priorImage,
          rejectedImage: runtimeImage,
        });
        throw new EnvironmentProviderError(
          "FLY_PROVIDER_UNAVAILABLE",
          "The desired Workspace image failed health verification; safety rollback is pending.",
        );
      }
      throw error;
    }
    const currentEnvironment = await this.repository.getEnvironment(
      environment.id,
    );
    if (
      targetGeneration !== null &&
      currentEnvironment?.targetGeneration !== targetGeneration
    ) {
      await this.completeSupersededOperation(operation);
      return;
    }
    await this.repository.completeWorkspaceRebuild({
      workspaceId: workspace.id,
      runtimeImage,
    });
    if (safetyRollback && targetGeneration !== null) {
      const rejectedImage = readInputString(operation.input, "rejectedImage");
      const message = `Workspace image ${rejectedImage ?? "unknown"} failed health verification and was rolled back.`;
      await this.repository.rejectPlatformGeneration?.({
        environmentId: environment.id,
        targetGeneration,
        code: "PLATFORM_RUNTIME_WORKSPACE_HEALTH_REJECTED",
        message,
      });
      await this.repository.failOperation({
        operationId: operation.id,
        stage: "platform.workspace.rolled_back",
        code: "PLATFORM_RUNTIME_WORKSPACE_HEALTH_REJECTED",
        message,
      });
      return;
    }
    await this.repository.completeOperation({
      operationId: operation.id,
      stage:
        targetGeneration === null
          ? "environment.activation.ready"
          : "platform.workspace.ready",
      result: {
        machineId: workspace.flyMachineId,
        runtimeImage,
        ...(targetGeneration === null ? {} : { targetGeneration }),
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
            routerImage: true,
            runtimeImage: true,
            targetRouterImage: true,
            targetRuntimeImage: true,
            targetSourceRevision: true,
            targetGeneration: true,
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
            createdByUserId: true,
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
            createdByUserId: value.createdByUserId,
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
    async countActiveEnvironmentExecutions(environmentId) {
      const rows = await knowledgeDb
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.environmentRunExecutions)
        .where(
          and(
            eq(schema.environmentRunExecutions.environmentId, environmentId),
            inArray(schema.environmentRunExecutions.status, [
              "routed",
              "running",
            ]),
          ),
        );
      return rows[0]?.count ?? 0;
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
          .returning({ id: schema.environmentOperations.id });
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
            stage: "environment.activation.failed",
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
    async markWorkspaceReleaseVerified(input) {
      const { markWorkspaceReleaseVerified } =
        await import("@/lib/releases/runtime");
      await markWorkspaceReleaseVerified(input);
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
      await knowledgeDb
        .update(schema.environmentOperations)
        .set({
          status: "failed",
          stage: input.stage,
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
            ...(input.retryState
              ? {
                  result: {
                    ...(current?.result ?? {}),
                    retryState: input.retryState,
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
        const releaseTargetId = readInputString(
          operation?.input,
          "releaseTargetId",
        );
        if (releaseTargetId && input.retryState) {
          const target =
            await transaction.query.flyImageReleaseTargets.findFirst({
              where: (table, { eq }) => eq(table.id, releaseTargetId),
              columns: { result: true },
            });
          await transaction
            .update(schema.flyImageReleaseTargets)
            .set({
              status: "applying",
              stage: "environment.provider.retrying",
              result: {
                ...(target?.result ?? {}),
                retryAttempt: input.retryState.attempt,
                firstFailureAt: input.retryState.firstFailureAt,
                lastProviderResponse: input.retryState.lastError,
                nextAttemptAt: input.retryState.nextAttemptAt,
                authoritativeState: input.retryState.authoritativeState,
              },
              updatedAt: new Date(),
            })
            .where(eq(schema.flyImageReleaseTargets.id, releaseTargetId));
        }
      });
    },
    async prepareSafetyRollback(input) {
      const operation =
        await knowledgeDb.query.environmentOperations.findFirst({
          where: (table, { eq }) => eq(table.id, input.operationId),
          columns: { input: true },
        });
      await knowledgeDb
        .update(schema.environmentOperations)
        .set({
          input: {
            ...(operation?.input ?? {}),
            [input.imageField]: input.priorImage,
            rejectedImage: input.rejectedImage,
            safetyRollback: true,
          },
          stage: "platform.resource.safety_rollback_pending",
          updatedAt: new Date(),
        })
        .where(eq(schema.environmentOperations.id, input.operationId));
    },
    async rejectPlatformGeneration(input) {
      const now = new Date();
      const settings =
        await knowledgeDb.query.platformRuntimeSettings.findFirst({
          where: eq(schema.platformRuntimeSettings.id, "platform"),
          columns: { canaryEnvironmentId: true },
        });
      await knowledgeDb
        .update(schema.platformRuntimeSettings)
        .set({
          status:
            settings?.canaryEnvironmentId === input.environmentId
              ? "rejected"
              : "degraded",
          lastFailureCode: input.code,
          lastFailureMessage: input.message,
          lastFailureAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.platformRuntimeSettings.id, "platform"),
            eq(schema.platformRuntimeSettings.generation, input.targetGeneration),
          ),
        );
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

function readImmutableImage(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !/^registry\.fly\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u.test(
      value,
    )
  ) {
    throw operationError(
      "ENVIRONMENT_IMAGE_INVALID",
      `${label} must use an immutable registry.fly.io sha256 digest.`,
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

function readInputNumber(value: unknown, key: string) {
  const candidate = asRecord(value)?.[key];
  return typeof candidate === "number" && Number.isSafeInteger(candidate)
    ? candidate
    : null;
}

function readRequiredGeneration(value: unknown) {
  const generation = readInputNumber(value, "targetGeneration");
  if (generation === null || generation < 1) {
    throw operationError(
      "PLATFORM_RUNTIME_GENERATION_INVALID",
      "Platform runtime operation requires a positive target generation.",
    );
  }
  return generation;
}

function readOptionalImmutableImage(value: unknown, label: string) {
  if (value === undefined || value === null) return null;
  return readImmutableImage(value, label);
}

function boundedRetryTime(input: {
  attempt: number;
  retryDeadline: string | null;
  budgetNextAttemptAt: string | null;
}) {
  const scheduled =
    input.budgetNextAttemptAt ??
    new Date(
      Date.now() + releaseRetryDelaySeconds(input.attempt) * 1000,
    ).toISOString();
  if (!input.retryDeadline) return scheduled;
  return new Date(
    Math.min(Date.parse(scheduled), Date.parse(input.retryDeadline)),
  ).toISOString();
}

type EnvironmentUpdateCheckpoint = {
  gatewayVerified: boolean;
  backedUpWorkspaceIds: string[];
  verifiedWorkspaceIds: string[];
  configuredStoppedWorkspaceIds: string[];
};

function readEnvironmentUpdateCheckpoint(
  result: unknown,
): EnvironmentUpdateCheckpoint {
  const checkpoint = asRecord(asRecord(result)?.environmentUpdateCheckpoint);
  return {
    gatewayVerified: checkpoint?.gatewayVerified === true,
    backedUpWorkspaceIds: readStringArray(
      checkpoint?.backedUpWorkspaceIds,
    ),
    verifiedWorkspaceIds: readStringArray(checkpoint?.verifiedWorkspaceIds),
    configuredStoppedWorkspaceIds: readStringArray(
      checkpoint?.configuredStoppedWorkspaceIds,
    ),
  };
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is string =>
        typeof candidate === "string",
      )
    : [];
}

function readAuthoritativeState(error: unknown) {
  return asRecord(error)?.authoritativeState;
}
