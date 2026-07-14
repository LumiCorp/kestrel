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
import {
  type EnvironmentInfrastructureProvider,
  EnvironmentProviderError,
} from "./providers/contracts";
import {
  flyEnvironmentAppName,
  flyEnvironmentNetworkName,
} from "./providers/fly-machines";

export type ProvisioningOperation = {
  id: string;
  organizationId: string;
  environmentId: string;
  workspaceId: string | null;
  type: string;
};

export interface EnvironmentProvisioningRepository {
  claimOperation(operationId: string): Promise<ProvisioningOperation | null>;
  getEnvironment(environmentId: string): Promise<{
    id: string;
    organizationId: string;
    region: string;
    status: string;
    flyAppName: string | null;
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
  setEnvironmentProvisioning(environmentId: string): Promise<void>;
  setEnvironmentDeleting(environmentId: string): Promise<void>;
  completeEnvironment(input: {
    environmentId: string;
    appName: string;
    networkName: string;
    gatewayMachineId: string;
    routerUrl: string;
    routerImage: string;
    runtimeImage: string;
  }): Promise<void>;
  failEnvironment(input: {
    environmentId: string;
    code: string;
    message: string;
  }): Promise<void>;
  completeEnvironmentDelete(environmentId: string): Promise<void>;
  setWorkspaceProvisioning(workspaceId: string): Promise<void>;
  completeWorkspace(input: {
    workspaceId: string;
    volumeId: string;
    machineId: string;
    runtimeImage: string;
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
  }): Promise<void>;
  updateOperationStage(input: {
    operationId: string;
    stage: string;
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
  private readonly credentialBrokerToken: string;

  constructor(input: {
    repository: EnvironmentProvisioningRepository;
    provider: EnvironmentInfrastructureProvider;
    runtimeImage: string;
    routerImage: string;
    ticketPublicKey: string;
    controlPlaneUrl: string;
    credentialBrokerToken: string;
  }) {
    const {
      repository,
      provider,
      runtimeImage,
      routerImage,
      ticketPublicKey,
      controlPlaneUrl,
      credentialBrokerToken,
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
    if (!credentialBrokerToken.trim()) {
      throw new Error("Gateway credential broker token is not configured.");
    }
    this.repository = repository;
    this.provider = provider;
    this.runtimeImage = runtimeImage;
    this.routerImage = routerImage;
    this.ticketPublicKey = ticketPublicKey;
    this.controlPlaneUrl = controlPlaneUrl;
    this.credentialBrokerToken = credentialBrokerToken;
  }

  async process(
    operationId: string
  ): Promise<"processed" | "not_claimed" | "deferred"> {
    const operation = await this.repository.claimOperation(operationId);
    if (!operation) return "not_claimed";
    try {
      if (operation.type === "environment.provision") {
        await this.provisionEnvironment(operation);
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
    const gateway = await this.provider.ensureEnvironmentGateway({
      appName,
      environmentId: environment.id,
      region: environment.region,
      runtimeImage: this.routerImage,
      ticketPublicKey: this.ticketPublicKey,
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
    const volume = await this.provider.ensureWorkspaceVolume({
      appName: environment.flyAppName,
      workspaceId: workspace.id,
      region: environment.region,
    });
    await this.repository.updateOperationStage({
      operationId: operation.id,
      stage: "environment.machine.starting",
    });
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
      credentialBrokerToken: this.credentialBrokerToken,
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
    });
    await this.repository.completeOperation({
      operationId: operation.id,
      stage: "environment.activation.ready",
      result: { volumeId: volume.id, machineId: machine.id },
    });
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
    const machine = await this.provider.updateMachineImage({
      appName: environment.flyAppName,
      machineId: workspace.flyMachineId,
      runtimeImage: environment.runtimeImage,
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
            inArray(schema.environmentOperations.status, ["queued", "running"])
          )
        )
        .returning({
          id: schema.environmentOperations.id,
          organizationId: schema.environmentOperations.organizationId,
          environmentId: schema.environmentOperations.environmentId,
          workspaceId: schema.environmentOperations.workspaceId,
          type: schema.environmentOperations.type,
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
          lastActivityAt: now,
          lastHealthAt: now,
          updatedAt: now,
        })
        .where(eq(schema.environmentWorkspaces.id, input.workspaceId));
    },
    async updateOperationStage(input) {
      await knowledgeDb
        .update(schema.environmentOperations)
        .set({ stage: input.stage, updatedAt: new Date() })
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
