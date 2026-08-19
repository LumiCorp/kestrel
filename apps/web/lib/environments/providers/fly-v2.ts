import {
  type EnvironmentInfrastructureProvider,
  EnvironmentProviderError,
  type EnvironmentProviderMachine,
  type WorkspaceMachineProvisioningInput,
} from "./contracts";
import {
  type EnvironmentGatewayStateV2,
  type EnvironmentIdentity,
  type EnvironmentInfrastructureProviderV2,
  type EnvironmentPlacement,
  EnvironmentProviderErrorV2,
  type EnvironmentProviderEvidence,
  type EnvironmentResourceRef,
  type WorkspaceComputeStateV2,
  type WorkspaceIdentity,
  type WorkspaceRuntimeDesiredV2,
} from "./contracts-v2";
import {
  flyEnvironmentAppName,
  flyEnvironmentNetworkName,
} from "./fly-machines";

const FLY_V2_CAPABILITIES = [
  "environment_scope",
  "public_gateway",
  "private_workspace_routing",
  "workspace_compute",
  "workspace_start_stop",
  "persistent_workspace_storage",
  "volume_snapshots",
  "immutable_image_updates",
  "health_readiness",
  "resource_inventory",
  "regional_placement",
] as const;

export class FlyEnvironmentInfrastructureProviderV2
  implements EnvironmentInfrastructureProviderV2
{
  readonly descriptor = {
    provider: "fly",
    label: "Fly.io Machines",
    capabilities: [...FLY_V2_CAPABILITIES],
    evidenceLevel: "isolated_provider",
    contractVersion: "environment-infrastructure-provider-v2",
  } as const;

  constructor(private readonly client: EnvironmentInfrastructureProvider) {}

  async ensureEnvironmentScope(input: {
    identity: EnvironmentIdentity;
    placement: EnvironmentPlacement;
  }) {
    return this.translate(async () => {
      const app = await this.client.ensureEnvironmentApp({
        appName: flyEnvironmentAppName(input.identity.environmentId),
        networkName: flyEnvironmentNetworkName(input.identity.environmentId),
      });
      return {
        resource: flyRef("environment_scope", app.name),
        placement: input.placement,
        evidence: implementationEvidence(),
      };
    });
  }

  async ensureEnvironmentGateway(input: {
    identity: EnvironmentIdentity;
    scope: EnvironmentResourceRef;
    placement: EnvironmentPlacement;
    runtimeImage: string;
    ticketPublicKey: string;
    controlPlaneUrl: string;
    serviceToken: string;
  }): Promise<EnvironmentGatewayStateV2> {
    return this.translate(async () => {
      const gateway = await this.client.ensureEnvironmentGateway({
        appName: externalId(input.scope, "environment_scope"),
        environmentId: input.identity.environmentId,
        region: requestedPlacement(input.placement),
        runtimeImage: input.runtimeImage,
        ticketPublicKey: input.ticketPublicKey,
        controlPlaneUrl: input.controlPlaneUrl,
        serviceToken: input.serviceToken,
      });
      return {
        resource: flyRef("gateway", gateway.machineId),
        edgeRoute: flyRef("edge_route", gateway.sharedIp),
        state: gateway.state,
        routerUrl: gateway.routerUrl,
        placement: observedPlacement(input.placement, gateway.region),
        evidence: implementationEvidence(),
      };
    });
  }

  async ensureWorkspaceStorage(
    input: Parameters<EnvironmentInfrastructureProviderV2["ensureWorkspaceStorage"]>[0],
  ) {
    return this.translate(async () => {
      const volume = await this.client.ensureWorkspaceVolume({
        appName: externalId(input.scope, "environment_scope"),
        workspaceId: input.identity.workspaceId,
        region: requestedPlacement(input.placement),
      });
      return storageState(volume, input.placement);
    });
  }

  async ensureWorkspaceCompute(
    input: Parameters<EnvironmentInfrastructureProviderV2["ensureWorkspaceCompute"]>[0],
  ) {
    return this.translate(async () =>
      computeState(
        await this.client.ensureWorkspaceMachine(
          workspaceProvisioningInput(input),
        ),
        input.placement,
      ),
    );
  }

  async getWorkspaceCompute(
    input: Parameters<EnvironmentInfrastructureProviderV2["getWorkspaceCompute"]>[0],
  ) {
    return this.translate(async () => {
      const machine = await this.client.getMachine({
        appName: externalId(input.scope, "environment_scope"),
        machineId: externalId(input.compute),
      });
      return machine
        ? computeState(machine, legacyPlacement(input.identity))
        : null;
    });
  }

  async startWorkspaceCompute(
    input: Parameters<EnvironmentInfrastructureProviderV2["startWorkspaceCompute"]>[0],
  ) {
    return this.translate(() =>
      this.client.startMachine({
        appName: externalId(input.scope, "environment_scope"),
        machineId: externalId(input.compute),
      }),
    );
  }

  async stopWorkspaceCompute(
    input: Parameters<EnvironmentInfrastructureProviderV2["stopWorkspaceCompute"]>[0],
  ) {
    return this.translate(() =>
      this.client.stopMachine({
        appName: externalId(input.scope, "environment_scope"),
        machineId: externalId(input.compute),
      }),
    );
  }

  async updateWorkspaceImage(
    input: Parameters<EnvironmentInfrastructureProviderV2["updateWorkspaceImage"]>[0],
  ) {
    return this.translate(async () =>
      computeState(
        await this.client.updateMachineImage({
          appName: externalId(input.scope, "environment_scope"),
          machineId: externalId(input.compute),
          runtimeImage: input.runtimeImage,
          envPatch: input.environmentPatch,
          stopConfig: input.stopConfig,
        }),
        legacyPlacement(input.identity),
        input.compute.role,
      ),
    );
  }

  async createWorkspaceSnapshot(
    input: Parameters<EnvironmentInfrastructureProviderV2["createWorkspaceSnapshot"]>[0],
  ) {
    return this.translate(async () => {
      const snapshot = await this.client.createVolumeSnapshot({
        appName: externalId(input.scope, "environment_scope"),
        volumeId: externalId(input.storage, "workspace_storage"),
      });
      return {
        resource: flyRef("snapshot", snapshot.id),
        state: snapshot.state,
        evidence: implementationEvidence(),
      };
    });
  }

  async isWorkspaceSnapshotUsable(
    input: Parameters<EnvironmentInfrastructureProviderV2["isWorkspaceSnapshotUsable"]>[0],
  ) {
    return this.translate(() =>
      this.client.isWorkspaceSnapshotUsable({
        appName: externalId(input.scope, "environment_scope"),
        sourceVolumeId: externalId(input.storage, "workspace_storage"),
        snapshotId: externalId(input.snapshot, "snapshot"),
      }),
    );
  }

  async createReplacementWorkspaceStorage(
    input: Parameters<EnvironmentInfrastructureProviderV2["createReplacementWorkspaceStorage"]>[0],
  ) {
    return this.translate(async () =>
      storageState(
        await this.client.createReplacementWorkspaceVolume({
          appName: externalId(input.scope, "environment_scope"),
          workspaceId: input.identity.workspaceId,
          region: requestedPlacement(input.placement),
          replacementId: input.replacementId,
          sourceVolumeId: input.sourceStorage
            ? externalId(input.sourceStorage, "workspace_storage")
            : undefined,
          snapshotId: input.snapshot
            ? externalId(input.snapshot, "snapshot")
            : undefined,
        }),
        input.placement,
      ),
    );
  }

  async createReplacementWorkspaceCompute(
    input: Parameters<EnvironmentInfrastructureProviderV2["createReplacementWorkspaceCompute"]>[0],
  ) {
    return this.translate(async () =>
      computeState(
        await this.client.createReplacementWorkspaceMachine({
          ...workspaceProvisioningInput(input),
          replacementId: input.replacementId,
        }),
        input.placement,
      ),
    );
  }

  async listEnvironmentResources(
    input: Parameters<EnvironmentInfrastructureProviderV2["listEnvironmentResources"]>[0],
  ) {
    return this.translate(async () => {
      const inventory = await this.client.listEnvironmentResources({
        appName: externalId(input.scope, "environment_scope"),
      });
      return {
        resources: [
          ...inventory.machines.map((machine) => ({
            ref: flyRef("workspace_compute", machine.id),
            state: machine.state ?? null,
            workspaceId: machine.workspaceId,
            replacementId: machine.replacementId,
            relatedResources: (machine.mountedVolumeIds ?? []).map((id) =>
              flyRef("workspace_storage", id),
            ),
          })),
          ...inventory.volumes.map((volume) => ({
            ref: flyRef("workspace_storage", volume.id),
            state: null,
            workspaceId: null,
            replacementId: null,
            relatedResources: volume.attachedMachineId
              ? [flyRef("workspace_compute", volume.attachedMachineId)]
              : [],
          })),
        ],
        evidence: implementationEvidence(),
      };
    });
  }

  async deleteWorkspaceCompute(
    input: Parameters<EnvironmentInfrastructureProviderV2["deleteWorkspaceCompute"]>[0],
  ) {
    return this.translate(() =>
      this.client.deleteMachine({
        appName: externalId(input.scope, "environment_scope"),
        machineId: externalId(input.compute),
      }),
    );
  }

  async deleteWorkspaceStorage(
    input: Parameters<EnvironmentInfrastructureProviderV2["deleteWorkspaceStorage"]>[0],
  ) {
    return this.translate(() =>
      this.client.deleteVolume({
        appName: externalId(input.scope, "environment_scope"),
        volumeId: externalId(input.storage, "workspace_storage"),
      }),
    );
  }

  async deleteEnvironmentScope(
    input: Parameters<EnvironmentInfrastructureProviderV2["deleteEnvironmentScope"]>[0],
  ) {
    return this.translate(() =>
      this.client.deleteEnvironmentApp({
        appName: externalId(input.scope, "environment_scope"),
      }),
    );
  }

  async waitForWorkspaceState(
    input: Parameters<EnvironmentInfrastructureProviderV2["waitForWorkspaceState"]>[0],
  ) {
    return this.translate(() =>
      this.client.waitForMachine({
        appName: externalId(input.scope, "environment_scope"),
        machineId: externalId(input.compute),
        state: input.state,
        timeoutSeconds: input.timeoutSeconds,
      }),
    );
  }

  async waitForWorkspaceHealth(
    input: Parameters<EnvironmentInfrastructureProviderV2["waitForWorkspaceHealth"]>[0],
  ) {
    return this.translate(() =>
      this.client.waitForMachineHealth({
        appName: externalId(input.scope, "environment_scope"),
        machineId: externalId(input.compute),
        checkName: input.checkName,
        timeoutSeconds: input.timeoutSeconds,
      }),
    );
  }

  private async translate<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapFlyProviderError(error);
    }
  }
}

