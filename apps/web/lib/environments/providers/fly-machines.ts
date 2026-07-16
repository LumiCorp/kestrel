import { z } from "zod";
import {
  type EnvironmentInfrastructureProvider,
  type EnvironmentProviderApp,
  EnvironmentProviderError,
  type EnvironmentProviderGateway,
  type EnvironmentProviderInventory,
  type EnvironmentProviderMachine,
  type EnvironmentProviderVolume,
  FLY_MACHINES_API_BASE_URL,
  KESTREL_WORKSPACE_CPUS,
  KESTREL_WORKSPACE_MEMORY_MB,
  KESTREL_WORKSPACE_SERVICE_PORT,
  KESTREL_WORKSPACE_VOLUME_GB,
  type WorkspaceMachineProvisioningInput,
} from "./contracts";

const appDetailsSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  network: z.string().min(1).optional(),
  organization: z.object({ slug: z.string().min(1) }),
});

const appCreateSchema = z.object({ id: z.string().min(1) });

const appListSchema = z.object({ apps: z.array(appDetailsSchema) });

const ipAssignmentSchema = z.object({
  ip: z.string().min(1),
  shared: z.boolean().optional(),
  service_name: z.string().nullable().optional(),
});

const ipAssignmentsSchema = z.object({
  ips: z.array(ipAssignmentSchema),
});

const volumeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  region: z.string().min(1),
  size_gb: z.number().int().positive(),
  encrypted: z.boolean(),
  attached_machine_id: z.string().min(1).nullable().optional(),
});

const machineMountSchema = z
  .object({
    volume: z.string().min(1),
    name: z.string().min(1).optional(),
    path: z.string().min(1),
  })
  .passthrough();

