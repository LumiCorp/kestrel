import test from "node:test";
import assert from "node:assert/strict";
import {
  type EnvironmentInfrastructureProvider,
  EnvironmentProviderError,
} from "./providers/contracts";
import {
  EnvironmentProvisioner,
  releaseRetryDelaySeconds,
  releaseRetryNextAttemptAt,
  type EnvironmentProvisioningRepository,
  type ProvisioningOperation,
} from "./provisioner";

test("managed release retries use the bounded fixed schedule", () => {
  assert.deepEqual(
    Array.from({ length: 8 }, (_, index) => releaseRetryDelaySeconds(index + 1)),
    [5, 10, 20, 40, 80, 120, 120, 120],
  );
});

test("managed release retries stop exactly at the 15-minute deadline", () => {
  const firstFailureAt = "2026-08-05T12:00:00.000Z";
  const firstFailureTime = Date.parse(firstFailureAt);
  assert.equal(
    releaseRetryNextAttemptAt(firstFailureAt, 1, firstFailureTime),
    "2026-08-05T12:00:05.000Z",
  );
  assert.equal(
    releaseRetryNextAttemptAt(
      firstFailureAt,
      20,
      firstFailureTime + 14 * 60 * 1000,
    ),
    "2026-08-05T12:15:00.000Z",
  );
  assert.equal(
    releaseRetryNextAttemptAt(
      firstFailureAt,
      20,
      firstFailureTime + 15 * 60 * 1000,
    ),
    null,
  );
});


