import { createHash, createPublicKey, randomBytes } from "node:crypto";
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
  KESTREL_WORKSPACE_STOP_CONFIG,
  KESTREL_WORKSPACE_VOLUME_GB,
  type EnvironmentProviderMachineStopConfig,
  type WorkspaceMachineProvisioningInput,
} from "./contracts";

const FLY_RESOURCE_PERSISTENCE_TIMEOUT_MS = 120_000;

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
  state: z.string().min(1).optional(),
  attached_machine_id: z.string().min(1).nullable().optional(),
});

const volumeSnapshotSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
});

const volumeSnapshotsSchema = z
  .union([
    z.array(volumeSnapshotSchema),
    z.object({ snapshots: z.array(volumeSnapshotSchema) }),
  ])
  .transform((value) => (Array.isArray(value) ? value : value.snapshots));

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
  image_ref: z
    .object({
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    })
    .passthrough()
    .optional(),
  instance_id: z.string().min(1).nullable().optional(),
  checks: z
    .array(
      z.object({
        name: z.string().min(1),
        status: z.string().min(1),
        output: z.string().optional(),
        updated_at: z.string().optional(),
      }),
    )
    .optional(),
  config: z
    .object({
      image: z.string().min(1).optional(),
      env: z.record(z.string(), z.string()).optional(),
      metadata: z.record(z.string(), z.string()).optional(),
      standbys: z.array(z.string().min(1)).optional(),
      mounts: z.array(machineMountSchema).optional(),
      services: z.array(z.unknown()).optional(),
      stop_config: z
        .object({
          signal: z.string().min(1),
          timeout: z.preprocess(
            (value) =>
              typeof value === "string"
                ? (parseFlyDurationNanoseconds(value) ?? value)
                : value,
            z.number().int().nonnegative(),
          ),
        })
        .passthrough()
        .nullable()
        .optional(),
      guest: z
        .object({
          cpu_kind: z.string().min(1).optional(),
          cpus: z.number().int().positive().optional(),
          memory_mb: z.number().int().positive().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
});

const machineCreateResponseSchema = z
  .object({
    id: z.string().min(1),
  })
  .passthrough();

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

export type FlyMachineHealthCheck = {
  name: string;
  port: number;
  path: string;
  timeoutSeconds: number;
  gracePeriodSeconds: number;
};

export type FlyTurnWorkerMachine = EnvironmentProviderMachine & {
  configuredConcurrency: number | null;
  concurrencyConfiguration: "valid" | "missing" | "invalid";
  healthStatus: string;
  workerHealthCheckConfigured: boolean;
  configurationFingerprint: string;
};

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
      "Fly organization slug",
    );
    this.apiBaseUrl = (input.apiBaseUrl ?? FLY_MACHINES_API_BASE_URL).replace(
      /\/+$/u,
      "",
    );
    this.fetchImpl = input.fetchImpl ?? fetch;
    this.healthPollIntervalMs = input.healthPollIntervalMs ?? 1000;
    this.sleepImpl = input.sleepImpl ?? sleep;
  }

  async testConnection() {
    parseResponse(
      appListSchema,
      await this.request(
        "fly.organization.apps.list",
        `/apps?org_slug=${encodeURIComponent(this.organizationSlug)}`,
        { method: "GET" },
      ),
    );
  }

  async ensureEnvironmentApp(input: {
    appName: string;
    networkName: string;
  }): Promise<EnvironmentProviderApp> {
    const existing = await this.request(
      "fly.environment.app.get",
      `/apps/${encodeURIComponent(input.appName)}`,
      { method: "GET" },
      { allowNotFound: true },
    );
    if (existing !== null) {
      const parsed = parseResponse(appDetailsSchema, existing);
      const organizationApps = parseResponse(
        appListSchema,
        await this.request(
          "fly.environment.apps.list",
          `/apps?org_slug=${encodeURIComponent(this.organizationSlug)}`,
          { method: "GET" },
        ),
      );
      const belongsToConfiguredOrganization = organizationApps.apps.some(
        (app) => app.id === parsed.id && app.name === parsed.name,
      );
      if (
        !belongsToConfiguredOrganization ||
        parsed.name !== input.appName ||
        (parsed.network !== undefined && parsed.network !== input.networkName)
      ) {
        throw new EnvironmentProviderError(
          "FLY_RESOURCE_CONFLICT",
          "Fly App name is already owned by a different organization or network.",
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
      await this.request("fly.environment.app.create", "/apps", {
        method: "POST",
        body: jsonBody({
          app_name: input.appName,
          org_slug: this.organizationSlug,
          network: input.networkName,
        }),
      }),
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
    controlPlaneUrl: string;
    serviceToken?: string | undefined;
    initExec?: string[] | undefined;
  }): Promise<EnvironmentProviderGateway> {
    const ticketPublicKey = canonicalEnvironmentTicketPublicKey(
      input.ticketPublicKey,
    );
    const sharedIp = await this.ensureEnvironmentSharedIp(input.appName);
    const listed = parseResponse(
      z.array(machineSchema),
      await this.request(
        "fly.environment.gateway.list",
        `/apps/${encodeURIComponent(input.appName)}/machines?metadata.kestrel_environment_gateway=true`,
        { method: "GET" },
      ),
    );
    const existing = listed.find(
      (machine) =>
        machine.config?.metadata?.kestrel_environment_gateway === "true" &&
        machine.config.metadata.kestrel_environment_id === input.environmentId,
    );
    const serviceToken =
      input.serviceToken ??
      existing?.config?.env?.KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN ??
      randomBytes(32).toString("base64url");
    const gatewayConfigInput = { ...input, serviceToken, ticketPublicKey };
    if (
      existing &&
      (existing.config?.image !== input.runtimeImage ||
        existing.config.env?.KESTREL_ENVIRONMENT_APP_NAME !== input.appName ||
        canonicalExistingEnvironmentTicketPublicKey(
          existing.config.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY,
        ) !== ticketPublicKey ||
        !existing.config.services?.length)
    ) {
      throw new EnvironmentProviderError(
        "FLY_RESOURCE_CONFLICT",
        "Existing Environment gateway Machine does not satisfy the immutable ingress contract.",
      );
    }
    const identityChanged =
      existing &&
      (existing.config?.env?.KESTREL_CONTROL_PLANE_URL !==
        input.controlPlaneUrl ||
        existing.config.env.KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN !==
          serviceToken);
    const reconciled = identityChanged
      ? parseResponse(
          machineSchema,
          await this.request(
            "fly.environment.gateway.update",
            `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(existing.id)}`,
            {
              method: "POST",
              body: jsonBody({
                config: environmentGatewayMachineConfig(gatewayConfigInput),
              }),
            },
          ),
        )
      : existing;
    const machine = reconciled
      ? toMachine(reconciled)
      : toMachine(
          parseResponse(
            machineSchema,
            await this.request(
              "fly.environment.gateway.create",
              `/apps/${encodeURIComponent(input.appName)}/machines`,
              {
                method: "POST",
                body: jsonBody({
                  name: environmentGatewayMachineName(input.environmentId),
                  region: input.region,
                  skip_launch: false,
                  config: environmentGatewayMachineConfig(gatewayConfigInput),
                }),
              },
            ),
          ),
        );
    if (machine.region !== input.region) {
      throw new EnvironmentProviderError(
        "FLY_RESOURCE_CONFLICT",
        "Existing Environment gateway Machine is in a different region.",
      );
    }
    return {
      machineId: machine.id,
      state: machine.state,
      region: machine.region,
      routerUrl: `https://${input.appName}.fly.dev`,
      sharedIp,
      serviceToken,
    };
  }

  private async ensureEnvironmentSharedIp(appName: string) {
    const path = `/apps/${encodeURIComponent(appName)}/ip_assignments`;
    const assignments = parseResponse(
      ipAssignmentsSchema,
      await this.request("fly.environment.ip.list", path, { method: "GET" }),
    );
    const existing = assignments.ips.find(
      (assignment) => assignment.shared === true,
    );
    if (existing) return existing.ip;
    return parseResponse(
      ipAssignmentSchema,
      await this.request("fly.environment.ip.create", path, {
        method: "POST",
        body: jsonBody({ type: "shared_v4" }),
      }),
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
      await this.request(
        "fly.workspace.volume.list",
        `/apps/${encodeURIComponent(input.appName)}/volumes`,
        { method: "GET" },
      ),
    );
    const existing = listed.find((volume) => volume.name === name);
    const volume =
      existing ??
      parseResponse(
        volumeSchema,
        await this.request(
          "fly.workspace.volume.create",
          `/apps/${encodeURIComponent(input.appName)}/volumes`,
          {
            method: "POST",
            body: jsonBody({
              name,
              region: input.region,
              size_gb: KESTREL_WORKSPACE_VOLUME_GB,
              encrypted: true,
              snapshot_retention: 14,
              auto_backup_enabled: false,
              require_unique_zone: false,
            }),
          },
        ),
      );
    if (
      volume.region !== input.region ||
      volume.size_gb < KESTREL_WORKSPACE_VOLUME_GB ||
      volume.encrypted !== true
    ) {
      throw new EnvironmentProviderError(
        "FLY_RESOURCE_CONFLICT",
        "Existing Fly Volume does not satisfy the Workspace storage contract.",
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
    snapshotId?: string | undefined;
    sourceVolumeId?: string | undefined;
  }): Promise<EnvironmentProviderVolume> {
    if (input.snapshotId) {
      if (!input.sourceVolumeId) {
        throw new EnvironmentProviderError(
          "FLY_RESPONSE_INVALID",
          "A source Fly Volume is required for snapshot restoration.",
        );
      }
      const usable = await this.isWorkspaceSnapshotUsable({
        appName: input.appName,
        sourceVolumeId: input.sourceVolumeId,
        snapshotId: input.snapshotId,
      });
      if (!usable) {
        throw new EnvironmentProviderError(
          "FLY_RESOURCE_CONFLICT",
          "The requested Fly snapshot does not belong to the source Volume or is not ready for restoration.",
        );
      }
    }
    const name = replacementWorkspaceVolumeName(
      input.workspaceId,
      input.replacementId,
    );
    const listed = parseResponse(
      z.array(volumeSchema),
      await this.request(
        "fly.workspace.replacement-volume.list",
        `/apps/${encodeURIComponent(input.appName)}/volumes`,
        { method: "GET" },
      ),
    );
    const existing = listed.find((volume) => volume.name === name);
    const volume =
      existing ??
      parseResponse(
        volumeSchema,
        await this.request(
          "fly.workspace.replacement-volume.create",
          `/apps/${encodeURIComponent(input.appName)}/volumes`,
          {
            method: "POST",
            body: jsonBody({
              name,
              region: input.region,
              size_gb: KESTREL_WORKSPACE_VOLUME_GB,
              encrypted: true,
              snapshot_retention: 14,
              auto_backup_enabled: false,
              require_unique_zone: false,
              ...(input.snapshotId ? { snapshot_id: input.snapshotId } : {}),
            }),
          },
        ),
      );
    const createdVolume =
      volume.state && volume.state !== "created"
        ? await this.waitForVolumeCreated(input.appName, volume.id)
        : volume;
    return checkedVolume(createdVolume, input.region);
  }

  async isWorkspaceSnapshotUsable(input: {
    appName: string;
    sourceVolumeId: string;
    snapshotId: string;
  }): Promise<boolean> {
    const snapshots = await this.listVolumeSnapshots({
      appName: input.appName,
      volumeId: input.sourceVolumeId,
    });
    const snapshot = snapshots.find(
      (candidate) => candidate.id === input.snapshotId,
    );
    return snapshot?.state === "created";
  }

  async listVolumeSnapshots(input: { appName: string; volumeId: string }) {
    const snapshots = parseResponse(
      volumeSnapshotsSchema,
      await this.request(
        "fly.workspace.snapshot.list",
        `/apps/${encodeURIComponent(input.appName)}/volumes/${encodeURIComponent(input.volumeId)}/snapshots`,
        { method: "GET" },
      ),
    );
    return snapshots.map((snapshot) => {
      const state = snapshot.status ?? snapshot.state;
      if (!state) {
        throw new EnvironmentProviderError(
          "FLY_RESPONSE_INVALID",
          "Fly returned an invalid snapshot record.",
        );
      }
      return { id: snapshot.id, state };
    });
  }

  private async waitForVolumeCreated(appName: string, volumeId: string) {
    const deadline = Date.now() + FLY_RESOURCE_PERSISTENCE_TIMEOUT_MS;
    while (true) {
      const volume = parseResponse(
        volumeSchema,
        await this.request(
          "fly.workspace.replacement-volume.get",
          `/apps/${encodeURIComponent(appName)}/volumes/${encodeURIComponent(volumeId)}`,
          {
            method: "GET",
          },
        ),
      );
      if (!volume.state || volume.state === "created") return volume;
      if (Date.now() >= deadline) {
        throw new EnvironmentProviderError(
          "FLY_PROVIDER_UNAVAILABLE",
          "Fly replacement Volume was not created before the readiness deadline.",
        );
      }
      await this.sleepImpl(this.healthPollIntervalMs);
    }
  }

  async ensureWorkspaceMachine(
    input: WorkspaceMachineProvisioningInput,
  ): Promise<EnvironmentProviderMachine> {
    const listed = parseResponse(
      z.array(machineSchema),
      await this.request(
        "fly.workspace.machine.list",
        `/apps/${encodeURIComponent(input.appName)}/machines?metadata.kestrel_workspace_id=${encodeURIComponent(input.workspaceId)}`,
        { method: "GET" },
      ),
    );
    const existing = listed.find(
      (machine) =>
        machine.config?.metadata?.kestrel_workspace_id === input.workspaceId &&
        machine.config.metadata.kestrel_replacement_id === undefined,
    );
    if (existing) {
      if (existing.region !== input.region) {
        throw new EnvironmentProviderError(
          "FLY_RESOURCE_CONFLICT",
          "Existing Workspace Machine is in a different region.",
        );
      }
      return toMachine(
        await this.reconcileWorkspaceServiceToken({
          appName: input.appName,
          machine: existing,
          serviceToken: input.serviceToken,
        }),
      );
    }

    return this.createWorkspaceMachine(
      input,
      workspaceMachineName(input.workspaceId),
    );
  }

  async createReplacementWorkspaceMachine(
    input: WorkspaceMachineProvisioningInput & { replacementId: string },
  ): Promise<EnvironmentProviderMachine> {
    const listed = parseResponse(
      z.array(machineSchema),
      await this.request(
        "fly.workspace.replacement-machine.list",
        `/apps/${encodeURIComponent(input.appName)}/machines?metadata.kestrel_replacement_id=${encodeURIComponent(input.replacementId)}`,
        { method: "GET" },
      ),
    );
    const existing = listed.find(
      (machine) =>
        machine.config?.metadata?.kestrel_workspace_id === input.workspaceId &&
        machine.config.metadata.kestrel_replacement_id === input.replacementId,
    );
    if (existing) {
      return toMachine(
        await this.reconcileWorkspaceServiceToken({
          appName: input.appName,
          machine: existing,
          serviceToken: input.serviceToken,
        }),
      );
    }
    return this.createWorkspaceMachine(
      input,
      replacementWorkspaceMachineName(input.workspaceId, input.replacementId),
      input.replacementId,
    );
  }

  private async createWorkspaceMachine(
    input: WorkspaceMachineProvisioningInput,
    name: string,
    replacementId?: string,
  ) {
    const machine = parseResponse(
      machineCreateResponseSchema,
      await this.request(
        "fly.workspace.machine.create",
        `/apps/${encodeURIComponent(input.appName)}/machines`,
        {
          method: "POST",
          body: jsonBody({
            name,
            region: input.region,
            skip_launch: false,
            config: workspaceMachineConfig(input, replacementId),
          }),
        },
      ),
    );
    return {
      id: machine.id,
      state: "created",
      region: input.region,
    };
  }

  private async reconcileWorkspaceServiceToken(input: {
    appName: string;
    machine: z.infer<typeof machineSchema>;
    serviceToken?: string | undefined;
  }) {
    if (
      !input.serviceToken ||
      input.machine.config?.env?.KESTREL_WORKSPACE_SERVICE_TOKEN ===
        input.serviceToken
    )
      return input.machine;
    if (!input.machine.config) {
      throw new EnvironmentProviderError(
        "FLY_RESOURCE_CONFLICT",
        "Existing Workspace Machine configuration is unavailable for service identity rotation.",
      );
    }
    return parseResponse(
      machineSchema,
      await this.request(
        "fly.workspace.machine.identity.update",
        `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machine.id)}`,
        {
          method: "POST",
          body: jsonBody({
            config: {
              ...input.machine.config,
              env: {
                ...input.machine.config.env,
                KESTREL_WORKSPACE_SERVICE_TOKEN: input.serviceToken,
              },
            },
          }),
        },
      ),
    );
  }

  async getMachine(input: {
    appName: string;
    machineId: string;
  }): Promise<EnvironmentProviderMachine | null> {
    const response = await this.request(
      "fly.machine.get",
      `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}`,
      { method: "GET" },
      { allowNotFound: true },
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
        await this.request("fly.machine.start", startPath, { method: "POST" });
        return;
      } catch (error) {
        if (
          !(
            error instanceof EnvironmentProviderError &&
            (error.code === "FLY_PROVIDER_UNAVAILABLE" ||
              [408, 409, 412].includes(error.status ?? 0))
          )
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
        const authoritativeState = {
          machineId: machine?.id ?? input.machineId,
          state: machine?.state ?? "unavailable",
          image: machine?.image,
        };
        if (error.code === "FLY_PROVIDER_UNAVAILABLE" || error.status === 408) {
          Object.assign(error, { authoritativeState });
          throw error;
        }
        if (machine?.state === "stopping") {
          await this.waitForMachine({
            ...input,
            state: "stopped",
            timeoutSeconds: 60,
          });
        } else if (machine?.state === "replacing") {
          await this.waitForMachine({
            ...input,
            state: "started",
            timeoutSeconds: 60,
          });
          return;
        } else if (
          machine?.state !== "stopped" &&
          machine?.state !== "created"
        ) {
          throw new EnvironmentProviderError(
            "FLY_PROVIDER_REJECTED",
            `Fly Machine start was rejected while the authoritative Machine state was ${machine?.state ?? "unavailable"}.`,
            412,
          );
        }
        if (retriesRemaining === 0) {
          throw Object.assign(
            new EnvironmentProviderError(
              "FLY_PROVIDER_REJECTED",
              "Fly Machine remained stopped after 10 bounded start retries.",
              412,
            ),
            { authoritativeState },
          );
        }
        retriesRemaining -= 1;
        await this.sleepImpl(MACHINE_START_RETRY_INTERVAL_MS);
      }
    }
  }

  async stopMachine(input: { appName: string; machineId: string }) {
    await this.request(
      "fly.machine.stop",
      `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}/stop`,
      { method: "POST", body: jsonBody({}) },
    );
  }

  async deleteMachine(input: { appName: string; machineId: string }) {
    await this.request(
      "fly.machine.delete",
      `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}?force=true`,
      { method: "DELETE" },
      { allowNotFound: true },
    );
  }

  async deleteVolume(input: { appName: string; volumeId: string }) {
    await this.request(
      "fly.volume.delete",
      `/apps/${encodeURIComponent(input.appName)}/volumes/${encodeURIComponent(input.volumeId)}`,
      { method: "DELETE" },
      { allowNotFound: true },
    );
  }

  async reconcileWorkspaceVolumeBackupPolicy(input: {
    appName: string;
    volumeId: string;
  }) {
    await this.request(
      "fly.volume.backup-policy.update",
      `/apps/${encodeURIComponent(input.appName)}/volumes/${encodeURIComponent(input.volumeId)}`,
      {
        method: "PUT",
        body: jsonBody({
          auto_backup_enabled: false,
          snapshot_retention: 14,
        }),
      },
    );
  }

  async deleteEnvironmentApp(input: { appName: string }) {
    await this.request(
      "fly.environment.app.delete",
      `/apps/${encodeURIComponent(input.appName)}`,
      { method: "DELETE" },
      { allowNotFound: true },
    );
  }

  async listEnvironmentResources(input: {
    appName: string;
  }): Promise<EnvironmentProviderInventory> {
    const [machines, volumes] = await Promise.all([
      this.request(
        "fly.environment.machines.list",
        `/apps/${encodeURIComponent(input.appName)}/machines`,
        { method: "GET" },
      ),
      this.request(
        "fly.environment.volumes.list",
        `/apps/${encodeURIComponent(input.appName)}/volumes`,
        { method: "GET" },
      ),
    ]);
    return {
      machines: parseResponse(z.array(machineSchema), machines).map(
        (machine) => ({
          id: machine.id,
          state: machine.state,
          region: machine.region,
          workspaceId: machine.config?.metadata?.kestrel_workspace_id ?? null,
          replacementId:
            machine.config?.metadata?.kestrel_replacement_id ?? null,
          mountedVolumeIds:
            machine.config?.mounts?.map((mount) => mount.volume) ?? [],
        }),
      ),
      volumes: parseResponse(z.array(volumeSchema), volumes).map((volume) => ({
        id: volume.id,
        name: volume.name,
        region: volume.region,
        sizeGb: volume.size_gb,
        attachedMachineId: volume.attached_machine_id ?? null,
      })),
    };
  }

  async listAppMachines(input: { appName: string }) {
    const machines = parseResponse(
      z.array(machineSchema),
      await this.request(
        "fly.environment.machines.list",
        `/apps/${encodeURIComponent(input.appName)}/machines`,
        { method: "GET" },
      ),
    );
    return machines.map(toMachine);
  }

  async listTurnWorkerMachines(input: { appName: string }) {
    const machines = parseResponse(
      z.array(machineSchema),
      await this.request(
        "fly.turn-worker.machines.list",
        `/apps/${encodeURIComponent(input.appName)}/machines`,
        { method: "GET" },
      ),
    );
    return machines.map((machine): FlyTurnWorkerMachine => {
      const raw = machine.config?.env?.KESTREL_TURN_WORKER_CONCURRENCY;
      const configuredConcurrency = raw && /^[0-9]+$/u.test(raw) ? Number(raw) : null;
      const concurrencyConfiguration =
        raw === undefined
          ? "missing"
          : configuredConcurrency && configuredConcurrency >= 1 && configuredConcurrency <= 64
            ? "valid"
            : "invalid";
      const healthStatus =
        machine.checks?.find((check) => check.name === "worker")?.status ??
        (machine.state === "stopped" ? "stopped" : "missing");
      const workerHealthCheckConfigured = healthCheckMatches(
        machine.config?.checks,
        {
          name: "worker",
          port: 8081,
          path: "/healthz",
          timeoutSeconds: 5,
          gracePeriodSeconds: 30,
        },
      );
      const configurationFingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            checks: machine.config?.checks ?? null,
            entrypoint:
              (machine.config as Record<string, unknown> | undefined)
                ?.entrypoint ?? null,
            guest: machine.config?.guest ?? null,
            image: machine.config?.image ?? null,
            init:
              (machine.config as Record<string, unknown> | undefined)?.init ??
              null,
            processes:
              (machine.config as Record<string, unknown> | undefined)
                ?.processes ?? null,
          }),
        )
        .digest("hex");
      return {
        ...toMachine(machine),
        configuredConcurrency,
        concurrencyConfiguration,
        healthStatus,
        workerHealthCheckConfigured,
        configurationFingerprint,
      };
    });
  }

  async cloneMachineAsStoppedIndependent(input: {
    appName: string;
    machineId: string;
    runtimeImage: string;
    concurrency: number;
    healthCheck: FlyMachineHealthCheck;
  }) {
    return this.cloneTurnWorkerMachine({
      ...input,
      standbyForMachineIds: [],
    });
  }

  async cloneMachineAsStoppedStandby(input: {
    appName: string;
    machineId: string;
    runtimeImage: string;
    concurrency?: number | undefined;
    standbyForMachineIds: string[];
    healthCheck: FlyMachineHealthCheck;
  }) {
    return this.cloneTurnWorkerMachine(input);
  }

  private async cloneTurnWorkerMachine(input: {
    appName: string;
    machineId: string;
    runtimeImage: string;
    concurrency?: number | undefined;
    standbyForMachineIds: string[];
    healthCheck: FlyMachineHealthCheck;
  }) {
    const current = parseResponse(
      machineSchema,
      await this.request(
        "fly.machine.clone-source.get",
        `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}`,
        { method: "GET" },
      ),
    );
    if (!current.config) {
      throw new EnvironmentProviderError(
        "FLY_RESPONSE_INVALID",
        "Fly Machine configuration is unavailable for standby creation.",
      );
    }
    if (current.config.mounts?.length) {
      throw new EnvironmentProviderError(
        "FLY_RESOURCE_CONFLICT",
        "Platform deployment cannot clone a Machine with attached volumes.",
      );
    }
    return toMachine(
      parseResponse(
        machineSchema,
        await this.request(
          "fly.machine.standby.create",
          `/apps/${encodeURIComponent(input.appName)}/machines`,
          {
            method: "POST",
            body: jsonBody({
              region: current.region,
              skip_launch: true,
              config: {
                ...current.config,
                image: input.runtimeImage,
                env: {
                  ...current.config.env,
                  ...(input.concurrency
                    ? {
                        KESTREL_TURN_WORKER_CONCURRENCY: String(
                          input.concurrency,
                        ),
                      }
                    : {}),
                },
                standbys: input.standbyForMachineIds,
                checks: applyMachineHealthCheck(
                  current.config.checks,
                  input.healthCheck,
                ),
              },
            }),
          },
        ),
      ),
    );
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
              "fly.machine.get-before-wait",
              `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}`,
              { method: "GET" },
            ),
          ).instance_id
        : undefined;
    const deadline = Date.now() + (input.timeoutSeconds ?? 60) * 1000;
    while (true) {
      const remainingSeconds = Math.max(
        1,
        Math.ceil((deadline - Date.now()) / 1000),
      );
      const query = new URLSearchParams({
        state: input.state,
        timeout: String(Math.min(remainingSeconds, 60)),
      });
      if (instanceId) query.set("instance_id", instanceId);
      try {
        await this.request(
          "fly.machine.wait",
          `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}/wait?${query.toString()}`,
          { method: "GET" },
        );
        return;
      } catch (error) {
        if (!(error instanceof EnvironmentProviderError)) {
          throw error;
        }
        if (error.status === 408 || error.status === 409) {
          const machine = await this.getMachine(input);
          if (machine?.state === input.state) return;
          if (
            error.status === 409 &&
            machine?.state === "replacing" &&
            Date.now() < deadline
          ) {
            await this.sleepImpl(MACHINE_START_RETRY_INTERVAL_MS);
            continue;
          }
        }
        if (error.status !== 408 || Date.now() >= deadline) throw error;
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
      "Fly health check name",
    );
    const deadline = Date.now() + (input.timeoutSeconds ?? 60) * 1000;
    while (true) {
      const machine = parseResponse(
        machineSchema,
        await this.request(
          "fly.machine.health.get",
          `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}`,
          { method: "GET" },
        ),
      );
      const check = machine.checks?.find(
        (candidate) => candidate.name === checkName,
      );
      if (check?.status === "passing") return;
      if (Date.now() >= deadline) {
        const output = sanitizeHealthCheckOutput(check?.output);
        throw new EnvironmentProviderError(
          "FLY_MACHINE_UNHEALTHY",
          `Fly Machine ${machine.id} was ${machine.state}; health check ${checkName} was ${check?.status ?? "missing"} before the readiness deadline${output ? `: ${output}` : "."}`,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.healthPollIntervalMs),
      );
    }
  }

  async createVolumeSnapshot(input: { appName: string; volumeId: string }) {
    const response = parseResponse(
      snapshotResponseSchema,
      await this.request(
        "fly.volume.snapshot.create",
        `/apps/${encodeURIComponent(input.appName)}/volumes/${encodeURIComponent(input.volumeId)}/snapshots`,
        { method: "POST", body: jsonBody({}) },
      ),
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
    envPatch?: Record<string, string | undefined> | undefined;
    standbyForMachineIds?: string[] | undefined;
    stopConfig?: EnvironmentProviderMachineStopConfig | undefined;
    healthCheck?: FlyMachineHealthCheck | undefined;
  }) {
    const current = parseResponse(
      machineSchema,
      await this.request(
        "fly.machine.image.get",
        `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}`,
        {
          method: "GET",
        },
      ),
    );
    if (!current.config) {
      throw new EnvironmentProviderError(
        "FLY_RESPONSE_INVALID",
        "Fly Machine configuration is unavailable for image update.",
      );
    }
    const nextEnvironment = applyEnvironmentPatch(
      current.config.env ?? {},
      input.envPatch,
    );
    const nextChecks = input.healthCheck
      ? applyMachineHealthCheck(current.config.checks, input.healthCheck)
      : current.config.checks;
    if (
      sameImageDigest(current.config.image, input.runtimeImage) &&
      environmentsEqual(current.config.env ?? {}, nextEnvironment) &&
      standbyRelationshipsEqual(
        current.config.standbys,
        input.standbyForMachineIds,
      ) &&
      stopConfigsEqual(current.config.stop_config, input.stopConfig) &&
      healthCheckMatches(current.config.checks, input.healthCheck)
    ) {
      return toMachine(current);
    }
    let updated;
    try {
      updated = parseResponse(
        machineSchema,
        await this.request(
          "fly.machine.image.update",
          `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}`,
          {
            method: "POST",
            body: jsonBody({
              config: {
                ...current.config,
                image: input.runtimeImage,
                env: nextEnvironment,
                ...(input.standbyForMachineIds
                  ? { standbys: input.standbyForMachineIds }
                  : {}),
                ...(nextChecks ? { checks: nextChecks } : {}),
                ...(input.stopConfig ? { stop_config: input.stopConfig } : {}),
              },
              current_version: current.instance_id,
              skip_launch: current.state !== "started",
            }),
          },
        ),
      );
    } catch (error) {
      if (
        !(
          error instanceof EnvironmentProviderError &&
          (error.code === "FLY_PROVIDER_UNAVAILABLE" ||
            [408, 409, 412].includes(error.status ?? 0))
        )
      ) {
        throw error;
      }
      const authoritative = parseResponse(
        machineSchema,
        await this.request(
          "fly.machine.image.reconcile",
          `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}`,
          { method: "GET" },
        ),
      );
      if (
        !machineConfigurationMatches(authoritative.config, {
          runtimeImage: input.runtimeImage,
          environment: nextEnvironment,
          standbyForMachineIds: input.standbyForMachineIds,
          stopConfig: input.stopConfig,
          healthCheck: input.healthCheck,
        })
      ) {
        Object.assign(error, {
          authoritativeState: {
            machineId: authoritative.id,
            state: authoritative.state,
            image: authoritative.config?.image,
            instanceId: authoritative.instance_id,
          },
        });
        throw error;
      }
      updated = authoritative;
    }
    const applied = machineConfigurationMatches(updated.config, {
      runtimeImage: input.runtimeImage,
      environment: nextEnvironment,
      standbyForMachineIds: input.standbyForMachineIds,
      stopConfig: input.stopConfig,
      healthCheck: input.healthCheck,
    })
      ? updated
      : await this.waitForMachineConfiguration({
          appName: input.appName,
          machineId: input.machineId,
          runtimeImage: input.runtimeImage,
          environment: nextEnvironment,
          standbyForMachineIds: input.standbyForMachineIds,
          stopConfig: input.stopConfig,
          healthCheck: input.healthCheck,
        });
    return toMachine(applied);
  }

  private async waitForMachineConfiguration(input: {
    appName: string;
    machineId: string;
    runtimeImage: string;
    environment: Record<string, string>;
    standbyForMachineIds?: string[] | undefined;
    stopConfig?: EnvironmentProviderMachineStopConfig | undefined;
    healthCheck?: FlyMachineHealthCheck | undefined;
  }) {
    const deadline = Date.now() + FLY_RESOURCE_PERSISTENCE_TIMEOUT_MS;
    while (true) {
      const machine = parseResponse(
        machineSchema,
        await this.request(
          "fly.machine.configuration.wait",
          `/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machineId)}`,
          { method: "GET" },
        ),
      );
      if (
        machineConfigurationMatches(machine.config, {
          runtimeImage: input.runtimeImage,
          environment: input.environment,
          standbyForMachineIds: input.standbyForMachineIds,
          stopConfig: input.stopConfig,
          healthCheck: input.healthCheck,
        })
      ) {
        return machine;
      }
      if (Date.now() >= deadline) {
        throw new EnvironmentProviderError(
          "FLY_RESOURCE_CONFLICT",
          "Fly Machine did not persist the requested runtime configuration before the readiness deadline.",
        );
      }
      await this.sleepImpl(this.healthPollIntervalMs);
    }
  }

  private async request(
    phase: string,
    path: string,
    init: RequestInit,
    options: { allowNotFound?: boolean } = {},
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
        "Fly Machines API request failed.",
        { phase },
      );
    }
    if (response.status === 404 && options.allowNotFound) {
      return null;
    }
    if (!response.ok) {
      const providerDetail = await safeFlyProviderDetail(response);
      const requestId =
        response.headers.get("fly-request-id")?.trim() || undefined;
      throw new EnvironmentProviderError(
        "FLY_PROVIDER_REJECTED",
        `Fly Machines API rejected ${phase} (${response.status})${providerDetail ? `: ${providerDetail}` : "."}`,
        {
          phase,
          status: response.status,
          requestId,
          providerDetail,
        },
      );
    }
    if (response.status === 204) {
      return {};
    }
    return response.json().catch(() => ({}));
  }
}

