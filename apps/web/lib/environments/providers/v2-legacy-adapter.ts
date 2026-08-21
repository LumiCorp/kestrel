import {
  type EnvironmentInfrastructureProvider,
  EnvironmentProviderError,
  type EnvironmentProviderMachine,
  REQUIRED_ENVIRONMENT_PROVIDER_CAPABILITIES,
  type WorkspaceMachineProvisioningInput,
} from "./contracts";
import {
  type EnvironmentInfrastructureProviderV2,
  EnvironmentProviderErrorV2,
  type EnvironmentResourceRef,
  type WorkspaceComputeStateV2,
  type EnvironmentProviderKind,
} from "./contracts-v2";
import { createEnvironmentServiceToken } from "../service-tokens";

export class EnvironmentInfrastructureProviderV2LegacyAdapter
  implements EnvironmentInfrastructureProvider
{
  private gatewayExternalId: string | null;
  readonly descriptor = {
    id: this.provider.descriptor.provider,
    label: this.provider.descriptor.label,
    capabilities: REQUIRED_ENVIRONMENT_PROVIDER_CAPABILITIES,
    evidence: this.provider.descriptor.evidenceLevel,
  } as const;

  constructor(
    private readonly provider: EnvironmentInfrastructureProviderV2,
    private readonly context: {
      connectionId: string;
      provider: EnvironmentProviderKind;
      organizationId: string;
      environmentId: string;
      workspaceId?: string | undefined;
      gatewayExternalId?: string | null | undefined;
    },
  ) {
    this.gatewayExternalId = context.gatewayExternalId ?? null;
  }

  async ensureEnvironmentApp(input: {
    environmentId?: string | undefined;
    appName: string;
    networkName: string;
  }) {
    return this.translate(async () => {
      const identity = this.environmentIdentity(input.environmentId ?? input.appName);
      const scope = await this.provider.ensureEnvironmentScope({
        identity,
        placement: placement(this.context.connectionId),
      });
      return {
        id: scope.resource.externalId,
        name: scope.resource.externalId,
        organizationSlug: identity.organizationId,
        network: input.networkName,
      };
    });
  }

  async ensureEnvironmentGateway(
    input: Parameters<EnvironmentInfrastructureProvider["ensureEnvironmentGateway"]>[0],
  ) {
    return this.translate(async () => {
      const gateway = await this.provider.ensureEnvironmentGateway({
        identity: this.environmentIdentity(input.environmentId),
        scope: this.ref("environment_scope", input.appName),
        placement: placement(this.context.connectionId, input.region),
        runtimeImage: input.runtimeImage,
        ticketPublicKey: input.ticketPublicKey,
        controlPlaneUrl: input.controlPlaneUrl,
        serviceToken: input.serviceToken ?? "",
      });
      this.gatewayExternalId = gateway.resource.externalId;
      return {
        machineId: gateway.resource.externalId,
        state: gateway.state,
        region: observedLocation(gateway.placement, input.region),
        routerUrl: gateway.routerUrl,
        sharedIp: gateway.edgeRoute.externalId,
        serviceToken: input.serviceToken ?? "",
      };
    });
  }

  async ensureWorkspaceVolume(
    input: Parameters<EnvironmentInfrastructureProvider["ensureWorkspaceVolume"]>[0],
  ) {
    return this.translate(async () => {
      const storage = await this.provider.ensureWorkspaceStorage({
        identity: this.workspaceIdentity(input.workspaceId),
        scope: this.ref("environment_scope", input.appName),
        placement: placement(this.context.connectionId, input.region),
      });
      return {
        id: storage.resource.externalId,
        name: storage.resource.externalId,
        region: observedLocation(storage.placement, input.region),
        sizeGb: storage.sizeGb,
        encrypted: true as const,
      };
    });
  }

  async ensureWorkspaceMachine(input: WorkspaceMachineProvisioningInput) {
    return this.translate(async () =>
      legacyMachine(
        await this.provider.ensureWorkspaceCompute(
          this.computeInput(input),
        ),
      ),
    );
  }

  async createReplacementWorkspaceVolume(
    input: Parameters<EnvironmentInfrastructureProvider["createReplacementWorkspaceVolume"]>[0],
  ) {
    return this.translate(async () => {
      const storage = await this.provider.createReplacementWorkspaceStorage({
        identity: this.workspaceIdentity(input.workspaceId),
        scope: this.ref("environment_scope", input.appName),
        placement: placement(this.context.connectionId, input.region),
        replacementId: input.replacementId,
        sourceStorage: input.sourceVolumeId
          ? this.ref("workspace_storage", input.sourceVolumeId)
          : undefined,
        snapshot: input.snapshotId
          ? this.ref("snapshot", input.snapshotId)
          : undefined,
      });
      return {
        id: storage.resource.externalId,
        name: storage.resource.externalId,
        region: observedLocation(storage.placement, input.region),
        sizeGb: storage.sizeGb,
        encrypted: true as const,
      };
    });
  }

  async isWorkspaceSnapshotUsable(
    input: Parameters<EnvironmentInfrastructureProvider["isWorkspaceSnapshotUsable"]>[0],
  ) {
    return this.translate(() =>
      this.provider.isWorkspaceSnapshotUsable({
        identity: this.workspaceIdentity(input.sourceVolumeId),
        scope: this.ref("environment_scope", input.appName),
        storage: this.ref("workspace_storage", input.sourceVolumeId),
        snapshot: this.ref("snapshot", input.snapshotId),
      }),
    );
  }

  async createReplacementWorkspaceMachine(
    input: WorkspaceMachineProvisioningInput & { replacementId: string },
  ) {
    return this.translate(async () =>
      legacyMachine(
        await this.provider.createReplacementWorkspaceCompute({
          ...this.computeInput(input),
          replacementId: input.replacementId,
        }),
      ),
    );
  }

  async getMachine(
    input: Parameters<EnvironmentInfrastructureProvider["getMachine"]>[0],
  ) {
    return this.translate(async () => {
      const machine = await this.provider.getWorkspaceCompute({
        identity: this.workspaceIdentity(input.machineId),
        scope: this.ref("environment_scope", input.appName),
        compute: this.ref("workspace_compute", input.machineId),
      });
      return machine ? legacyMachine(machine) : null;
    });
  }

  async startMachine(
    input: Parameters<EnvironmentInfrastructureProvider["startMachine"]>[0],
  ) {
    if (input.machineId === this.gatewayExternalId) return;
    return this.translate(() =>
      this.provider.startWorkspaceCompute(this.computeReferenceInput(input)),
    );
  }

  async stopMachine(
    input: Parameters<EnvironmentInfrastructureProvider["stopMachine"]>[0],
  ) {
    if (input.machineId === this.gatewayExternalId) return;
    return this.translate(() =>
      this.provider.stopWorkspaceCompute(this.computeReferenceInput(input)),
    );
  }

  async deleteMachine(
    input: Parameters<EnvironmentInfrastructureProvider["deleteMachine"]>[0],
  ) {
    return this.translate(() =>
      this.provider.deleteWorkspaceCompute(this.computeReferenceInput(input)),
    );
  }

  async deleteVolume(
    input: Parameters<EnvironmentInfrastructureProvider["deleteVolume"]>[0],
  ) {
    return this.translate(() =>
      this.provider.deleteWorkspaceStorage({
        identity: this.workspaceIdentity(input.volumeId),
        scope: this.ref("environment_scope", input.appName),
        storage: this.ref("workspace_storage", input.volumeId),
      }),
    );
  }

  async deleteEnvironmentApp(
    input: Parameters<EnvironmentInfrastructureProvider["deleteEnvironmentApp"]>[0],
  ) {
    return this.translate(() =>
      this.provider.deleteEnvironmentScope({
        identity: this.environmentIdentity(input.appName),
        scope: this.ref("environment_scope", input.appName),
      }),
    );
  }

  async listEnvironmentResources(
    input: Parameters<EnvironmentInfrastructureProvider["listEnvironmentResources"]>[0],
  ) {
    return this.translate(async () => {
      const inventory = await this.provider.listEnvironmentResources({
        identity: this.environmentIdentity(input.appName),
        scope: this.ref("environment_scope", input.appName),
      });
      return {
        resources: inventory.resources.map((resource) => ({
          role: resource.ref.role,
          externalId: resource.ref.externalId,
          workspaceId: resource.workspaceId,
          replacementId: resource.replacementId,
          state: resource.state,
        })),
        machines: inventory.resources
          .filter((resource) => resource.ref.role === "workspace_compute")
          .map((resource) => ({
            id: resource.ref.externalId,
            state: resource.state ?? undefined,
            workspaceId: resource.workspaceId,
            replacementId: resource.replacementId,
            mountedVolumeIds: resource.relatedResources
              .filter((related) => related.role === "workspace_storage")
              .map((related) => related.externalId),
          })),
        volumes: inventory.resources
          .filter((resource) => resource.ref.role === "workspace_storage")
          .map((resource) => ({
            id: resource.ref.externalId,
            name: resource.ref.externalId,
            attachedMachineId:
              resource.relatedResources.find(
                (related) => related.role === "workspace_compute",
              )?.externalId ?? null,
          })),
      };
    });
  }

  async waitForMachine(
    input: Parameters<EnvironmentInfrastructureProvider["waitForMachine"]>[0],
  ) {
    if (input.machineId === this.gatewayExternalId) return;
    return this.translate(() =>
      this.provider.waitForWorkspaceState({
        ...this.computeReferenceInput(input),
        state: input.state,
        timeoutSeconds: input.timeoutSeconds,
      }),
    );
  }

  async waitForMachineHealth(
    input: Parameters<EnvironmentInfrastructureProvider["waitForMachineHealth"]>[0],
  ) {
    if (input.machineId === this.gatewayExternalId) return;
    return this.translate(() =>
      this.provider.waitForWorkspaceHealth({
        ...this.computeReferenceInput(input),
        checkName: input.checkName,
        timeoutSeconds: input.timeoutSeconds,
      }),
    );
  }

  async createVolumeSnapshot(
    input: Parameters<EnvironmentInfrastructureProvider["createVolumeSnapshot"]>[0],
  ) {
    return this.translate(async () => {
      const snapshot = await this.provider.createWorkspaceSnapshot({
        identity: this.workspaceIdentity(input.volumeId),
        scope: this.ref("environment_scope", input.appName),
        storage: this.ref("workspace_storage", input.volumeId),
      });
      return { id: snapshot.resource.externalId, state: snapshot.state };
    });
  }

  async updateMachineImage(
    input: Parameters<EnvironmentInfrastructureProvider["updateMachineImage"]>[0],
  ) {
    if (input.machineId === this.gatewayExternalId) {
      return this.translate(async () => {
        const serviceToken = createEnvironmentServiceToken();
        const gateway = await this.provider.ensureEnvironmentGateway({
          identity: this.environmentIdentity(),
          scope: this.ref("environment_scope", input.appName),
          placement: placement(this.context.connectionId),
          runtimeImage: input.runtimeImage,
          ticketPublicKey:
            process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
          controlPlaneUrl: process.env.KESTREL_ONE_APP_URL ?? "",
          serviceToken,
        });
        this.gatewayExternalId = gateway.resource.externalId;
        return {
          id: gateway.resource.externalId,
          state: gateway.state,
          region:
            gateway.placement.observed?.location ??
            gateway.placement.requested?.location ??
            "cluster",
          image: input.runtimeImage,
          serviceToken,
        } as EnvironmentProviderMachine & { serviceToken: string };
      });
    }
    return this.translate(async () =>
      legacyMachine(
        await this.provider.updateWorkspaceImage({
        identity: this.workspaceIdentity(input.machineId),
        scope: this.ref("environment_scope", input.appName),
        compute: this.ref("workspace_compute", input.machineId),
          runtimeImage: input.runtimeImage,
          environmentPatch: input.envPatch,
          stopConfig: input.stopConfig,
        }),
      ),
    );
  }

  private async translate<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof EnvironmentProviderErrorV2)) throw error;
      throw legacyError(error, this.context.provider);
    }
  }

  private environmentIdentity(environmentId = this.context.environmentId) {
    return {
      organizationId: this.context.organizationId,
      environmentId:
        environmentId === this.context.environmentId
          ? environmentId
          : this.context.environmentId,
    };
  }

  private workspaceIdentity(workspaceId: string) {
    return {
      ...this.environmentIdentity(),
      workspaceId: this.context.workspaceId ?? workspaceId,
    };
  }

  private ref(role: EnvironmentResourceRef["role"], externalId: string) {
    return { provider: this.context.provider, role, externalId } as const;
  }

  private computeInput(input: WorkspaceMachineProvisioningInput) {
    return {
      identity: {
        organizationId: this.context.organizationId,
        environmentId: this.context.environmentId,
        workspaceId: input.workspaceId,
      },
      scope: this.ref("environment_scope", input.appName),
      storage: this.ref("workspace_storage", input.volumeId),
      placement: placement(this.context.connectionId, input.region),
      desired: {
        runtimeImage: input.runtimeImage,
        ticketPublicKey: input.ticketPublicKey,
        controlPlaneUrl: input.controlPlaneUrl,
        serviceToken: input.serviceToken,
        source: input.source,
        idleTimeoutMinutes: input.idleTimeoutMinutes,
      },
    };
  }

  private computeReferenceInput(input: { appName: string; machineId: string }) {
    return {
      identity: this.workspaceIdentity(input.machineId),
      scope: this.ref("environment_scope", input.appName),
      compute: this.ref("workspace_compute", input.machineId),
    };
  }
}