function fixture(
  type: string,
  workspaceId: string | null = null,
  input: Record<string, unknown> | null = null
) {
  const calls: string[] = [];
  let operation: ProvisioningOperation | null = {
    id: "operation-id",
    attempt: 1,
    organizationId: "organization-id",
    environmentId: "environment-id",
    workspaceId,
    requestedByUserId: "user-id",
    type,
    input,
  };
  const repository: EnvironmentProvisioningRepository = {
    async claimOperation() {
      const claimed = operation;
      operation = null;
      return claimed;
    },
    async getEnvironment() {
      return {
        id: "environment-id",
        organizationId: "organization-id",
        region: "iad",
        status: type === "environment.provision" ? "requested" : "ready",
        flyAppName:
          type === "environment.provision" ? null : "kestrel-env-existing",
        flyGatewayMachineId:
          type === "environment.provision" ? null : "gateway-machine-id",
        routerImage: "registry.example/router@sha256:def",
        runtimeImage: "registry.example/runtime@sha256:abc",
        idleTimeoutMinutes: 15,
      };
    },
    async getWorkspace() {
      return workspaceId
        ? {
            id: workspaceId,
            organizationId: "organization-id",
            environmentId: "environment-id",
            status: "requested",
            flyMachineId: null,
            flyVolumeId: null,
            runtimeImage: null,
            sourceType: "blank",
            sourceResourceId: null,
            sourceRepository: null,
            sourceDefaultBranch: null,
          }
        : null;
    },
    async listEnvironmentWorkspaces() {
      return [];
    },
    async beginEnvironmentProvisioning() {
      calls.push("environment:provisioning");
      return "prepared";
    },
    async stageEnvironmentGatewayIdentity() {
      calls.push("environment:gateway-token-staged");
      return "staged";
    },
    async setEnvironmentDeleting() {
      calls.push("environment:deleting");
    },
    async completeEnvironmentProvision() {
      calls.push("environment:ready");
      calls.push("operation:completed");
      return "completed";
    },
    async failEnvironment(input) {
      calls.push(`environment:failed:${input.code}`);
    },
    async failEnvironmentProvision(input) {
      calls.push(`environment:failed:${input.code}`);
      calls.push(`operation:failed:${input.code}`);
      return "failed";
    },
    async degradeEnvironment(input) {
      calls.push(`environment:degraded:${input.code}`);
    },
    async completeEnvironmentGatewayUpdate() {
      calls.push("environment:gateway-updated");
    },
    async completeEnvironmentRuntimeUpdate() {
      calls.push("environment:runtime-updated");
    },
    async completeEnvironmentDelete() {
      calls.push("environment:deleted");
    },
    async setWorkspaceProvisioning() {
      calls.push("workspace:provisioning");
    },
    async completeWorkspace() {
      calls.push("workspace:ready");
    },
    async failWorkspace(input) {
      calls.push(`workspace:failed:${input.code}`);
    },
    async setWorkspaceStarting() {
      calls.push("workspace:starting");
    },
    async setWorkspaceStopping() {
      calls.push("workspace:stopping");
    },
    async setWorkspaceDeleting() {
      calls.push("workspace:deleting");
    },
    async completeWorkspaceStart() {
      calls.push("workspace:ready");
    },
    async completeWorkspaceStop() {
      calls.push("workspace:stopped");
    },
    async completeWorkspaceDelete() {
      calls.push("workspace:deleted");
    },
    async completeWorkspaceRebuild() {
      calls.push("workspace:rebuilt");
    },
    async updateOperationStage(input) {
      calls.push(`operation:stage:${input.stage}`);
    },
    async completeOperation() {
      calls.push("operation:completed");
    },
    async failOperation(input) {
      calls.push(`operation:failed:${input.code}`);
    },
    async deferOperation(input) {
      calls.push(`operation:deferred:${input.message}`);
    },
  };
  const provider: EnvironmentInfrastructureProvider = {
    async ensureEnvironmentApp() {
      calls.push("provider:app");
      return {
        id: "app-id",
        name: "app-name",
        organizationSlug: "fly-org",
        network: "network-name",
      };
    },
    async ensureEnvironmentGateway() {
      calls.push("provider:gateway");
      return {
        machineId: "gateway-machine-id",
        state: "created",
        region: "iad",
        routerUrl: "https://app-name.fly.dev",
        sharedIp: "203.0.113.1",
        serviceToken: "gateway-service-token",
      };
    },
    async ensureWorkspaceVolume() {
      calls.push("provider:volume");
      return {
        id: "volume-id",
        name: "volume-name",
        region: "iad",
        sizeGb: 20,
        encrypted: true,
      };
    },
    async ensureWorkspaceMachine() {
      calls.push("provider:machine");
      return { id: "machine-id", state: "created", region: "iad" };
    },
    async createReplacementWorkspaceVolume() {
      return {
        id: "replacement-volume-id",
        name: "replacement-volume",
        region: "iad",
        sizeGb: 20,
        encrypted: true,
      };
    },
    async isWorkspaceSnapshotUsable() {
      return false;
    },
    async createReplacementWorkspaceMachine() {
      return { id: "replacement-machine-id", state: "started", region: "iad" };
    },
    async getMachine() {
      return null;
    },
    async startMachine() {},
    async stopMachine() {},
    async deleteMachine() {},
    async deleteVolume() {},
    async deleteEnvironmentApp() {},
    async listEnvironmentResources() {
      return { machines: [], volumes: [] };
    },
    async waitForMachine() {
      calls.push("provider:wait");
    },
    async waitForMachineHealth() {
      calls.push("provider:health");
    },
    async createVolumeSnapshot() {
      return { id: "snapshot-id", state: "prepare" };
    },
    async updateMachineImage() {
      return { id: "machine-id", state: "started", region: "iad" };
    },
  };
  return { repository, provider, calls };
}

function createProvisioner(
  repository: EnvironmentProvisioningRepository,
  provider: EnvironmentInfrastructureProvider,
  backupWorkspace?: ConstructorParameters<
    typeof EnvironmentProvisioner
  >[0]["backupWorkspace"]
) {
  return new EnvironmentProvisioner({
    repository,
    provider,
    runtimeImage: "registry.example/runtime@sha256:abc",
    routerImage: "registry.example/router@sha256:def",
    ticketPublicKey:
      "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
    controlPlaneUrl: "https://kestrel.example",
    backupWorkspace,
  });
}

test("Environment provisioning durably follows requested through ready", async () => {
  const { repository, provider, calls } = fixture("environment.provision");
  const provisioner = createProvisioner(repository, provider);
  assert.equal(await provisioner.process("operation-id"), "processed");
  assert.deepEqual(calls, [
    "environment:provisioning",
    "operation:stage:environment.runtime.connecting",
    "provider:app",
    "operation:stage:environment.machine.starting",
    "provider:gateway",
    "environment:gateway-token-staged",
    "provider:wait",
    "operation:stage:environment.health.checking",
    "provider:health",
    "environment:ready",
    "operation:completed",
  ]);
  assert.equal(await provisioner.process("operation-id"), "not_claimed");
});