export function mapFlyProviderError(error: unknown) {
  if (!(error instanceof EnvironmentProviderError)) return error;
  const authoritative = readRecord(
    readRecord(error).authoritativeState,
  );
  const resourceId =
    typeof authoritative.machineId === "string"
      ? authoritative.machineId
      : null;
  const reconciliationState =
    Object.keys(authoritative).length > 0
      ? {
          resource: resourceId
            ? flyRef("workspace_compute", resourceId)
            : null,
          state:
            typeof authoritative.state === "string"
              ? authoritative.state
              : null,
          image:
            typeof authoritative.image === "string"
              ? authoritative.image
              : null,
        }
      : undefined;
  const code = {
    FLY_PROVIDER_NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
    FLY_PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
    FLY_PROVIDER_REJECTED: "PROVIDER_REJECTED",
    FLY_RESOURCE_CONFLICT: "RESOURCE_CONFLICT",
    FLY_RESPONSE_INVALID: "RESPONSE_INVALID",
    FLY_MACHINE_UNHEALTHY: "RESOURCE_UNHEALTHY",
  }[error.code] as EnvironmentProviderErrorV2["code"];
  return new EnvironmentProviderErrorV2({
    code,
    message: error.message,
    retryable:
      code === "PROVIDER_UNAVAILABLE" ||
      error.status === 408 ||
      error.status === 429 ||
      (error.status !== undefined && error.status >= 500) ||
      ([409, 412].includes(error.status ?? 0) &&
        reconciliationState !== undefined),
    evidence: {
      level: "implementation",
      providerCode: error.code,
      httpStatus: error.status,
      phase: error.phase,
      providerRequestId: error.requestId,
      detail: error.providerDetail,
    },
    reconciliationState,
  });
}