async function safeFlyProviderDetail(response: Response) {
  try {
    const text = (await response.text()).slice(0, 4096);
    const payload = JSON.parse(text) as Record<string, unknown>;
    const detail = [payload.error, payload.message, payload.detail].find(
      (value): value is string =>
        typeof value === "string" && Boolean(value.trim()),
    );
    return sanitizeProviderDetail(detail);
  } catch {
    return ;
  }
}

export function sanitizeProviderDetail(value: string | undefined) {
  if (!value) return ;
  const sanitized = value
    .replace(
      /(authorization|api[-_ ]?key|access[-_ ]?token|token|secret|password)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/giu,
      "$1=[redacted]",
    )
    .replace(/FlyV1\s+\S+/gu, "FlyV1 [redacted]")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .slice(0, 300);
  return sanitized || undefined;
}

function sanitizeHealthCheckOutput(value: string | undefined) {
  return sanitizeProviderDetail(value) ?? "";
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
  replacementId?: string,
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
      KESTREL_ENVIRONMENT_GATEWAY_URL: `https://${input.appName}.fly.dev`,
      ...(input.serviceToken
        ? { KESTREL_WORKSPACE_SERVICE_TOKEN: input.serviceToken }
        : {}),
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
    stop_config: KESTREL_WORKSPACE_STOP_CONFIG,
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
  controlPlaneUrl: string;
  serviceToken: string;
  initExec?: string[] | undefined;
}) {
  return {
    image: input.runtimeImage,
    auto_destroy: false,
    ...(input.initExec ? { init: { exec: input.initExec } } : {}),
    env: {
      KESTREL_ENVIRONMENT_APP_NAME: input.appName,
      KESTREL_ENVIRONMENT_ID: input.environmentId,
      KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: input.ticketPublicKey,
      KESTREL_CONTROL_PLANE_URL: input.controlPlaneUrl,
      KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN: input.serviceToken,
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
  region: string,
): EnvironmentProviderVolume {
  if (
    volume.region !== region ||
    volume.size_gb < KESTREL_WORKSPACE_VOLUME_GB ||
    volume.encrypted !== true
  ) {
    throw new EnvironmentProviderError(
      "FLY_RESOURCE_CONFLICT",
      "Fly Volume does not satisfy the Workspace storage contract.",
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

function canonicalEnvironmentTicketPublicKey(value: string) {
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    return key.export({ type: "spki", format: "pem" }).toString();
  } catch {
    throw new EnvironmentProviderError(
      "FLY_PROVIDER_REJECTED",
      "Environment ticket public key must be a valid Ed25519 public key.",
    );
  }
}

function canonicalExistingEnvironmentTicketPublicKey(
  value: string | undefined,
) {
  if (!value) return null;
  try {
    return canonicalEnvironmentTicketPublicKey(value);
  } catch {
    return null;
  }
}

function replacementWorkspaceVolumeName(
  workspaceId: string,
  replacementId: string,
) {
  return `ws_${compactId(workspaceId, 14)}_r_${compactId(replacementId, 8)}`;
}

function replacementWorkspaceMachineName(
  workspaceId: string,
  replacementId: string,
) {
  return `ws-${compactId(workspaceId, 14)}-r-${compactId(replacementId, 8)}`;
}

function compactId(value: string, length: number): string {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (!compact) {
    throw new EnvironmentProviderError(
      "FLY_RESPONSE_INVALID",
      "Provider resource identifier is invalid.",
    );
  }
  return compact.slice(0, length);
}

function toMachine(
  machine: z.infer<typeof machineSchema>,
): EnvironmentProviderMachine {
  return {
    id: machine.id,
    state: machine.state,
    region: machine.region,
    standbyForMachineIds: machine.config?.standbys ?? [],
    ...(machine.config?.guest?.cpu_kind
      ? { cpuKind: machine.config.guest.cpu_kind }
      : {}),
    ...(machine.config?.guest?.cpus ? { cpus: machine.config.guest.cpus } : {}),
    ...(machine.config?.guest?.memory_mb
      ? { memoryMb: machine.config.guest.memory_mb }
      : {}),
    ...(machine.config?.image ? { image: machine.config.image } : {}),
    ...(machine.image_ref?.digest
      ? { resolvedImageDigest: machine.image_ref.digest }
      : {}),
    ...(machine.instance_id ? { instanceId: machine.instance_id } : {}),
    ...(machine.config?.metadata?.kestrel_workspace_id
      ? { workspaceId: machine.config.metadata.kestrel_workspace_id }
      : {}),
    ...(machine.checks
      ? {
          checks: machine.checks.map((check) => {
            const output = sanitizeHealthCheckOutput(check.output);
            return {
              name: check.name,
              status: check.status,
              ...(output ? { output } : {}),
              ...(check.updated_at ? { updatedAt: check.updated_at } : {}),
            };
          }),
        }
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
    currentDigest && requestedDigest && currentDigest === requestedDigest,
  );
}

function applyEnvironmentPatch(
  current: Record<string, string>,
  patch: Record<string, string | undefined> | undefined,
) {
  const next = { ...current };
  for (const [name, value] of Object.entries(patch ?? {})) {
    if (value === undefined) delete next[name];
    else next[name] = value;
  }
  return next;
}

function environmentsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
) {
  const leftEntries = Object.entries(left).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const rightEntries = Object.entries(right).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function parseFlyDurationNanoseconds(value: string) {
  const unitNanoseconds: Record<string, number> = {
    ns: 1,
    us: 1000,
    µs: 1000,
    μs: 1000,
    ms: 1_000_000,
    s: 1_000_000_000,
    m: 60_000_000_000,
    h: 3_600_000_000_000,
  };
  const components = value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/gu);
  let cursor = 0;
  let total = 0;
  for (const component of components) {
    if (component.index !== cursor) return null;
    const amount = Number(component[1]);
    const multiplier = unitNanoseconds[component[2] ?? ""];
    if (!Number.isFinite(amount) || multiplier === undefined) return null;
    total += amount * multiplier;
    cursor += component[0].length;
  }
  return cursor === value.length && Number.isSafeInteger(total) ? total : null;
}

function stopConfigsEqual(
  current: { signal: string; timeout: number } | null | undefined,
  requested: EnvironmentProviderMachineStopConfig | undefined,
) {
  return (
    !requested ||
    (current?.signal === requested.signal &&
      current.timeout === requested.timeout)
  );
}

function machineConfigurationMatches(
  current:
    | {
        image?: string | undefined;
        env?: Record<string, string> | undefined;
        standbys?: string[] | undefined;
        stop_config?: { signal: string; timeout: number } | null | undefined;
        checks?: unknown;
      }
    | undefined,
  requested: {
    runtimeImage: string;
    environment: Record<string, string>;
    standbyForMachineIds?: string[] | undefined;
    stopConfig?: EnvironmentProviderMachineStopConfig | undefined;
    healthCheck?: FlyMachineHealthCheck | undefined;
  },
) {
  return Boolean(
    current?.image &&
    sameImageDigest(current.image, requested.runtimeImage) &&
    environmentsEqual(current.env ?? {}, requested.environment) &&
    standbyRelationshipsEqual(
      current.standbys,
      requested.standbyForMachineIds,
    ) &&
    stopConfigsEqual(current.stop_config, requested.stopConfig) &&
    healthCheckMatches(current.checks, requested.healthCheck),
  );
}

function standbyRelationshipsEqual(
  current: string[] | undefined,
  requested: string[] | undefined,
) {
  if (!requested) return true;
  return (
    JSON.stringify([...(current ?? [])].sort()) ===
    JSON.stringify([...requested].sort())
  );
}

function applyMachineHealthCheck(
  current: unknown,
  requested: FlyMachineHealthCheck,
) {
  const checks = isRecord(current) ? { ...current } : {};
  checks[requested.name] = {
    type: "http",
    port: requested.port,
    method: "GET",
    path: requested.path,
    interval: 15_000_000_000,
    timeout: requested.timeoutSeconds * 1_000_000_000,
    grace_period: requested.gracePeriodSeconds * 1_000_000_000,
  };
  return checks;
}

function healthCheckMatches(
  current: unknown,
  requested: FlyMachineHealthCheck | undefined,
) {
  if (!requested) return true;
  if (!isRecord(current)) return false;
  const check = current[requested.name];
  if (!isRecord(check)) return false;
  return (
    check.type === "http" &&
    check.port === requested.port &&
    String(check.method).toUpperCase() === "GET" &&
    check.path === requested.path &&
    machineDurationNanoseconds(check.interval) === 15_000_000_000 &&
    machineDurationNanoseconds(check.timeout) ===
      requested.timeoutSeconds * 1_000_000_000 &&
    machineDurationNanoseconds(check.grace_period) ===
      requested.gracePeriodSeconds * 1_000_000_000
  );
}

function machineDurationNanoseconds(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string") return parseFlyDurationNanoseconds(value);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "root";
    throw new EnvironmentProviderError(
      "FLY_RESPONSE_INVALID",
      `Fly Machines API returned an invalid response at ${path} (${issue?.code ?? "unknown"}).`,
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
      `${label} is not configured.`,
    );
  }
  return normalized;
}