test("Environment updates preserve Workspaces, update ingress, and verify runtimes", async () => {
  const runtimeImage = `registry.fly.io/kestrel-one-runner@sha256:${"a".repeat(64)}`;
  const routerImage = `registry.fly.io/kestrel-one-runner@sha256:${"b".repeat(64)}`;
  const { repository, provider, calls } = fixture("environment.update", null, {
    runtimeImage,
    routerImage,
    releaseTargetId: "release-target-id",
  });
  repository.listEnvironmentWorkspaces = async () => [
    {
      id: "workspace-id",
      status: "ready",
      flyMachineId: "workspace-machine-id",
      flyVolumeId: "workspace-volume-id",
      runtimeImage,
    },
  ];
  const machineUpdates: Parameters<typeof provider.updateMachineImage>[0][] = [];
  const backupInputs: Array<{
    parentReleaseTargetId?: string | undefined;
  }> = [];
  let gatewayUpdate:
    | Parameters<typeof repository.completeEnvironmentGatewayUpdate>[0]
    | undefined;
  let workspaceUpdate:
    | Parameters<typeof repository.completeWorkspaceRebuild>[0]
    | undefined;
  repository.completeEnvironmentGatewayUpdate = async (input) => {
    gatewayUpdate = input;
    calls.push("environment:gateway-updated");
  };
  repository.completeWorkspaceRebuild = async (input) => {
    workspaceUpdate = input;
    calls.push("workspace:rebuilt");
  };
  provider.updateMachineImage = async (input) => {
    machineUpdates.push(input);
    calls.push(`provider:image:${input.machineId}`);
    return { id: input.machineId, state: "replacing", region: "iad" };
  };
  provider.startMachine = async () => {
    calls.push("provider:start");
  };
  const provisioner = createProvisioner(
    repository,
    provider,
    async (input) => {
      backupInputs.push(input);
      calls.push(`backup:${input.workspaceId}`);
    }
  );
  assert.equal(await provisioner.process("operation-id"), "processed");
  assert.deepEqual(calls, [
    "operation:stage:environment.update.gateway",
    "provider:image:gateway-machine-id",
    "environment:gateway-token-staged",
    "provider:wait",
    "provider:health",
    "environment:gateway-updated",
    "operation:stage:environment.update.backing_up",
    "backup:workspace-id",
    "operation:stage:environment.update.workspaces",
    "workspace:starting",
    "provider:image:workspace-machine-id",
    "provider:wait",
    "provider:start",
    "provider:wait",
    "provider:health",
    "workspace:rebuilt",
    "operation:stage:environment.update.verifying",
    "environment:runtime-updated",
    "operation:completed",
  ]);
  assert.deepEqual(machineUpdates[0]?.envPatch, {
    KESTREL_ENVIRONMENT_ID: "environment-id",
    KESTREL_CONTROL_PLANE_URL: "https://kestrel.example",
    KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN:
      machineUpdates[0]?.envPatch?.KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN,
  });
  assert.ok(
    machineUpdates[0]?.envPatch?.KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN
  );
  assert.deepEqual(machineUpdates[1]?.envPatch, {
    KESTREL_ENVIRONMENT_GATEWAY_URL:
      "https://kestrel-env-existing.fly.dev",
    KESTREL_WORKSPACE_SERVICE_TOKEN:
      machineUpdates[1]?.envPatch?.KESTREL_WORKSPACE_SERVICE_TOKEN,
    KESTREL_ONE_CREDENTIAL_BROKER_TOKEN: undefined,
  });
  assert.ok(machineUpdates[1]?.envPatch?.KESTREL_WORKSPACE_SERVICE_TOKEN);
  assert.ok(gatewayUpdate?.gatewayServiceTokenHash);
  assert.ok(workspaceUpdate?.serviceTokenHash);
  assert.equal(backupInputs[0]?.parentReleaseTargetId, "release-target-id");
});