const machineSchema = z.object({
  id: z.string().min(1),
  state: z.string().min(1),
  region: z.string().min(1),
  instance_id: z.string().min(1).optional(),
  checks: z
    .array(
      z.object({
        name: z.string().min(1),
        status: z.string().min(1),
        output: z.string().optional(),
        updated_at: z.string().optional(),
      })
    )
    .optional(),
  config: z
    .object({
      image: z.string().min(1).optional(),
      env: z.record(z.string(), z.string()).optional(),
      metadata: z.record(z.string(), z.string()).optional(),
      mounts: z.array(machineMountSchema).optional(),
      services: z.array(z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
});

const snapshotResponseSchema = z.object({
  Msg: z.object({
    backup: z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      graph_id: z.string().optional(),
      state: z.string(),
    }),
  }),
});

const MACHINE_START_RETRY_INTERVAL_MS = 1000;
const MACHINE_START_RETRY_ATTEMPTS = 10;

export class FlyMachinesClient implements EnvironmentInfrastructureProvider {
  private readonly token: string;
  private readonly organizationSlug: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly healthPollIntervalMs: number;
  private readonly sleepImpl: (milliseconds: number) => Promise<void>;

  constructor(input: {
    token: string;
    organizationSlug: string;
    apiBaseUrl?: string | undefined;
    fetchImpl?: typeof fetch | undefined;
    healthPollIntervalMs?: number | undefined;
    sleepImpl?: ((milliseconds: number) => Promise<void>) | undefined;
  }) {
    this.token = requireConfigured(input.token, "Fly API token");
    this.organizationSlug = requireConfigured(
      input.organizationSlug,
      "Fly organization slug"
    );
    this.apiBaseUrl = (input.apiBaseUrl ?? FLY_MACHINES_API_BASE_URL).replace(
      /\/+$/u,
      ""
    );
    this.fetchImpl = input.fetchImpl ?? fetch;
    this.healthPollIntervalMs = input.healthPollIntervalMs ?? 1000;
    this.sleepImpl = input.sleepImpl ?? sleep;
  }

  async ensureEnvironmentApp(input: {
    appName: string;
    networkName: string;
  }): Promise<EnvironmentProviderApp> {
    const existing = await this.request(
      `/apps/${encodeURIComponent(input.appName)}`,
      { method: "GET" },
      { allowNotFound: true }
    );
    if (existing !== null) {
      const parsed = parseResponse(appDetailsSchema, existing);
      const organizationApps = parseResponse(
        appListSchema,
        await this.request(
          `/apps?org_slug=${encodeURIComponent(this.organizationSlug)}`,
          { method: "GET" }
        )
      );
      const belongsToConfiguredOrganization = organizationApps.apps.some(
        (app) => app.id === parsed.id && app.name === parsed.name
      );
      if (
        !belongsToConfiguredOrganization ||
        parsed.name !== input.appName ||
        (parsed.network !== undefined && parsed.network !== input.networkName)
      ) {
        throw new EnvironmentProviderError(
          "FLY_RESOURCE_CONFLICT",
          "Fly App name is already owned by a different organization or network."
        );
      }
      return {
        id: parsed.id,
        name: parsed.name,
        organizationSlug: parsed.organization.slug,
        network: parsed.network ?? input.networkName,
      };
    }

    const created = parseResponse(
      appCreateSchema,
      await this.request("/apps", {
        method: "POST",
        body: jsonBody({
          app_name: input.appName,
          org_slug: this.organizationSlug,
          network: input.networkName,
        }),
      })
    );
    return {
      id: created.id,
      name: input.appName,
      organizationSlug: this.organizationSlug,
      network: input.networkName,
    };
  }

  async ensureEnvironmentGateway(input: {
    appName: string;
    environmentId: string;
    region: string;
    runtimeImage: string;
    ticketPublicKey: string;
  }): Promise<EnvironmentProviderGateway> {
    const sharedIp = await this.ensureEnvironmentSharedIp(input.appName);
    const listed = parseResponse(
      z.array(machineSchema),
      await this.request(
        `/apps/${encodeURIComponent(input.appName)}/machines?metadata.kestrel_environment_gateway=true`,
        { method: "GET" }
      )
    );
    const existing = listed.find(
      (machine) =>
        machine.config?.metadata?.kestrel_environment_gateway === "true" &&
        machine.config.metadata.kestrel_environment_id === input.environmentId
    );
    if (
      existing &&
      (existing.config?.image !== input.runtimeImage ||
        existing.config.env?.KESTREL_ENVIRONMENT_APP_NAME !== input.appName ||
        existing.config.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY !==
          input.ticketPublicKey ||
        !existing.config.services?.length)
    ) {
      throw new EnvironmentProviderError(
        "FLY_RESOURCE_CONFLICT",
        "Existing Environment gateway Machine does not satisfy the immutable ingress contract."
      );
    }
    const machine = existing
      ? toMachine(existing)
      : toMachine(
          parseResponse(
            machineSchema,
            await this.request(
              `/apps/${encodeURIComponent(input.appName)}/machines`,
              {
                method: "POST",
                body: jsonBody({
                  name: environmentGatewayMachineName(input.environmentId),
                  region: input.region,
                  skip_launch: false,
                  config: environmentGatewayMachineConfig(input),
                }),
              }
            )
          )
        );
    if (machine.region !== input.region) {
      throw new EnvironmentProviderError(
        "FLY_RESOURCE_CONFLICT",
        "Existing Environment gateway Machine is in a different region."
      );
    }
    return {
      machineId: machine.id,
      state: machine.state,
      region: machine.region,
      routerUrl: `https://${input.appName}.fly.dev`,
      sharedIp,
    };
  }

  private async ensureEnvironmentSharedIp(appName: string) {
    const path = `/apps/${encodeURIComponent(appName)}/ip_assignments`;
    const assignments = parseResponse(
      ipAssignmentsSchema,
      await this.request(path, { method: "GET" })
    );
    const existing = assignments.ips.find(
      (assignment) => assignment.shared === true
    );
    if (existing) return existing.ip;
    return parseResponse(
      ipAssignmentSchema,
      await this.request(path, {
        method: "POST",
        body: jsonBody({ type: "shared_v4" }),
      })
    ).ip;
  }

  async ensureWorkspaceVolume(input: {
    appName: string;
    workspaceId: string;
    region: string;
  }): Promise<EnvironmentProviderVolume> {
    const name = workspaceVolumeName(input.workspaceId);
    const listed = parseResponse(
      z.array(volumeSchema),
      await this.request(`/apps/${encodeURIComponent(input.appName)}/volumes`, {
        method: "GET",
      })
    );
    const existing = listed.find((volume) => volume.name === name);
    const volume =
      existing ??
      parseResponse(
        volumeSchema,
        await this.request(
          `/apps/${encodeURIComponent(input.appName)}/volumes`,
          {
            method: "POST",
            body: jsonBody({
              name,
              region: input.region,
              size_gb: KESTREL_WORKSPACE_VOLUME_GB,
              encrypted: true,
              snapshot_retention: 30,
              auto_backup_enabled: true,
              require_unique_zone: false,
            }),
          }
        )
      );
    if (
      volume.region !== input.region ||
      volume.size_gb < KESTREL_WORKSPACE_VOLUME_GB ||
      volume.encrypted !== true
    ) {
      throw new EnvironmentProviderError(
        "FLY_RESOURCE_CONFLICT",
        "Existing Fly Volume does not satisfy the Workspace storage contract."
      );
    }
    return {
      id: volume.id,
      name: volume.name,
      region: volume.region,
      sizeGb: volume.size_gb,
      encrypted: true,
    };
  }

  async createReplacementWorkspaceVolume(input: {
    appName: string;
    workspaceId: string;
    region: string;
    replacementId: string;
  }): Promise<EnvironmentProviderVolume> {
    const name = replacementWorkspaceVolumeName(
      input.workspaceId,
      input.replacementId
    );
    const listed = parseResponse(
      z.array(volumeSchema),
      await this.request(`/apps/${encodeURIComponent(input.appName)}/volumes`, {
        method: "GET",
      })
    );
    const existing = listed.find((volume) => volume.name === name);
    const volume =
      existing ??
      parseResponse(
        volumeSchema,
        await this.request(
          `/apps/${encodeURIComponent(input.appName)}/volumes`,
          {
            method: "POST",
            body: jsonBody({
              name,
              region: input.region,
              size_gb: KESTREL_WORKSPACE_VOLUME_GB,
              encrypted: true,
              snapshot_retention: 30,
              auto_backup_enabled: true,
              require_unique_zone: false,
            }),
          }
        )
      );
    return checkedVolume(volume, input.region);
  }

  async ensureWorkspaceMachine(
    input: WorkspaceMachineProvisioningInput
  ): Promise<EnvironmentProviderMachine> {
    const listed = parseResponse(
      z.array(machineSchema),
      await this.request(
        `/apps/${encodeURIComponent(input.appName)}/machines?metadata.kestrel_workspace_id=${encodeURIComponent(input.workspaceId)}`,
        { method: "GET" }
      )
    );
    const existing = listed.find(
      (machine) =>
        machine.config?.metadata?.kestrel_workspace_id === input.workspaceId &&
        machine.config.metadata.kestrel_replacement_id === undefined
    );
    if (existing) {
      if (existing.region !== input.region) {
        throw new EnvironmentProviderError(
          "FLY_RESOURCE_CONFLICT",
          "Existing Workspace Machine is in a different region."
        );
      }
      return toMachine(existing);
    }

    return this.createWorkspaceMachine(
      input,
      workspaceMachineName(input.workspaceId)
    );
  }

  async createReplacementWorkspaceMachine(
    input: WorkspaceMachineProvisioningInput & { replacementId: string }
  ): Promise<EnvironmentProviderMachine> {
    const listed = parseResponse(
      z.array(machineSchema),
      await this.request(
        `/apps/${encodeURIComponent(input.appName)}/machines?metadata.kestrel_replacement_id=${encodeURIComponent(input.replacementId)}`,
        { method: "GET" }
      )
    );
    const existing = listed.find(
      (machine) =>
        machine.config?.metadata?.kestrel_workspace_id === input.workspaceId &&
        machine.config.metadata.kestrel_replacement_id === input.replacementId
    );
    if (existing) return toMachine(existing);
    return this.createWorkspaceMachine(
      input,
      replacementWorkspaceMachineName(input.workspaceId, input.replacementId),
      input.replacementId
    );
  }

  private async createWorkspaceMachine(
    input: WorkspaceMachineProvisioningInput,
    name: string,
    replacementId?: string
  ) {
    const machine = parseResponse(
      machineSchema,
      await this.request(
        `/apps/${encodeURIComponent(input.appName)}/machines`,
        {
          method: "POST",
          body: jsonBody({
            name,
            region: input.region,
            skip_launch: false,
            config: workspaceMachineConfig(input, replacementId),
          }),
        }
      )
    );
    return toMachine(machine);
  }

  async getMachine(input: {
    appName: string;
    machineId: string;
  }): Promise<EnvironmentProviderMachine | null> {
    const response = await this.request(
      `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}`,
      { method: "GET" },
      { allowNotFound: true }
    );
    return response === null
      ? null
      : toMachine(parseResponse(machineSchema, response));
  }

  async startMachine(input: { appName: string; machineId: string }) {
    const startPath =
      `/apps/${encodeURIComponent(input.appName)}/machines/` +
      `${encodeURIComponent(input.machineId)}/start`;
    let retriesRemaining = MACHINE_START_RETRY_ATTEMPTS;
    while (true) {
      try {
        await this.request(startPath, { method: "POST" });
        return;
      } catch (error) {
        if (
          !(error instanceof EnvironmentProviderError) ||
          error.status !== 412
        ) {
          throw error;
        }
        const machine = await this.getMachine(input);
        if (
          machine?.state === "started" ||
          machine?.state === "starting" ||
          machine?.state === "restarting"
        ) {
          return;
        }
        if (machine?.state === "stopping") {
          await this.waitForMachine({
            ...input,
            state: "stopped",
            timeoutSeconds: 60,
          });
        } else if (machine?.state !== "stopped") {
          throw new EnvironmentProviderError(
            "FLY_PROVIDER_REJECTED",
            `Fly Machine start was rejected while the authoritative Machine state was ${machine?.state ?? "unavailable"}.`,
            412
          );
        }
        if (retriesRemaining === 0) {
          throw new EnvironmentProviderError(
            "FLY_PROVIDER_REJECTED",
            "Fly Machine remained stopped after 10 bounded start retries.",
            412
          );
        }
        retriesRemaining -= 1;
        await this.sleepImpl(MACHINE_START_RETRY_INTERVAL_MS);
      }
    }
  }

  async stopMachine(input: { appName: string; machineId: string }) {
    await this.request(
      `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}/stop`,
      { method: "POST", body: jsonBody({}) }
    );
  }

  async deleteMachine(input: { appName: string; machineId: string }) {
    await this.request(
      `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}?force=true`,
      { method: "DELETE" },
      { allowNotFound: true }
    );
  }

  async deleteVolume(input: { appName: string; volumeId: string }) {
    await this.request(
      `/apps/${encodeURIComponent(input.appName)}/volumes/${encodeURIComponent(input.volumeId)}`,
      { method: "DELETE" },
      { allowNotFound: true }
    );
  }

  async deleteEnvironmentApp(input: { appName: string }) {
    await this.request(
      `/apps/${encodeURIComponent(input.appName)}`,
      { method: "DELETE" },
      { allowNotFound: true }
    );
  }

  async listEnvironmentResources(input: {
    appName: string;
  }): Promise<EnvironmentProviderInventory> {
    const [machines, volumes] = await Promise.all([
      this.request(`/apps/${encodeURIComponent(input.appName)}/machines`, {
        method: "GET",
      }),
      this.request(`/apps/${encodeURIComponent(input.appName)}/volumes`, {
        method: "GET",
      }),
    ]);
    return {
      machines: parseResponse(z.array(machineSchema), machines).map(
        (machine) => ({
          id: machine.id,
          workspaceId: machine.config?.metadata?.kestrel_workspace_id ?? null,
          replacementId:
            machine.config?.metadata?.kestrel_replacement_id ?? null,
          mountedVolumeIds:
            machine.config?.mounts?.map((mount) => mount.volume) ?? [],
        })
      ),
      volumes: parseResponse(z.array(volumeSchema), volumes).map((volume) => ({
        id: volume.id,
        name: volume.name,
        region: volume.region,
        attachedMachineId: volume.attached_machine_id ?? null,
      })),
    };
  }

  async waitForMachine(input: {
    appName: string;
    machineId: string;
    state: "started" | "stopped" | "destroyed";
    timeoutSeconds?: number;
  }) {
    const instanceId =
      input.state === "stopped"
        ? parseResponse(
            machineSchema,
            await this.request(
              `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}`,
              { method: "GET" }
            )
          ).instance_id
        : undefined;
    const deadline = Date.now() + (input.timeoutSeconds ?? 60) * 1000;
    while (true) {
      const remainingSeconds = Math.max(
        1,
        Math.ceil((deadline - Date.now()) / 1000)
      );
      const query = new URLSearchParams({
        state: input.state,
        timeout: String(Math.min(remainingSeconds, 60)),
      });
      if (instanceId) query.set("instance_id", instanceId);
      try {
        await this.request(
          `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}/wait?${query.toString()}`,
          { method: "GET" }
        );
        return;
      } catch (error) {
        if (
          !(error instanceof EnvironmentProviderError) ||
          error.status !== 408 ||
          Date.now() >= deadline
        ) {
          throw error;
        }
      }
    }
  }

  async waitForMachineHealth(input: {
    appName: string;
    machineId: string;
    checkName: string;
    timeoutSeconds?: number;
  }) {
    const checkName = requireConfigured(
      input.checkName,
      "Fly health check name"
    );
    const deadline = Date.now() + (input.timeoutSeconds ?? 60) * 1000;
    while (true) {
      const machine = parseResponse(
        machineSchema,
        await this.request(
          `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}`,
          { method: "GET" }
        )
      );
      const check = machine.checks?.find(
        (candidate) => candidate.name === checkName
      );
      if (check?.status === "passing") return;
      if (Date.now() >= deadline) {
        throw new EnvironmentProviderError(
          "FLY_MACHINE_UNHEALTHY",
          `Fly Machine health check ${checkName} did not pass before the readiness deadline.`
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.healthPollIntervalMs)
      );
    }
  }

  async createVolumeSnapshot(input: { appName: string; volumeId: string }) {
    const response = parseResponse(
      snapshotResponseSchema,
      await this.request(
        `/apps/${encodeURIComponent(input.appName)}/volumes/${encodeURIComponent(input.volumeId)}/snapshots`,
        { method: "POST", body: jsonBody({}) }
      )
    );
    return {
      id: response.Msg.backup.graph_id ?? response.Msg.backup.id,
      state: response.Msg.backup.state,
    };
  }

  async updateMachineImage(input: {
    appName: string;
    machineId: string;
    runtimeImage: string;
  }) {
    const current = parseResponse(
      machineSchema,
      await this.request(
        `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}`,
        { method: "GET" }
      )
    );
    if (!current.config) {
      throw new EnvironmentProviderError(
        "FLY_RESPONSE_INVALID",
        "Fly Machine configuration is unavailable for image update."
      );
    }
    if (sameImageDigest(current.config.image, input.runtimeImage)) {
      return toMachine(current);
    }
    const updated = parseResponse(
      machineSchema,
      await this.request(
        `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}`,
        {
          method: "POST",
          body: jsonBody({
            config: { ...current.config, image: input.runtimeImage },
            current_version: current.instance_id,
            skip_launch: current.state !== "started",
          }),
        }
      )
    );
    return toMachine(updated);
  }

  private async request(
    path: string,
    init: RequestInit,
    options: { allowNotFound?: boolean } = {}
  ): Promise<unknown | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          ...init.headers,
        },
      });
    } catch {
      throw new EnvironmentProviderError(
        "FLY_PROVIDER_UNAVAILABLE",
        "Fly Machines API request failed."
      );
    }
    if (response.status === 404 && options.allowNotFound) {
      return null;
    }
    if (!response.ok) {
      throw new EnvironmentProviderError(
        "FLY_PROVIDER_REJECTED",
        `Fly Machines API rejected the request (${response.status}).`,
        response.status
      );
    }
    if (response.status === 202 || response.status === 204) {
      return {};
    }
    return response.json().catch(() => ({}));
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function flyEnvironmentAppName(environmentId: string): string {
  return `kestrel-env-${compactId(environmentId, 20)}`;
}

