export const FLY_MACHINES_API_BASE_URL = "https://api.machines.dev/v1";
export const KESTREL_WORKSPACE_SERVICE_PORT = 43_104;
export const KESTREL_WORKSPACE_VOLUME_GB = 20;
export const KESTREL_WORKSPACE_MEMORY_MB = 4096;
export const KESTREL_WORKSPACE_CPUS = 2;

export type EnvironmentProviderApp = {
  id: string;
  name: string;
  organizationSlug: string;
  network: string;
};

export type EnvironmentProviderVolume = {
  id: string;
  name: string;
  region: string;
  sizeGb: number;
  encrypted: true;
};

export type EnvironmentProviderMachineMount = {
  volumeId: string;
  name?: string | undefined;
  path: string;
};

export type EnvironmentProviderMachine = {
  id: string;
  state: string;
  region: string;
  image?: string | undefined;
  instanceId?: string | undefined;
  workspaceId?: string | undefined;
  mounts?: EnvironmentProviderMachineMount[] | undefined;
};

export type EnvironmentProviderGateway = {
  machineId: string;
  state: string;
  region: string;
  routerUrl: string;
  sharedIp: string;
  serviceToken: string;
};

export type EnvironmentProviderInventory = {
  machines: Array<{
    id: string;
    workspaceId: string | null;
    replacementId: string | null;
    mountedVolumeIds?: string[] | undefined;
  }>;
  volumes: Array<{
    id: string;
    name: string;
    region?: string | undefined;
    attachedMachineId?: string | null | undefined;
  }>;
};

export type WorkspaceMachineProvisioningInput = {
  appName: string;
  environmentId: string;
  organizationId: string;
  workspaceId: string;
  volumeId: string;
  region: string;
  runtimeImage: string;
  ticketPublicKey: string;
  controlPlaneUrl: string;
  serviceToken?: string | undefined;
  source: {
    type: "blank" | "github";
    resourceId?: string | undefined;
    repository?: string | undefined;
    defaultBranch?: string | undefined;
  };
  idleTimeoutMinutes: number;
};

export interface EnvironmentInfrastructureProvider {
  ensureEnvironmentApp(input: {
    appName: string;
    networkName: string;
  }): Promise<EnvironmentProviderApp>;
  ensureEnvironmentGateway(input: {
    appName: string;
    environmentId: string;
    region: string;
    runtimeImage: string;
    ticketPublicKey: string;
    controlPlaneUrl: string;
    serviceToken?: string | undefined;
  }): Promise<EnvironmentProviderGateway>;
  ensureWorkspaceVolume(input: {
    appName: string;
    workspaceId: string;
    region: string;
  }): Promise<EnvironmentProviderVolume>;
  ensureWorkspaceMachine(
    input: WorkspaceMachineProvisioningInput
  ): Promise<EnvironmentProviderMachine>;
  createReplacementWorkspaceVolume(input: {
    appName: string;
    workspaceId: string;
    region: string;
    replacementId: string;
  }): Promise<EnvironmentProviderVolume>;
  createReplacementWorkspaceMachine(
    input: WorkspaceMachineProvisioningInput & { replacementId: string }
  ): Promise<EnvironmentProviderMachine>;
  getMachine(input: {
    appName: string;
    machineId: string;
  }): Promise<EnvironmentProviderMachine | null>;
  startMachine(input: { appName: string; machineId: string }): Promise<void>;
  stopMachine(input: { appName: string; machineId: string }): Promise<void>;
  deleteMachine(input: { appName: string; machineId: string }): Promise<void>;
  deleteVolume(input: { appName: string; volumeId: string }): Promise<void>;
  deleteEnvironmentApp(input: { appName: string }): Promise<void>;
  listEnvironmentResources(input: {
    appName: string;
  }): Promise<EnvironmentProviderInventory>;
  waitForMachine(input: {
    appName: string;
    machineId: string;
    state: "started" | "stopped" | "destroyed";
    timeoutSeconds?: number;
  }): Promise<void>;
  waitForMachineHealth(input: {
    appName: string;
    machineId: string;
    checkName: string;
    timeoutSeconds?: number;
  }): Promise<void>;
  createVolumeSnapshot(input: {
    appName: string;
    volumeId: string;
  }): Promise<{ id: string; state: string }>;
  updateMachineImage(input: {
    appName: string;
    machineId: string;
    runtimeImage: string;
    envPatch?: Record<string, string | undefined> | undefined;
  }): Promise<EnvironmentProviderMachine>;
}

export class EnvironmentProviderError extends Error {
  readonly code:
    | "FLY_PROVIDER_NOT_CONFIGURED"
    | "FLY_PROVIDER_UNAVAILABLE"
    | "FLY_PROVIDER_REJECTED"
    | "FLY_RESOURCE_CONFLICT"
    | "FLY_RESPONSE_INVALID"
    | "FLY_MACHINE_UNHEALTHY";
  readonly status?: number | undefined;

  constructor(
    code: EnvironmentProviderError["code"],
    message: string,
    status?: number
  ) {
    super(message);
    this.name = "EnvironmentProviderError";
    this.code = code;
    this.status = status;
  }
}