test("Environment updates recover an incompatible stopped runtime from a pre-destructive snapshot", async () => {
  const runtimeImage = `registry.fly.io/kestrel-one-runner@sha256:${"a".repeat(64)}`;
  const routerImage = `registry.fly.io/kestrel-one-runner@sha256:${"b".repeat(64)}`;
  const { repository, provider, calls } = fixture("environment.update", null, {
    runtimeImage,
    routerImage,
  });
  repository.listEnvironmentWorkspaces = async () => [
    {
      id: "workspace-id",
      status: "stopped",
      flyMachineId: "workspace-machine-id",
      flyVolumeId: "workspace-volume-id",
      runtimeImage,
    },
  ];
  provider.createVolumeSnapshot = async (input) => {
    calls.push(`provider:snapshot:${input.volumeId}`);
    return { id: "pre-destructive-snapshot", state: "created" };
  };
  provider.updateMachineImage = async (input) => {
    calls.push(`provider:image:${input.machineId}`);
    return { id: input.machineId, state: "replacing", region: "iad" };
  };
  provider.startMachine = async () => {
    calls.push("provider:start");
  };
  const backupInputs: Array<{
    preDestructiveSnapshot?: { id: string; state: string } | undefined;
  }> = [];
  const provisioner = createProvisioner(
    repository,
    provider,
    async (input) => {
      backupInputs.push(input);
      calls.push(`backup:${input.workspaceId}`);
      if (backupInputs.length === 1) {
        throw Object.assign(new Error("Environment activation timed out."), {
          code: "ENVIRONMENT_ACTIVATION_TIMEOUT",
        });
      }
    }
  );

  assert.equal(await provisioner.process("operation-id"), "processed");
  assert.deepEqual(backupInputs[1]?.preDestructiveSnapshot, {
    id: "pre-destructive-snapshot",
    state: "created",
  });
  assert.deepEqual(calls.slice(0, 12), [
    "operation:stage:environment.update.gateway",
    "provider:image:gateway-machine-id",
    "environment:gateway-token-staged",
    "provider:wait",
    "provider:health",
    "environment:gateway-updated",
    "operation:stage:environment.update.backing_up",
    "backup:workspace-id",
    "provider:snapshot:workspace-volume-id",
    "workspace:starting",
    "provider:image:workspace-machine-id",
    "provider:wait",
  ]);
});

test("operator-authorized maintenance updates can skip Workspace retention", async () => {
  const runtimeImage = `registry.fly.io/kestrel-one-runner@sha256:${"a".repeat(64)}`;
  const routerImage = `registry.fly.io/kestrel-one-runner@sha256:${"b".repeat(64)}`;
  const { repository, provider, calls } = fixture("environment.update", null, {
    runtimeImage,
    routerImage,
    skipWorkspaceBackups: true,
  });
  repository.listEnvironmentWorkspaces = async () => [
    {
      id: "workspace-id",
      status: "ready",
      flyMachineId: "workspace-machine-id",
      flyVolumeId: "workspace-volume-id",
      runtimeImage,
    },
  ];
  provider.updateMachineImage = async (input) => {
    calls.push(`provider:image:${input.machineId}`);
    return { id: input.machineId, state: "started", region: "iad" };
  };
  let backupCount = 0;
  let completionResult: Record<string, unknown> | undefined;
  repository.completeOperation = async (input) => {
    completionResult = input.result;
    calls.push("operation:completed");
  };
  const provisioner = createProvisioner(
    repository,
    provider,
    async () => {
      backupCount += 1;
    },
  );

  assert.equal(await provisioner.process("operation-id"), "processed");
  assert.equal(backupCount, 0);
  assert.ok(
    calls.includes("operation:stage:environment.update.backups_skipped"),
  );
  assert.equal(completionResult?.workspaceBackupsSkipped, true);
  assert.ok(calls.includes("provider:image:workspace-machine-id"));
});