export function flyEnvironmentNetworkName(environmentId: string): string {
  return `kestrel-${compactId(environmentId, 24)}-network`;
}

function workspaceMachineConfig(
  input: WorkspaceMachineProvisioningInput,
  replacementId?: string
) {
  return {
    image: input.runtimeImage,
    auto_destroy: false,
    env: {
      KESTREL_ENVIRONMENT_ID: input.environmentId,
      KESTREL_ORGANIZATION_ID: input.organizationId,
      KESTREL_WORKSPACE_ID: input.workspaceId,
      KESTREL_WORKSPACE_ROOT: "/workspace",
      KESTREL_WORKSPACE_PORT: String(KESTREL_WORKSPACE_SERVICE_PORT),
      KESTREL_ENABLE_MANAGED_WORKTREES: "true",
      KESTREL_REQUIRE_MANAGED_WORKTREE: "true",
      KESTREL_MANAGED_WORKTREE_ISOLATION: "session",
      KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: input.ticketPublicKey,
      KESTREL_CONTROL_PLANE_URL: input.controlPlaneUrl,
      KESTREL_ONE_APP_URL: input.controlPlaneUrl,
      KESTREL_ONE_CREDENTIAL_BROKER_TOKEN: input.credentialBrokerToken,
      KESTREL_WORKSPACE_SOURCE_TYPE: input.source.type,
      ...(input.source.resourceId
        ? { KESTREL_WORKSPACE_SOURCE_RESOURCE_ID: input.source.resourceId }
        : {}),
      ...(input.source.repository
        ? { KESTREL_WORKSPACE_SOURCE_REPOSITORY: input.source.repository }
        : {}),
      ...(input.source.defaultBranch
        ? {
            KESTREL_WORKSPACE_SOURCE_DEFAULT_BRANCH: input.source.defaultBranch,
          }
        : {}),
      KESTREL_IDLE_TIMEOUT_MINUTES: String(input.idleTimeoutMinutes),
    },
    metadata: {
      kestrel_environment_id: input.environmentId,
      kestrel_organization_id: input.organizationId,
      kestrel_workspace_id: input.workspaceId,
      ...(replacementId ? { kestrel_replacement_id: replacementId } : {}),
    },
    guest: {
      cpu_kind: "shared",
      cpus: KESTREL_WORKSPACE_CPUS,
      memory_mb: KESTREL_WORKSPACE_MEMORY_MB,
    },
    mounts: [{ volume: input.volumeId, path: "/workspace" }],
    restart: { policy: "on-failure", max_retries: 3 },
    checks: {
      workspace: {
        type: "http",
        port: KESTREL_WORKSPACE_SERVICE_PORT,
        method: "GET",
        path: "/health",
        interval: "15s",
        timeout: "10s",
        grace_period: "30s",
      },
    },
  };
}