function workspaceProvisioningInput(input: {
  identity: WorkspaceIdentity;
  scope: EnvironmentResourceRef;
  storage: EnvironmentResourceRef;
  placement: EnvironmentPlacement;
  desired: WorkspaceRuntimeDesiredV2;
}): WorkspaceMachineProvisioningInput {
  return {
    appName: externalId(input.scope, "environment_scope"),
    environmentId: input.identity.environmentId,
    organizationId: input.identity.organizationId,
    workspaceId: input.identity.workspaceId,
    volumeId: externalId(input.storage, "workspace_storage"),
    region: requestedPlacement(input.placement),
    runtimeImage: input.desired.runtimeImage,
    ticketPublicKey: input.desired.ticketPublicKey,
    controlPlaneUrl: input.desired.controlPlaneUrl,
    serviceToken: input.desired.serviceToken,
    source: input.desired.source,
    idleTimeoutMinutes: input.desired.idleTimeoutMinutes,
  };
}

function storageState(
  volume: Awaited<
    ReturnType<EnvironmentInfrastructureProvider["ensureWorkspaceVolume"]>
  >,
  placement: EnvironmentPlacement,
) {
  return {
    resource: flyRef("workspace_storage", volume.id),
    sizeGb: volume.sizeGb,
    placement: observedPlacement(placement, volume.region),
    security: {
      encryption: "provider_verified" as const,
      evidenceRef: "fly-machines-volume-api:encrypted",
    },
    evidence: implementationEvidence(),
  };
}