test("managed releases reconfigure stopped Workspaces without launching them", async () => {
  const runtimeImage = `registry.fly.io/kestrel-one-runner@sha256:${"a".repeat(64)}`;
  const routerImage = `registry.fly.io/kestrel-one-runner@sha256:${"b".repeat(64)}`;
  const { repository, provider, calls } = fixture("environment.update", null, {
    runtimeImage,
    routerImage,
    preserveStoppedWorkspaces: true,
    automaticRollback: false,
  });
  repository.listEnvironmentWorkspaces = async () => [
    {
      id: "workspace-id",
      status: "stopped",
      flyMachineId: "workspace-machine-id",
      flyVolumeId: "workspace-volume-id",
      runtimeImage: "registry.example/runtime@sha256:old",
    },
  ];
  let configured:
    | Parameters<NonNullable<typeof repository.configureStoppedWorkspace>>[0]
    | undefined;
  let completion: Record<string, unknown> | undefined;
  let backupCount = 0;
  repository.configureStoppedWorkspace = async (input) => {
    configured = input;
    calls.push("workspace:configured-stopped");
  };
  repository.completeOperation = async (input) => {
    completion = input.result;
  };
  provider.createVolumeSnapshot = async (input) => {
    calls.push(`provider:snapshot:${input.volumeId}`);
    return { id: "snapshot-id", state: "created" };
  };
  provider.updateMachineImage = async (input) => ({
    id: input.machineId,
    state:
      input.machineId === "workspace-machine-id" ? "stopped" : "started",
    region: "iad",
  });
  provider.startMachine = async () => {
    calls.push("provider:start");
  };

  await createProvisioner(repository, provider, async () => {
    backupCount += 1;
  }).process("operation-id");

  assert.equal(backupCount, 0);
  assert.equal(calls.includes("provider:start"), false);
  assert.ok(calls.includes("provider:snapshot:workspace-volume-id"));
  assert.equal(configured?.workspaceId, "workspace-id");
  assert.equal(configured?.runtimeImage, runtimeImage);
  assert.deepEqual(completion?.configuredUnverifiedWorkspaceIds, [
    "workspace-id",
  ]);
});

test("Environment updates report Workspaces that require provisioning recovery", async () => {
  const runtimeImage = `registry.fly.io/kestrel-one-runner@sha256:${"a".repeat(64)}`;
  const routerImage = `registry.fly.io/kestrel-one-runner@sha256:${"b".repeat(64)}`;
  const { repository, provider } = fixture("environment.update", null, {
    runtimeImage,
    routerImage,
  });
  repository.listEnvironmentWorkspaces = async () => [
    {
      id: "ready-workspace",
      status: "ready",
      flyMachineId: "ready-machine",
      flyVolumeId: "ready-volume",
      runtimeImage,
    },
    {
      id: "failed-workspace",
      status: "failed",
      flyMachineId: null,
      flyVolumeId: null,
      runtimeImage,
    },
  ];
  let completion:
    | {
        stage: string;
        result: Record<string, unknown>;
      }
    | undefined;
  repository.completeOperation = async (input) => {
    completion = input;
  };
  provider.updateMachineImage = async (input) => ({
    id: input.machineId,
    state: "started",
    region: "iad",
  });

  await createProvisioner(repository, provider, async () => {}).process(
    "operation-id"
  );

  assert.deepEqual(completion, {
    operationId: "operation-id",
    stage: "environment.update.recovery_required",
    result: {
      gatewayMachineId: "gateway-machine-id",
      routerImage,
      runtimeImage,
      workspaceCount: 2,
      updatedWorkspaceCount: 1,
      skippedWorkspaceIds: ["failed-workspace"],
    },
  });
});

test("Workspace provisioning persists provider resources only after readiness", async () => {
  const { repository, provider, calls } = fixture(
    "workspace.provision",
    "workspace-id"
  );
  const provisioner = createProvisioner(repository, provider);
  await provisioner.process("operation-id");
  assert.deepEqual(calls, [
    "workspace:provisioning",
    "operation:stage:environment.workspace.mounting",
    "provider:volume",
    "operation:stage:environment.machine.starting",
    "provider:machine",
    "operation:stage:environment.machine.starting",
    "provider:wait",
    "operation:stage:environment.health.checking",
    "provider:health",
    "workspace:ready",
    "operation:completed",
  ]);
});

