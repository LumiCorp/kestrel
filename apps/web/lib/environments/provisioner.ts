import { and, eq, inArray, sql } from "drizzle-orm";
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
} from "./providers/contracts";
import {
  flyEnvironmentAppName,
  flyEnvironmentNetworkName,
} from "./providers/fly-machines";
import {
  createEnvironmentServiceToken,
  hashEnvironmentServiceToken,
} from "./service-tokens";

export type ProvisioningOperation = {
  id: string;
  organizationId: string;
  environmentId: string;
  workspaceId: string | null;
  requestedByUserId: string | null;
  type: string;
  input: Record<string, unknown> | null;
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
    idleTimeoutMinutes: number;
  } | null>;
  getWorkspace(workspaceId: string): Promise<{
    id: string;
    organizationId: string;
    environmentId: string;
    status: string;
    flyMachineId: string | null;
    flyVolumeId: string | null;
    sourceType: "blank" | "github";
    sourceResourceId: string | null;
    sourceRepository: string | null;
    sourceDefaultBranch: string | null;
  } | null>;
  listEnvironmentWorkspaces(environmentId: string): Promise<
    Array<{
      id: string;
      flyMachineId: string | null;
      flyVolumeId: string | null;
    }>
  >;
  setEnvironmentProvisioning(environmentId: string): Promise<void>;
  stageEnvironmentGatewayIdentity(input: {
    environmentId: string;
    appName: string;
    gatewayServiceTokenHash: string;
  }): Promise<void>;
  setEnvironmentDeleting(environmentId: string): Promise<void>;
  completeEnvironment(input: {
    environmentId: string;
    appName: string;
    networkName: string;
    gatewayMachineId: string;
    routerUrl: string;
    routerImage: string;
    runtimeImage: string;
    gatewayServiceTokenHash: string;
  }): Promise<void>;
  failEnvironment(input: {
    environmentId: string;
    code: string;
    message: string;
  }): Promise<void>;
  degradeEnvironment(input: {
    environmentId: string;
    code: string;
    message: string;
  }): Promise<void>;
  completeEnvironmentGatewayUpdate(input: {
    environmentId: string;
    routerImage: string;
    gatewayServiceTokenHash: string;
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
    serviceTokenHash: string;
  }): Promise<void>;
  updateOperationStage(input: {
    operationId: string;
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
    stage: string;
    message: string;
  }): Promise<void>;
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
    operationId: string
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
          `Operation '${operation.type}' is not handled by the provisioner.`
        );
      }
      return "processed";
    } catch (error) {
      const failure = safeFailure(error);
      if (failure.code === "ENVIRONMENT_NOT_READY") {
        await this.repository.deferOperation({
          operationId: operation.id,
          stage: "environment.runtime.connecting",
          message: failure.message,
        });
        return "deferred";
      }
      if (failure.retryable) {
        await this.repository.deferOperation({
          operationId: operation.id,
          stage: "environment.provider.retrying",
          message: failure.message,
        });
        return "deferred";
      }
      if (
        failure.code === "ENVIRONMENT_IS_DEFAULT" ||
        failure.code === "ENVIRONMENT_HAS_PROJECTS"
      ) {
        await this.repository.failOperation({
          operationId: operation.id,
          stage: "environment.deletion.blocked",
          ...failure,
        });
        return "processed";
      }
      if (operation.workspaceId) {
        await this.repository.failWorkspace({
          workspaceId: operation.workspaceId,
          ...failure,
        });
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
        stage: "environment.activation.failed",
        ...failure,
      });
      return "processed";
    }
  }

  private async provisionEnvironment(operation: ProvisioningOperation) {
    const environment = await this.repository.getEnvironment(
      operation.environmentId
    );
    if (
      !environment ||
      environment.organizationId !== operation.organizationId
    ) {
      throw operationError(
        "ENVIRONMENT_NOT_FOUND",
        "Environment provisioning target is unavailable."
      );
    }
    assertEnvironmentOperationTransition(
      environmentStatusSchema.parse(environment.status),
      "provisioning"
    );
    await this.repository.setEnvironmentProvisioning(environment.id);
    const appName =
      environment.flyAppName ?? flyEnvironmentAppName(environment.id);
    const networkName = flyEnvironmentNetworkName(environment.id);
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.runtime.connecting",
    });
    await this.provider.ensureEnvironmentApp({ appName, networkName });
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.machine.starting",
    });
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
    await this.repository.stageEnvironmentGatewayIdentity({
      environmentId: environment.id,
      appName,
      gatewayServiceTokenHash: hashEnvironmentServiceToken(gateway.serviceToken),
    });
    if (gateway.state !== "started") {
      await this.provider.waitForMachine({
        appName,
        machineId: gateway.machineId,
        state: "started",
        timeoutSeconds: 60,
      });
    }
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.health.checking",
    });
    await this.provider.waitForMachineHealth({
      appName,
      machineId: gateway.machineId,
      checkName: "gateway",
      timeoutSeconds: 60,
    });
    await this.repository.completeEnvironment({
      environmentId: environment.id,
      appName,
      networkName,
      gatewayMachineId: gateway.machineId,
      routerUrl: gateway.routerUrl,
      routerImage: this.routerImage,
      runtimeImage: this.runtimeImage,
      gatewayServiceTokenHash: hashEnvironmentServiceToken(
        gateway.serviceToken
      ),
    });
    await this.repository.completeOperation({
      operationId: operation.id,
      stage: "environment.activation.ready",
      result: {
        appName,
        networkName,
        gatewayMachineId: gateway.machineId,
        routerUrl: gateway.routerUrl,
      },
    });
  }

  private async updateEnvironment(operation: ProvisioningOperation) {
    const environment = await this.repository.getEnvironment(
      operation.environmentId
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
        "Environment update target is unavailable."
      );
    }
    const runtimeImage = readImmutableImage(
      operation.input?.runtimeImage,
      "Workspace runtime image"
    );
    const routerImage = readImmutableImage(
      operation.input?.routerImage,
      "Environment router image"
    );
    const workspaces = await this.repository.listEnvironmentWorkspaces(
      environment.id
    );
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.update.backing_up",
    });
    for (const workspace of workspaces) {
      if (!(workspace.flyMachineId && workspace.flyVolumeId)) continue;
      const backupInput = {
        organizationId: operation.organizationId,
        environmentId: environment.id,
        workspaceId: workspace.id,
        actorUserId: operation.requestedByUserId,
        reason: "pre_destructive",
        idempotencyKey: `environment.update:${operation.id}:backup:${workspace.id}`,
      } as const;
      try {
        await this.backupWorkspace(backupInput);
      } catch (error) {
        if (!hasErrorCode(error, "ENVIRONMENT_ACTIVATION_TIMEOUT")) throw error;
        const preDestructiveSnapshot = await this.provider.createVolumeSnapshot({
          appName: environment.flyAppName,
          volumeId: workspace.flyVolumeId,
        });
        await this.updateWorkspaceRuntime({
          appName: environment.flyAppName,
          workspaceId: workspace.id,
          machineId: workspace.flyMachineId,
          runtimeImage,
          forceStart: true,
        });
        await this.backupWorkspace({
          ...backupInput,
          preDestructiveSnapshot,
        });
      }
    }
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.update.gateway",
    });
    const gatewayServiceToken = createEnvironmentServiceToken();
    try {
      const gateway = await this.provider.updateMachineImage({
        appName: environment.flyAppName,
        machineId: environment.flyGatewayMachineId,
        runtimeImage: routerImage,
        envPatch: {
          KESTREL_ENVIRONMENT_ID: environment.id,
          KESTREL_CONTROL_PLANE_URL: this.controlPlaneUrl,
          KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN: gatewayServiceToken,
        },
      });
      await this.repository.stageEnvironmentGatewayIdentity({
        environmentId: environment.id,
        appName: environment.flyAppName,
        gatewayServiceTokenHash: hashEnvironmentServiceToken(
          gatewayServiceToken
        ),
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
      if (environment.routerImage && environment.routerImage !== routerImage) {
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
      gatewayServiceTokenHash: hashEnvironmentServiceToken(
        gatewayServiceToken
      ),
    });
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.update.workspaces",
    });
    for (const workspace of workspaces) {
      if (!workspace.flyMachineId) continue;
      await this.updateWorkspaceRuntime({
        appName: environment.flyAppName,
        workspaceId: workspace.id,
        machineId: workspace.flyMachineId,
        runtimeImage,
      });
    }
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.update.verifying",
    });
    await this.repository.completeEnvironmentRuntimeUpdate({
      environmentId: environment.id,
      runtimeImage,
    });
    await this.repository.completeOperation({
      operationId: operation.id,
      stage: "environment.update.ready",
      result: {
        gatewayMachineId: environment.flyGatewayMachineId,
        routerImage,
        runtimeImage,
        workspaceCount: workspaces.length,
      },
    });
  }

  private async updateWorkspaceRuntime(input: {
    appName: string;
    workspaceId: string;
    machineId: string;
    runtimeImage: string;
    forceStart?: boolean | undefined;
  }) {
    await this.repository.setWorkspaceStarting(input.workspaceId);
    const workspaceServiceToken = createEnvironmentServiceToken();
    try {
      const machine = await this.provider.updateMachineImage({
        appName: input.appName,
        machineId: input.machineId,
        runtimeImage: input.runtimeImage,
        envPatch: workspaceRuntimeIdentityPatch({
          appName: input.appName,
          serviceToken: workspaceServiceToken,
        }),
      });
      if (input.forceStart && machine.state !== "stopped") {
        await this.provider.waitForMachine({
          appName: input.appName,
          machineId: input.machineId,
          state: "stopped",
          timeoutSeconds: 90,
        });
      }
      if (input.forceStart || machine.state === "stopped") {
        await this.provider.startMachine({
          appName: input.appName,
          machineId: input.machineId,
        });
      }
      if (input.forceStart || machine.state !== "started") {
        await this.provider.waitForMachine({
          appName: input.appName,
          machineId: input.machineId,
          state: "started",
          timeoutSeconds: 90,
        });
      }
      await this.provider.waitForMachineHealth({
        appName: input.appName,
        machineId: input.machineId,
        checkName: "workspace",
        timeoutSeconds: 90,
      });
      await this.repository.completeWorkspaceRebuild({
        workspaceId: input.workspaceId,
        runtimeImage: input.runtimeImage,
        serviceTokenHash: hashEnvironmentServiceToken(workspaceServiceToken),
      });
    } catch (error) {
      const failure = safeFailure(error);
      await this.repository.failWorkspace({
        workspaceId: input.workspaceId,
        code: failure.code,
        message: failure.message,
      });
      throw error;
    }
  }

  private async provisionWorkspace(operation: ProvisioningOperation) {
    if (!operation.workspaceId) {
      throw operationError(
        "WORKSPACE_NOT_FOUND",
        "Workspace provisioning operation has no Workspace."
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
        "Workspace provisioning target is unavailable."
      );
    }
    if (environment.status !== "ready" || !environment.flyAppName) {
      throw operationError(
        "ENVIRONMENT_NOT_READY",
        "Environment must be ready before its Workspace can be provisioned."
      );
    }
    assertWorkspaceOperationTransition(
      workspaceStatusSchema.parse(workspace.status),
      "provisioning"
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
          ...(workspace.sourceResourceId ? { resourceId: workspace.sourceResourceId } : {}),
          ...(workspace.sourceRepository ? { repository: workspace.sourceRepository } : {}),
          ...(workspace.sourceDefaultBranch ? { defaultBranch: workspace.sourceDefaultBranch } : {}),
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
          timeoutSeconds: 60,
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
        timeoutSeconds: 60,
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
        result: { volumeId: volume.id, machineId: machine.id, runtimeContractRevision: 2 },
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
        "Workspace start target is unavailable."
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
        "Workspace start target is unavailable."
      );
    }
    assertWorkspaceOperationTransition(
      workspaceStatusSchema.parse(workspace.status),
      "starting"
    );
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
      timeoutSeconds: 60,
    });
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.health.checking",
    });
    await this.provider.waitForMachineHealth({
      appName: environment.flyAppName,
      machineId: workspace.flyMachineId,
      checkName: "workspace",
      timeoutSeconds: 60,
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
        "Workspace stop target is unavailable."
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
        "Workspace stop target is unavailable."
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
        "Workspace deletion target is unavailable."
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
        "Workspace deletion target is unavailable."
      );
    }
    assertWorkspaceOperationTransition(
      workspaceStatusSchema.parse(workspace.status),
      "deleting"
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
      operation.environmentId
    );
    if (
      !environment ||
      environment.organizationId !== operation.organizationId
    ) {
      throw operationError(
        "ENVIRONMENT_NOT_FOUND",
        "Environment deletion target is unavailable."
      );
    }
    assertEnvironmentOperationTransition(
      environmentStatusSchema.parse(environment.status),
      "deleting"
    );
    await this.repository.setEnvironmentDeleting(environment.id);
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
        "Workspace rebuild target is unavailable."
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
        "Workspace rebuild target is unavailable."
      );
    }
    assertWorkspaceOperationTransition(
      workspaceStatusSchema.parse(workspace.status),
      "starting"
    );
    await this.repository.setWorkspaceStarting(workspace.id);
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.machine.starting",
    });
    const workspaceServiceToken = createEnvironmentServiceToken();
    const machine = await this.provider.updateMachineImage({
      appName: environment.flyAppName,
      machineId: workspace.flyMachineId,
      runtimeImage: environment.runtimeImage,
      envPatch: workspaceRuntimeIdentityPatch({
        appName: environment.flyAppName,
        serviceToken: workspaceServiceToken,
      }),
    });
    if (machine.state !== "started") {
      await this.provider.waitForMachine({
        appName: environment.flyAppName,
        machineId: workspace.flyMachineId,
        state: "started",
        timeoutSeconds: 90,
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
      timeoutSeconds: 90,
    });
    await this.repository.completeWorkspaceRebuild({
      workspaceId: workspace.id,
      runtimeImage: environment.runtimeImage,
      serviceTokenHash: hashEnvironmentServiceToken(workspaceServiceToken),
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
              PROVISIONER_OPERATION_TYPES
            )
          )
        )
        .returning({
          id: schema.environmentOperations.id,
          organizationId: schema.environmentOperations.organizationId,
          environmentId: schema.environmentOperations.environmentId,
          workspaceId: schema.environmentOperations.workspaceId,
          requestedByUserId: schema.environmentOperations.requestedByUserId,
          type: schema.environmentOperations.type,
          input: schema.environmentOperations.input,
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
            sourceType: true,
            sourceResourceId: true,
            sourceRepository: true,
            sourceDefaultBranch: true,
          },
        })
        .then((value) => value ?? null);
    },
    listEnvironmentWorkspaces(environmentId) {
      return knowledgeDb.query.environmentWorkspaces.findMany({
        where: (table, { and, eq, isNull }) =>
          and(eq(table.environmentId, environmentId), isNull(table.deletedAt)),
        columns: {
          id: true,
          flyMachineId: true,
          flyVolumeId: true,
        },
      });
    },
    async setEnvironmentProvisioning(environmentId) {
      await knowledgeDb
        .update(schema.environments)
        .set({
          status: "provisioning",
          failureCode: null,
          failureMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.environments.id, environmentId));
    },
    async stageEnvironmentGatewayIdentity(input) {
      await knowledgeDb
        .update(schema.environments)
        .set({
          flyAppName: input.appName,
          gatewayServiceTokenHash: input.gatewayServiceTokenHash,
          updatedAt: new Date(),
        })
        .where(eq(schema.environments.id, input.environmentId));
    },
    async setEnvironmentDeleting(environmentId) {
      await knowledgeDb.transaction(async (transaction) => {
        await transaction.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(environmentId)}, 0))`
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
            "Environment deletion target is unavailable."
          );
        }
        if (environment.isDefault) {
          throw operationError(
            "ENVIRONMENT_IS_DEFAULT",
            "Select another default Environment before deleting this Environment."
          );
        }
        const project = await transaction.query.projects.findFirst({
          where: (table, { eq }) => eq(table.environmentId, environmentId),
          columns: { id: true },
        });
        if (project) {
          throw operationError(
            "ENVIRONMENT_HAS_PROJECTS",
            "Move every Project to another Environment before deleting this Environment."
          );
        }
        const [deployment, gateway] = await Promise.all([
          transaction.query.aiDeployments.findFirst({
            where: (table, { and, eq, isNull }) =>
              and(
                eq(table.environmentId, environmentId),
                isNull(table.deletedAt)
              ),
            columns: { id: true },
          }),
          transaction.query.aiGateways.findFirst({
            where: (table, { eq }) => eq(table.environmentId, environmentId),
            columns: { id: true },
          }),
        ]);
        if (deployment || gateway) {
          throw operationError(
            "ENVIRONMENT_HAS_PRIVATE_INFERENCE",
            "Remove private inference before deleting this Environment."
          );
        }
      });
    },
    async completeEnvironment(input) {
      await knowledgeDb
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
          lastHealthAt: new Date(),
          failureCode: null,
          failureMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.environments.id, input.environmentId));
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
          gatewayServiceTokenHash: input.gatewayServiceTokenHash,
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
            eq(schema.threadExecutionBindings.environmentId, environmentId)
          );
        await transaction
          .delete(schema.projectEnvironmentBindings)
          .where(
            eq(schema.projectEnvironmentBindings.environmentId, environmentId)
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
                workspace.projectId
              )
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
          serviceTokenHash: input.serviceTokenHash,
          lastActivityAt: now,
          lastHealthAt: now,
          updatedAt: now,
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
            eq(schema.environmentOperations.status, "running")
          )
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
      await knowledgeDb
        .update(schema.environmentOperations)
        .set({
          status: "queued",
          stage: input.stage,
          errorCode: null,
          errorMessage: input.message,
          updatedAt: new Date(),
        })
        .where(eq(schema.environmentOperations.id, input.operationId));
    },
  };

function operationError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
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
    await input.provider.deleteMachine({
      appName: input.appName,
      machineId: input.machineId,
    }).catch((error) => failures.push(error instanceof Error ? error.message : "machine cleanup failed"));
  }
  if (input.volumeId) {
    await input.provider.deleteVolume({
      appName: input.appName,
      volumeId: input.volumeId,
    }).catch((error) => failures.push(error instanceof Error ? error.message : "volume cleanup failed"));
  }
  if (failures.length > 0) {
    console.error("Workspace provisioning cleanup failed.", {
      operationId: input.operationId,
      resourceFailureCount: failures.length,
      messages: failures.map((message) => message.slice(0, 300)),
    });
  }
}

function workspaceRuntimeIdentityPatch(input: {
  appName: string;
  serviceToken: string;
}) {
  return {
    KESTREL_ENVIRONMENT_GATEWAY_URL: `https://${input.appName}.fly.dev`,
    KESTREL_WORKSPACE_SERVICE_TOKEN: input.serviceToken,
    KESTREL_ONE_CREDENTIAL_BROKER_TOKEN: undefined,
  };
}

function readImmutableImage(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !/^registry\.fly\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u.test(
      value
    )
  ) {
    throw operationError(
      "ENVIRONMENT_IMAGE_INVALID",
      `${label} must use an immutable registry.fly.io sha256 digest.`
    );
  }
  return value;
}

function assertEnvironmentOperationTransition(
  current: Parameters<typeof assertEnvironmentTransition>[0],
  next: Parameters<typeof assertEnvironmentTransition>[1]
) {
  if (current !== next) assertEnvironmentTransition(current, next);
}

function assertWorkspaceOperationTransition(
  current: Parameters<typeof assertWorkspaceTransition>[0],
  next: Parameters<typeof assertWorkspaceTransition>[1]
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
          error.status === 412 ||
          error.status === 429 ||
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