function computeState(
  machine: EnvironmentProviderMachine,
  placement: EnvironmentPlacement,
  role: EnvironmentResourceRef["role"] = "workspace_compute",
): WorkspaceComputeStateV2 {
  return {
    resource: {
      ...flyRef(role, machine.id),
      ...(machine.instanceId
        ? { observedGeneration: machine.instanceId }
        : {}),
    },
    state: machine.state,
    placement: observedPlacement(placement, machine.region),
    image: machine.image ?? null,
    resolvedImageDigest: machine.resolvedImageDigest ?? null,
    cpuKind: machine.cpuKind ?? null,
    cpus: machine.cpus ?? null,
    memoryMb: machine.memoryMb ?? null,
    workspaceId: machine.workspaceId ?? null,
    standbyFor: (machine.standbyForMachineIds ?? []).map((id) =>
      flyRef("workspace_compute", id),
    ),
    storage: (machine.mounts ?? []).map((mount) =>
      flyRef("workspace_storage", mount.volumeId),
    ),
    evidence: implementationEvidence(),
  };
}

function flyRef(
  role: EnvironmentResourceRef["role"],
  externalIdValue: string,
): EnvironmentResourceRef {
  return { provider: "fly", role, externalId: externalIdValue };
}

function externalId(
  ref: EnvironmentResourceRef,
  expectedRole?: EnvironmentResourceRef["role"],
) {
  if (ref.provider !== "fly" || (expectedRole && ref.role !== expectedRole)) {
    throw new EnvironmentProviderErrorV2({
      code: "RESOURCE_CONFLICT",
      message: "Provider resource reference does not belong to Fly or the expected role.",
      evidence: { level: "implementation", resourceRef: ref },
    });
  }
  return ref.externalId;
}

function requestedPlacement(placement: EnvironmentPlacement) {
  const location = placement.requested?.location;
  if (!location) {
    throw new EnvironmentProviderErrorV2({
      code: "PROVIDER_NOT_CONFIGURED",
      message: "Fly placement requires a requested location.",
      evidence: { level: "implementation" },
    });
  }
  return location;
}

function observedPlacement(
  placement: EnvironmentPlacement,
  location: string,
): EnvironmentPlacement {
  return { ...placement, observed: { location } };
}

function legacyPlacement(identity: EnvironmentIdentity): EnvironmentPlacement {
  return {
    connectionId: `legacy:${identity.organizationId}`,
    requested: null,
    observed: null,
  };
}

function implementationEvidence(): EnvironmentProviderEvidence[] {
  return [{ level: "implementation" }];
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