test("Workspace provisioning removes provisional resources after readiness failure", async () => {
  const { repository, provider, calls } = fixture(
    "workspace.provision",
    "workspace-id"
  );
  provider.waitForMachineHealth = async () => {
    calls.push("provider:health");
    throw new EnvironmentProviderError(
      "FLY_MACHINE_UNHEALTHY",
      "Workspace runtime contract did not become ready."
    );
  };
  provider.deleteMachine = async ({ machineId }) => {
    calls.push(`provider:delete-machine:${machineId}`);
  };
  provider.deleteVolume = async ({ volumeId }) => {
    calls.push(`provider:delete-volume:${volumeId}`);
  };

  await createProvisioner(repository, provider).process("operation-id");

  assert.deepEqual(calls.slice(-5), [
    "provider:health",
    "provider:delete-machine:machine-id",
    "provider:delete-volume:volume-id",
    "workspace:failed:FLY_MACHINE_UNHEALTHY",
    "operation:failed:FLY_MACHINE_UNHEALTHY",
  ]);
});

test("Provider failures are reflected on the resource and operation", async () => {
  const { repository, provider, calls } = fixture("environment.provision");
  provider.ensureEnvironmentApp = async () => {
    throw Object.assign(new Error("Fly rejected the request."), {
      code: "FLY_PROVIDER_REJECTED",
    });
  };
  const provisioner = createProvisioner(repository, provider);
  await provisioner.process("operation-id");
  assert.deepEqual(calls, [
    "environment:provisioning",
    "operation:stage:environment.runtime.connecting",
    "environment:failed:FLY_PROVIDER_REJECTED",
    "operation:failed:FLY_PROVIDER_REJECTED",
  ]);
});

test("transient Fly failures return the durable operation to its retry queue", async () => {
  const { repository, provider, calls } = fixture("environment.provision");
  provider.ensureEnvironmentApp = async () => {
    throw new EnvironmentProviderError(
      "FLY_PROVIDER_UNAVAILABLE",
      "Fly is temporarily unavailable."
    );
  };
  const provisioner = createProvisioner(repository, provider);
  assert.equal(await provisioner.process("operation-id"), "deferred");
  assert.deepEqual(calls, [
    "environment:provisioning",
    "operation:stage:environment.runtime.connecting",
    "operation:deferred:Fly is temporarily unavailable.",
  ]);
});

test("Fly request timeouts return the durable operation to its retry queue", async () => {
  const { repository, provider, calls } = fixture("environment.provision");
  provider.ensureEnvironmentApp = async () => {
    throw new EnvironmentProviderError(
      "FLY_PROVIDER_REJECTED",
      "Fly Machines API rejected the request (408).",
      408,
    );
  };
  const provisioner = createProvisioner(repository, provider);
  assert.equal(await provisioner.process("operation-id"), "deferred");
  assert.deepEqual(calls, [
    "environment:provisioning",
    "operation:stage:environment.runtime.connecting",
    "operation:deferred:Fly Machines API rejected the request (408).",
  ]);
});

test("Environment persistence failures after provider creation defer without poisoning lifecycle state", async () => {
  const { repository, provider, calls } = fixture("environment.provision");
  repository.stageEnvironmentGatewayIdentity = async () => {
    calls.push("environment:gateway-token-staged");
    throw new Error("database connection interrupted");
  };
  const provisioner = createProvisioner(repository, provider);

  assert.equal(await provisioner.process("operation-id"), "deferred");
  assert.deepEqual(calls, [
    "environment:provisioning",
    "operation:stage:environment.runtime.connecting",
    "provider:app",
    "operation:stage:environment.machine.starting",
    "provider:gateway",
    "environment:gateway-token-staged",
    "operation:deferred:Kestrel could not record Environment provisioning state. Retrying.",
  ]);
});

test("Environment completion persistence failures defer after gateway health succeeds", async () => {
  const { repository, provider, calls } = fixture("environment.provision");
  repository.completeEnvironmentProvision = async () => {
    calls.push("environment:completion-persist");
    throw new Error("transaction aborted");
  };
  const provisioner = createProvisioner(repository, provider);

  assert.equal(await provisioner.process("operation-id"), "deferred");
  assert.deepEqual(calls, [
    "environment:provisioning",
    "operation:stage:environment.runtime.connecting",
    "provider:app",
    "operation:stage:environment.machine.starting",
    "provider:gateway",
    "environment:gateway-token-staged",
    "provider:wait",
    "operation:stage:environment.health.checking",
    "provider:health",
    "environment:completion-persist",
    "operation:deferred:Kestrel could not record Environment provisioning state. Retrying.",
  ]);
});

