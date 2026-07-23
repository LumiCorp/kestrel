import assert from "node:assert/strict";
import {
  type EnvironmentInfrastructureProvider,
  EnvironmentProviderError,
} from "./providers/contracts";
import {
  EnvironmentProvisioner,
  type EnvironmentProvisioningRepository,
  type ProvisioningOperation,
} from "./provisioner";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


function fixture(
  type: string,
  workspaceId: string | null = null,
  input: Record<string, unknown> | null = null
) {
  const calls: string[] = [];
  let operation: ProvisioningOperation | null = {
    id: "operation-id",
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
    async setEnvironmentProvisioning() {
      calls.push("environment:provisioning");
    },
    async stageEnvironmentGatewayIdentity() {
      calls.push("environment:gateway-token-staged");
    },
    async setEnvironmentDeleting() {
      calls.push("environment:deleting");
    },
    async completeEnvironment() {
      calls.push("environment:ready");
    },
    async failEnvironment(input) {
      calls.push(`environment:failed:${input.code}`);
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

contractTest("web.hermetic", "Environment provisioning durably follows requested through ready", async () => {
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

contractTest("web.hermetic", "Environment updates preserve Workspaces, update ingress, and verify runtimes", async () => {
  const runtimeImage = `registry.fly.io/kestrel-one-runner@sha256:${"a".repeat(64)}`;
  const routerImage = `registry.fly.io/kestrel-one-runner@sha256:${"b".repeat(64)}`;
  const { repository, provider, calls } = fixture("environment.update", null, {
    runtimeImage,
    routerImage,
  });
  repository.listEnvironmentWorkspaces = async () => [
    {
      id: "workspace-id",
      flyMachineId: "workspace-machine-id",
      flyVolumeId: "workspace-volume-id",
    },
  ];
  const machineUpdates: Parameters<typeof provider.updateMachineImage>[0][] = [];
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
      calls.push(`backup:${input.workspaceId}`);
    }
  );
  assert.equal(await provisioner.process("operation-id"), "processed");
  assert.deepEqual(calls, [
    "operation:stage:environment.update.backing_up",
    "backup:workspace-id",
    "operation:stage:environment.update.gateway",
    "provider:image:gateway-machine-id",
    "environment:gateway-token-staged",
    "provider:wait",
    "provider:health",
    "environment:gateway-updated",
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
});

contractTest("web.hermetic", "Environment updates recover an incompatible stopped runtime from a pre-destructive snapshot", async () => {
  const runtimeImage = `registry.fly.io/kestrel-one-runner@sha256:${"a".repeat(64)}`;
  const routerImage = `registry.fly.io/kestrel-one-runner@sha256:${"b".repeat(64)}`;
  const { repository, provider, calls } = fixture("environment.update", null, {
    runtimeImage,
    routerImage,
  });
  repository.listEnvironmentWorkspaces = async () => [
    {
      id: "workspace-id",
      flyMachineId: "workspace-machine-id",
      flyVolumeId: "workspace-volume-id",
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
    "operation:stage:environment.update.backing_up",
    "backup:workspace-id",
    "provider:snapshot:workspace-volume-id",
    "workspace:starting",
    "provider:image:workspace-machine-id",
    "provider:wait",
    "provider:start",
    "provider:wait",
    "provider:health",
    "workspace:rebuilt",
    "backup:workspace-id",
    "operation:stage:environment.update.gateway",
  ]);
});

contractTest("web.hermetic", "Environment updates report Workspaces that require provisioning recovery", async () => {
  const runtimeImage = `registry.fly.io/kestrel-one-runner@sha256:${"a".repeat(64)}`;
  const routerImage = `registry.fly.io/kestrel-one-runner@sha256:${"b".repeat(64)}`;
  const { repository, provider } = fixture("environment.update", null, {
    runtimeImage,
    routerImage,
  });
  repository.listEnvironmentWorkspaces = async () => [
    {
      id: "ready-workspace",
      flyMachineId: "ready-machine",
      flyVolumeId: "ready-volume",
    },
    {
      id: "failed-workspace",
      flyMachineId: null,
      flyVolumeId: null,
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

contractTest("web.hermetic", "Workspace provisioning persists provider resources only after readiness", async () => {
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

contractTest("web.hermetic", "Workspace provisioning removes provisional resources after readiness failure", async () => {
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

contractTest("web.hermetic", "Provider failures are reflected on the resource and operation", async () => {
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

contractTest("web.hermetic", "transient Fly failures return the durable operation to its retry queue", async () => {
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

contractTest("web.hermetic", "Workspace provisioning defers without poisoning state until its Environment is ready", async () => {
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

contractTest("web.hermetic", "Workspace start wakes the existing Machine without reprovisioning storage", async () => {
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

contractTest("web.hermetic", "Workspace stop retains its Machine and persistent volume", async () => {
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

contractTest("web.hermetic", "Workspace idle stop continues from the control-plane stopping state", async () => {
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

contractTest("web.hermetic", "Workspace deletion removes the Machine before its volume", async () => {
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

contractTest("web.hermetic", "Environment deletion removes the owning Fly App idempotently", async () => {
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
  code: "ENVIRONMENT_IS_DEFAULT" | "ENVIRONMENT_HAS_PROJECTS",
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

contractTest("web.hermetic", "Environment deletion stops before provider teardown for ENVIRONMENT_IS_DEFAULT", () =>
  assertBlockedEnvironmentDeletion("ENVIRONMENT_IS_DEFAULT"));
contractTest("web.hermetic", "Environment deletion stops before provider teardown for ENVIRONMENT_HAS_PROJECTS", () =>
  assertBlockedEnvironmentDeletion("ENVIRONMENT_HAS_PROJECTS"));