function environmentGatewayMachineConfig(input: {
  appName: string;
  environmentId: string;
  runtimeImage: string;
  ticketPublicKey: string;
}) {
  return {
    image: input.runtimeImage,
    auto_destroy: false,
    env: {
      KESTREL_ENVIRONMENT_APP_NAME: input.appName,
      KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: input.ticketPublicKey,
      PORT: "8080",
    },
    metadata: {
      kestrel_environment_gateway: "true",
      kestrel_environment_id: input.environmentId,
    },
    guest: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
    restart: { policy: "on-failure", max_retries: 3 },
    services: [
      {
        protocol: "tcp",
        internal_port: 8080,
        auto_stop_machines: "off",
        auto_start_machines: true,
        min_machines_running: 1,
        ports: [
          { port: 80, handlers: ["http"] },
          { port: 443, handlers: ["tls", "http"] },
        ],
        concurrency: { type: "requests", soft_limit: 50, hard_limit: 100 },
      },
    ],
    checks: {
      gateway: {
        type: "http",
        port: 8080,
        method: "GET",
        path: "/health",
        interval: "15s",
        timeout: "10s",
        grace_period: "15s",
      },
    },
  };
}

function checkedVolume(
  volume: z.infer<typeof volumeSchema>,
  region: string
): EnvironmentProviderVolume {
  if (
    volume.region !== region ||
    volume.size_gb < KESTREL_WORKSPACE_VOLUME_GB ||
    volume.encrypted !== true
  ) {
    throw new EnvironmentProviderError(
      "FLY_RESOURCE_CONFLICT",
      "Fly Volume does not satisfy the Workspace storage contract."
    );
  }
  return {
    id: volume.id,
    name: volume.name,
    region: volume.region,
    sizeGb: volume.size_gb,
    encrypted: true,
  };
}