test("a superseded provisioning attempt cannot overwrite newer gateway state", async () => {
  const { repository, provider, calls } = fixture("environment.provision");
  repository.stageEnvironmentGatewayIdentity = async () => {
    calls.push("environment:gateway-token-staged");
    return "superseded";
  };
  const provisioner = createProvisioner(repository, provider);

  assert.equal(await provisioner.process("operation-id"), "processed");
  assert.deepEqual(calls, [
    "environment:provisioning",
    "operation:stage:environment.runtime.connecting",
    "provider:app",
    "operation:stage:environment.machine.starting",
    "provider:gateway",
    "environment:gateway-token-staged",
  ]);
});

test("a superseded provisioning attempt exits before reading or changing lifecycle state", async () => {
  const { repository, provider, calls } = fixture("environment.provision");
  repository.beginEnvironmentProvisioning = async () => {
    calls.push("environment:superseded");
    return "superseded";
  };
  repository.getEnvironment = async () => {
    calls.push("environment:read");
    throw new Error("superseded work must not read lifecycle state");
  };
  const provisioner = createProvisioner(repository, provider);

  assert.equal(await provisioner.process("operation-id"), "processed");
  assert.deepEqual(calls, ["environment:superseded"]);
});

test("a superseded provisioning failure cannot overwrite newer lifecycle state", async () => {
  const { repository, provider, calls } = fixture("environment.provision");
  provider.ensureEnvironmentApp = async () => {
    throw Object.assign(new Error("Fly rejected the stale request."), {
      code: "FLY_PROVIDER_REJECTED",
    });
  };
  repository.failEnvironmentProvision = async () => {
    calls.push("environment:failure-superseded");
    return "superseded";
  };
  const provisioner = createProvisioner(repository, provider);

  assert.equal(await provisioner.process("operation-id"), "processed");
  assert.deepEqual(calls, [
    "environment:provisioning",
    "operation:stage:environment.runtime.connecting",
    "environment:failure-superseded",
  ]);
});

test("Workspace provisioning defers without poisoning state until its Environment is ready", async () => {
  const { repository, provider, calls } = fixture(
    "workspace.provision",
    "workspace-id"
  );
  repository.getEnvironment = async () => ({
    id: "environment-id",
    organizationId: "organization-id",
    region: "iad",
    status: "provisioning",
    flyAppName: null,
    flyGatewayMachineId: null,
    routerImage: null,
    runtimeImage: null,
    idleTimeoutMinutes: 15,
  });
  const provisioner = createProvisioner(repository, provider);
  assert.equal(await provisioner.process("operation-id"), "deferred");
  assert.deepEqual(calls, [
    "operation:deferred:Environment must be ready before its Workspace can be provisioned.",
  ]);
});

test("Workspace start wakes the existing Machine without reprovisioning storage", async () => {
  const { repository, provider, calls } = fixture(
    "workspace.start",
    "workspace-id"
  );
  repository.getWorkspace = async () => ({
    id: "workspace-id",
    organizationId: "organization-id",
    environmentId: "environment-id",
    status: "stopped",
    flyMachineId: "machine-id",
    flyVolumeId: "volume-id",
    runtimeImage: "registry.example/runtime@sha256:abc",
    sourceType: "blank",
    sourceResourceId: null,
    sourceRepository: null,
    sourceDefaultBranch: null,
  });
  provider.startMachine = async () => {
    calls.push("provider:start");
  };
  const provisioner = createProvisioner(repository, provider);
  await provisioner.process("operation-id");
  assert.deepEqual(calls, [
    "workspace:starting",
    "operation:stage:environment.machine.starting",
    "provider:start",
    "provider:wait",
    "operation:stage:environment.health.checking",
    "provider:health",
    "workspace:ready",
    "operation:completed",
  ]);
});

