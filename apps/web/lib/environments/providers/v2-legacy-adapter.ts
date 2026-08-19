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
} from "./contracts-v2";

export class EnvironmentInfrastructureProviderV2LegacyAdapter
  implements EnvironmentInfrastructureProvider
{
  readonly descriptor = {
    id: this.provider.descriptor.provider,
    label: this.provider.descriptor.label,
    capabilities: REQUIRED_ENVIRONMENT_PROVIDER_CAPABILITIES,
    evidence: this.provider.descriptor.evidenceLevel,
  } as const;

  constructor(
    private readonly provider: EnvironmentInfrastructureProviderV2,
    private readonly connectionId: string,
  ) {}

  async ensureEnvironmentApp(input: {
    environmentId?: string | undefined;
    appName: string;
    networkName: string;
  }) {
    return this.translate(async () => {
      const identity = environmentIdentity(input.environmentId ?? input.appName);
      const scope = await this.provider.ensureEnvironmentScope({
        identity,
        placement: placement(this.connectionId),
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
        identity: environmentIdentity(input.environmentId),
        scope: ref("environment_scope", input.appName),
        placement: placement(this.connectionId, input.region),
        runtimeImage: input.runtimeImage,
        ticketPublicKey: input.ticketPublicKey,
        controlPlaneUrl: input.controlPlaneUrl,
        serviceToken: input.serviceToken ?? "",
      });
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
        identity: workspaceIdentity(input.appName, input.workspaceId),
        scope: ref("environment_scope", input.appName),
        placement: placement(this.connectionId, input.region),
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
          computeInput(this.connectionId, input),
        ),
      ),
    );
  }

  async createReplacementWorkspaceVolume(
    input: Parameters<EnvironmentInfrastructureProvider["createReplacementWorkspaceVolume"]>[0],
  ) {
    return this.translate(async () => {
      const storage = await this.provider.createReplacementWorkspaceStorage({
        identity: workspaceIdentity(input.appName, input.workspaceId),
        scope: ref("environment_scope", input.appName),
        placement: placement(this.connectionId, input.region),
        replacementId: input.replacementId,
        sourceStorage: input.sourceVolumeId
          ? ref("workspace_storage", input.sourceVolumeId)
          : undefined,
        snapshot: input.snapshotId
          ? ref("snapshot", input.snapshotId)
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
        identity: workspaceIdentity(input.appName, input.sourceVolumeId),
        scope: ref("environment_scope", input.appName),
        storage: ref("workspace_storage", input.sourceVolumeId),
        snapshot: ref("snapshot", input.snapshotId),
      }),
    );
  }

  async createReplacementWorkspaceMachine(
    input: WorkspaceMachineProvisioningInput & { replacementId: string },
  ) {
    return this.translate(async () =>
      legacyMachine(
        await this.provider.createReplacementWorkspaceCompute({
          ...computeInput(this.connectionId, input),
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
        identity: workspaceIdentity(input.appName, input.machineId),
        scope: ref("environment_scope", input.appName),
        compute: ref("workspace_compute", input.machineId),
      });
      return machine ? legacyMachine(machine) : null;
    });
  }

  async startMachine(
    input: Parameters<EnvironmentInfrastructureProvider["startMachine"]>[0],
  ) {
    return this.translate(() =>
      this.provider.startWorkspaceCompute(computeReferenceInput(input)),
    );
  }

  async stopMachine(
    input: Parameters<EnvironmentInfrastructureProvider["stopMachine"]>[0],
  ) {
    return this.translate(() =>
      this.provider.stopWorkspaceCompute(computeReferenceInput(input)),
    );
  }

  async deleteMachine(
    input: Parameters<EnvironmentInfrastructureProvider["deleteMachine"]>[0],
  ) {
    return this.translate(() =>
      this.provider.deleteWorkspaceCompute(computeReferenceInput(input)),
    );
  }

  async deleteVolume(
    input: Parameters<EnvironmentInfrastructureProvider["deleteVolume"]>[0],
  ) {
    return this.translate(() =>
      this.provider.deleteWorkspaceStorage({
        identity: workspaceIdentity(input.appName, input.volumeId),
        scope: ref("environment_scope", input.appName),
        storage: ref("workspace_storage", input.volumeId),
      }),
    );
  }

  async deleteEnvironmentApp(
    input: Parameters<EnvironmentInfrastructureProvider["deleteEnvironmentApp"]>[0],
  ) {
    return this.translate(() =>
      this.provider.deleteEnvironmentScope({
        identity: environmentIdentity(input.appName),
        scope: ref("environment_scope", input.appName),
      }),
    );
  }

  async listEnvironmentResources(
    input: Parameters<EnvironmentInfrastructureProvider["listEnvironmentResources"]>[0],
  ) {
    return this.translate(async () => {
      const inventory = await this.provider.listEnvironmentResources({
        identity: environmentIdentity(input.appName),
        scope: ref("environment_scope", input.appName),
      });
      return {
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
    return this.translate(() =>
      this.provider.waitForWorkspaceState({
        ...computeReferenceInput(input),
        state: input.state,
        timeoutSeconds: input.timeoutSeconds,
      }),
    );
  }

  async waitForMachineHealth(
    input: Parameters<EnvironmentInfrastructureProvider["waitForMachineHealth"]>[0],
  ) {
    return this.translate(() =>
      this.provider.waitForWorkspaceHealth({
        ...computeReferenceInput(input),
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
        identity: workspaceIdentity(input.appName, input.volumeId),
        scope: ref("environment_scope", input.appName),
        storage: ref("workspace_storage", input.volumeId),
      });
      return { id: snapshot.resource.externalId, state: snapshot.state };
    });
  }

  async updateMachineImage(
    input: Parameters<EnvironmentInfrastructureProvider["updateMachineImage"]>[0],
  ) {
    return this.translate(async () =>
      legacyMachine(
        await this.provider.updateWorkspaceImage({
          identity: workspaceIdentity(input.appName, input.machineId),
          scope: ref("environment_scope", input.appName),
          compute: ref("workspace_compute", input.machineId),
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
      throw legacyError(error);
    }
  }
}

function computeInput(
  connectionId: string,
  input: WorkspaceMachineProvisioningInput,
) {
  return {
    identity: {
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
    },
    scope: ref("environment_scope", input.appName),
    storage: ref("workspace_storage", input.volumeId),
    placement: placement(connectionId, input.region),
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

function computeReferenceInput(input: {
  appName: string;
  machineId: string;
}) {
  return {
    identity: workspaceIdentity(input.appName, input.machineId),
    scope: ref("environment_scope", input.appName),
    compute: ref("workspace_compute", input.machineId),
  };
}

function environmentIdentity(environmentId: string) {
  return {
    organizationId: `legacy:${environmentId}`,
    environmentId,
  };
}

function workspaceIdentity(environmentId: string, workspaceId: string) {
  return {
    ...environmentIdentity(environmentId),
    workspaceId,
  };
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

function ref(
  role: EnvironmentResourceRef["role"],
  externalId: string,
): EnvironmentResourceRef {
  return { provider: "fly", role, externalId };
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

function legacyError(error: EnvironmentProviderErrorV2) {
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
        authoritativeState: {
          machineId: error.reconciliationState.resource?.externalId,
          state: error.reconciliationState.state,
          image: error.reconciliationState.image,
        },
      })
    : legacy;
}