function placement(connectionId: string, location?: string) {
  return {
    connectionId,
    requested: location ? { location } : null,
    observed: null,
  };
}

function observedLocation(
  value: { observed: Record<string, string> | null },
  fallback: string,
) {
  return value.observed?.location ?? fallback;
}


function legacyMachine(
  machine: WorkspaceComputeStateV2,
): EnvironmentProviderMachine {
  return {
    id: machine.resource.externalId,
    state: machine.state,
    region: machine.placement.observed?.location ?? "unknown",
    image: machine.image ?? undefined,
    resolvedImageDigest: machine.resolvedImageDigest ?? undefined,
    instanceId: machine.resource.observedGeneration,
    cpuKind: machine.cpuKind ?? undefined,
    cpus: machine.cpus ?? undefined,
    memoryMb: machine.memoryMb ?? undefined,
    workspaceId: machine.workspaceId ?? undefined,
    standbyForMachineIds: machine.standbyFor.map(
      (standby) => standby.externalId,
    ),
    mounts: machine.storage.map((storage) => ({
      volumeId: storage.externalId,
      path: "/workspace",
    })),
  };
}

function legacyError(
  error: EnvironmentProviderErrorV2,
  provider: EnvironmentProviderKind,
) {
  const code = {
    PROVIDER_NOT_CONFIGURED: "FLY_PROVIDER_NOT_CONFIGURED",
    PROVIDER_UNAVAILABLE: "FLY_PROVIDER_UNAVAILABLE",
    PROVIDER_REJECTED: "FLY_PROVIDER_REJECTED",
    RESOURCE_CONFLICT: "FLY_RESOURCE_CONFLICT",
    RESPONSE_INVALID: "FLY_RESPONSE_INVALID",
    RESOURCE_UNHEALTHY: "FLY_MACHINE_UNHEALTHY",
    CAPABILITY_UNSUPPORTED: "FLY_PROVIDER_REJECTED",
    OPERATION_TIMEOUT: "FLY_PROVIDER_UNAVAILABLE",
  }[error.code] as EnvironmentProviderError["code"];
  const legacy = new EnvironmentProviderError(code, error.message, {
    status: error.evidence.httpStatus,
    phase: error.evidence.phase,
    requestId: error.evidence.providerRequestId,
    providerDetail: error.evidence.detail,
  });
  return error.reconciliationState
    ? Object.assign(legacy, {
        ...(provider === "kubernetes" ? { providerCode: error.code } : {}),
        authoritativeState: {
          machineId: error.reconciliationState.resource?.externalId,
          state: error.reconciliationState.state,
          image: error.reconciliationState.image,
        },
      })
    : provider === "kubernetes"
      ? Object.assign(legacy, { providerCode: error.code })
      : legacy;
}