test("Workspace stop retains its Machine and persistent volume", async () => {
  const { repository, provider, calls } = fixture(
    "workspace.stop",
    "workspace-id"
  );
  repository.getWorkspace = async () => ({
    id: "workspace-id",
    organizationId: "organization-id",
    environmentId: "environment-id",
    status: "ready",
    flyMachineId: "machine-id",
    flyVolumeId: "volume-id",
    runtimeImage: "registry.example/runtime@sha256:abc",
    sourceType: "blank",
    sourceResourceId: null,
    sourceRepository: null,
    sourceDefaultBranch: null,
  });
  provider.stopMachine = async () => {
    calls.push("provider:stop");
  };
  await createProvisioner(repository, provider).process("operation-id");
  assert.deepEqual(calls, [
    "workspace:stopping",
    "operation:stage:environment.machine.stopping",
    "provider:stop",
    "provider:wait",
    "workspace:stopped",
    "operation:completed",
  ]);
});

test("Workspace idle stop continues from the control-plane stopping state", async () => {
  const { repository, provider, calls } = fixture(
    "workspace.stop",
    "workspace-id"
  );
  repository.getWorkspace = async () => ({
    id: "workspace-id",
    organizationId: "organization-id",
    environmentId: "environment-id",
    status: "stopping",
    flyMachineId: "machine-id",
    flyVolumeId: "volume-id",
    runtimeImage: "registry.example/runtime@sha256:abc",
    sourceType: "blank",
    sourceResourceId: null,
    sourceRepository: null,
    sourceDefaultBranch: null,
  });
  provider.stopMachine = async () => {
    calls.push("provider:stop");
  };
  await createProvisioner(repository, provider).process("operation-id");
  assert.deepEqual(calls, [
    "operation:stage:environment.machine.stopping",
    "provider:stop",
    "provider:wait",
    "workspace:stopped",
    "operation:completed",
  ]);
});

test("Workspace deletion removes the Machine before its volume", async () => {
  const { repository, provider, calls } = fixture(
    "workspace.delete",
    "workspace-id"
  );
  repository.getWorkspace = async () => ({
    id: "workspace-id",
    organizationId: "organization-id",
    environmentId: "environment-id",
    status: "stopped",
    flyMachineId: "machine-id",
    flyVolumeId: "volume-id",
    runtimeImage: "registry.example/runtime@sha256:abc",
    sourceType: "blank",
    sourceResourceId: null,
    sourceRepository: null,
    sourceDefaultBranch: null,
  });
  provider.deleteMachine = async () => {
    calls.push("provider:delete-machine");
  };
  provider.deleteVolume = async () => {
    calls.push("provider:delete-volume");
  };
  await createProvisioner(repository, provider).process("operation-id");
  assert.deepEqual(calls, [
    "workspace:deleting",
    "provider:delete-machine",
    "provider:delete-volume",
    "workspace:deleted",
    "operation:completed",
  ]);
});

test("Environment deletion removes the owning Fly App idempotently", async () => {
  const { repository, provider, calls } = fixture("environment.delete");
  provider.deleteEnvironmentApp = async () => {
    calls.push("provider:delete-app");
  };
  await createProvisioner(repository, provider).process("operation-id");
  assert.deepEqual(calls, [
    "environment:deleting",
    "provider:delete-app",
    "environment:deleted",
    "operation:completed",
  ]);
});

const assertBlockedEnvironmentDeletion = async (
  code:
    | "ENVIRONMENT_IS_DEFAULT"
    | "ENVIRONMENT_HAS_PROJECTS"
    | "ENVIRONMENT_HAS_PRIVATE_INFERENCE",
) => {
  const { repository, provider, calls } = fixture("environment.delete");
  repository.setEnvironmentDeleting = async () => {
    throw Object.assign(new Error("Deletion blocked."), { code });
  };
  provider.deleteEnvironmentApp = async () => {
    calls.push("provider:delete-app");
  };
  await createProvisioner(repository, provider).process("operation-id");
  assert.deepEqual(calls, [`operation:failed:${code}`]);
};

test("Environment deletion stops before provider teardown for ENVIRONMENT_IS_DEFAULT", () =>
  assertBlockedEnvironmentDeletion("ENVIRONMENT_IS_DEFAULT"));
test("Environment deletion stops before provider teardown for ENVIRONMENT_HAS_PROJECTS", () =>
  assertBlockedEnvironmentDeletion("ENVIRONMENT_HAS_PROJECTS"));
test("Environment deletion stops before provider teardown for ENVIRONMENT_HAS_PRIVATE_INFERENCE", () =>
  assertBlockedEnvironmentDeletion("ENVIRONMENT_HAS_PRIVATE_INFERENCE"));