export function workspaceVolumeName(workspaceId: string): string {
  return `ws_${compactId(workspaceId, 20).replace(/-/gu, "_")}`;
}

function workspaceMachineName(workspaceId: string): string {
  return `ws-${compactId(workspaceId, 20)}`;
}

function environmentGatewayMachineName(environmentId: string): string {
  return `gateway-${compactId(environmentId, 20)}`;
}

function replacementWorkspaceVolumeName(
  workspaceId: string,
  replacementId: string
) {
  return `ws_${compactId(workspaceId, 14)}_r_${compactId(replacementId, 8)}`;
}

function replacementWorkspaceMachineName(
  workspaceId: string,
  replacementId: string
) {
  return `ws-${compactId(workspaceId, 14)}-r-${compactId(replacementId, 8)}`;
}

function compactId(value: string, length: number): string {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (!compact) {
    throw new EnvironmentProviderError(
      "FLY_RESPONSE_INVALID",
      "Provider resource identifier is invalid."
    );
  }
  return compact.slice(0, length);
}

function toMachine(
  machine: z.infer<typeof machineSchema>
): EnvironmentProviderMachine {
  return {
    id: machine.id,
    state: machine.state,
    region: machine.region,
    ...(machine.config?.image ? { image: machine.config.image } : {}),
    ...(machine.instance_id ? { instanceId: machine.instance_id } : {}),
    ...(machine.config?.metadata?.kestrel_workspace_id
      ? { workspaceId: machine.config.metadata.kestrel_workspace_id }
      : {}),
    mounts:
      machine.config?.mounts?.map((mount) => ({
        volumeId: mount.volume,
        ...(mount.name ? { name: mount.name } : {}),
        path: mount.path,
      })) ?? [],
  };
}

function sameImageDigest(current: string | undefined, requested: string) {
  if (current === requested) return true;
  const currentDigest = current?.match(/@?(sha256:[a-f0-9]{64})$/u)?.[1];
  const requestedDigest = requested.match(/@?(sha256:[a-f0-9]{64})$/u)?.[1];
  return Boolean(
    currentDigest && requestedDigest && currentDigest === requestedDigest
  );
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new EnvironmentProviderError(
      "FLY_RESPONSE_INVALID",
      "Fly Machines API returned an invalid response."
    );
  }
  return parsed.data;
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

function requireConfigured(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new EnvironmentProviderError(
      "FLY_PROVIDER_NOT_CONFIGURED",
      `${label} is not configured.`
    );
  }
  return normalized;
}
