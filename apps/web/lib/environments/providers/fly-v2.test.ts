import assert from "node:assert/strict";
import test from "node:test";
import {
  type EnvironmentInfrastructureProvider,
  EnvironmentProviderError,
  REQUIRED_ENVIRONMENT_PROVIDER_CAPABILITIES,
} from "./contracts";
import { EnvironmentProviderErrorV2 } from "./contracts-v2";
import { flyEnvironmentAppName } from "./fly-machines";
import {
  FlyEnvironmentInfrastructureProviderV2,
  mapFlyProviderError,
} from "./fly-v2";
import { EnvironmentInfrastructureProviderV2LegacyAdapter } from "./v2-legacy-adapter";

const identity = {
  organizationId: "organization-1",
  environmentId: "environment-1234567890",
};
const workspaceIdentity = { ...identity, workspaceId: "workspace-1" };
const placement = {
  connectionId: "organization-fly:organization-1",
  requested: { location: "iad" },
  observed: null,
};
const scope = {
  provider: "fly",
  role: "environment_scope",
  externalId: flyEnvironmentAppName(identity.environmentId),
} as const;
const storage = {
  provider: "fly",
  role: "workspace_storage",
  externalId: "volume-1",
} as const;
const compute = {
  provider: "fly",
  role: "workspace_compute",
  externalId: "machine-1",
} as const;
const snapshot = {
  provider: "fly",
  role: "snapshot",
  externalId: "snapshot-1",
} as const;
const desired = {
  runtimeImage: "registry.example.test/runtime@sha256:abc",
  ticketPublicKey: "public-key",
  controlPlaneUrl: "https://control.example.test",
  serviceToken: "service-token",
  source: { type: "blank" as const },
  idleTimeoutMinutes: 30,
};

test("Fly v2 maps every provider-neutral lifecycle method to the existing client", async () => {
  const fixture = legacyFixture();
  const provider = new FlyEnvironmentInfrastructureProviderV2(fixture.provider);

  const ensuredScope = await provider.ensureEnvironmentScope({ identity, placement });
  const gateway = await provider.ensureEnvironmentGateway({
    identity,
    scope,
    placement,
    runtimeImage: "router@sha256:abc",
    ticketPublicKey: "public-key",
    controlPlaneUrl: "https://control.example.test",
    serviceToken: "service-token",
  });
  const ensuredStorage = await provider.ensureWorkspaceStorage({
    identity: workspaceIdentity,
    scope,
    placement,
  });
  const ensuredCompute = await provider.ensureWorkspaceCompute({
    identity: workspaceIdentity,
    scope,
    storage,
    placement,
    desired,
  });
  await provider.getWorkspaceCompute({
    identity: workspaceIdentity,
    scope,
    compute,
  });
  await provider.startWorkspaceCompute({ identity: workspaceIdentity, scope, compute });
  await provider.stopWorkspaceCompute({ identity: workspaceIdentity, scope, compute });
  await provider.updateWorkspaceImage({
    identity: workspaceIdentity,
    scope,
    compute,
    runtimeImage: "runtime@sha256:def",
  });
  await provider.createWorkspaceSnapshot({
    identity: workspaceIdentity,
    scope,
    storage,
  });
  await provider.isWorkspaceSnapshotUsable({
    identity: workspaceIdentity,
    scope,
    storage,
    snapshot,
  });
  await provider.createReplacementWorkspaceStorage({
    identity: workspaceIdentity,
    scope,
    placement,
    replacementId: "replacement-1",
    sourceStorage: storage,
    snapshot,
  });
  await provider.createReplacementWorkspaceCompute({
    identity: workspaceIdentity,
    scope,
    storage,
    placement,
    replacementId: "replacement-1",
    desired,
  });
  await provider.listEnvironmentResources({ identity, scope });
  await provider.waitForWorkspaceState({
    identity: workspaceIdentity,
    scope,
    compute,
    state: "started",
  });
  await provider.waitForWorkspaceHealth({
    identity: workspaceIdentity,
    scope,
    compute,
    checkName: "workspace",
  });
  await provider.deleteWorkspaceCompute({ identity: workspaceIdentity, scope, compute });
  await provider.deleteWorkspaceStorage({ identity: workspaceIdentity, scope, storage });
  await provider.deleteEnvironmentScope({ identity, scope });

  assert.deepEqual(fixture.calls, [
    "ensureEnvironmentApp",
    "ensureEnvironmentGateway",
    "ensureWorkspaceVolume",
    "ensureWorkspaceMachine",
    "getMachine",
    "startMachine",
    "stopMachine",
    "updateMachineImage",
    "createVolumeSnapshot",
    "isWorkspaceSnapshotUsable",
    "createReplacementWorkspaceVolume",
    "createReplacementWorkspaceMachine",
    "listEnvironmentResources",
    "waitForMachine",
    "waitForMachineHealth",
    "deleteMachine",
    "deleteVolume",
    "deleteEnvironmentApp",
  ]);
  assert.equal(ensuredScope.resource.externalId, scope.externalId);
  assert.equal(gateway.resource.externalId, "gateway-machine");
  assert.equal(ensuredStorage.security.encryption, "provider_verified");
  assert.equal(ensuredCompute.resource.externalId, "machine-1");
  assert.equal(ensuredCompute.resolvedImageDigest, `sha256:${"a".repeat(64)}`);
  assert.deepEqual(fixture.inputs.ensureWorkspaceMachine, {
    appName: scope.externalId,
    environmentId: identity.environmentId,
    organizationId: identity.organizationId,
    workspaceId: workspaceIdentity.workspaceId,
    volumeId: storage.externalId,
    region: "iad",
    runtimeImage: desired.runtimeImage,
    ticketPublicKey: desired.ticketPublicKey,
    controlPlaneUrl: desired.controlPlaneUrl,
    serviceToken: desired.serviceToken,
    source: desired.source,
    idleTimeoutMinutes: desired.idleTimeoutMinutes,
  });
});

test("the legacy provisioner facade executes Fly lifecycle calls through v2 without behavior drift", async () => {
  const fixture = legacyFixture();
  const provider = new EnvironmentInfrastructureProviderV2LegacyAdapter(
    new FlyEnvironmentInfrastructureProviderV2(fixture.provider),
    {
      connectionId: placement.connectionId,
      provider: "fly",
      organizationId: identity.organizationId,
      environmentId: identity.environmentId,
      workspaceId: workspaceIdentity.workspaceId,
    },
  );
  const appName = flyEnvironmentAppName(identity.environmentId);
  const app = await provider.ensureEnvironmentApp({
    environmentId: identity.environmentId,
    appName,
    networkName: "environment-network",
  });
  const machine = await provider.ensureWorkspaceMachine({
    appName,
    environmentId: identity.environmentId,
    organizationId: identity.organizationId,
    workspaceId: workspaceIdentity.workspaceId,
    volumeId: storage.externalId,
    region: "iad",
    runtimeImage: desired.runtimeImage,
    ticketPublicKey: desired.ticketPublicKey,
    controlPlaneUrl: desired.controlPlaneUrl,
    serviceToken: desired.serviceToken,
    source: desired.source,
    idleTimeoutMinutes: desired.idleTimeoutMinutes,
  });

  assert.equal(app.name, appName);
  assert.equal(machine.id, "machine-1");
  assert.equal(machine.region, "iad");
  assert.equal(machine.workspaceId, workspaceIdentity.workspaceId);
  assert.deepEqual(machine.standbyForMachineIds, ["machine-primary"]);
});

test("Fly errors normalize without discarding native evidence", () => {
  const mapped = mapFlyProviderError(
    new EnvironmentProviderError(
      "FLY_PROVIDER_UNAVAILABLE",
      "Fly request failed.",
      {
        status: 503,
        phase: "fly.machine.start",
        requestId: "request-1",
        providerDetail: "upstream unavailable",
      },
    ),
  );
  assert.ok(mapped instanceof EnvironmentProviderErrorV2);
  assert.equal(mapped.code, "PROVIDER_UNAVAILABLE");
  assert.equal(mapped.retryable, true);
  assert.deepEqual(mapped.evidence, {
    level: "implementation",
    providerCode: "FLY_PROVIDER_UNAVAILABLE",
    httpStatus: 503,
    phase: "fly.machine.start",
    providerRequestId: "request-1",
    detail: "upstream unavailable",
  });
});

test("Fly conflict reconciliation evidence survives the v2 compatibility bridge", async () => {
  const fixture = legacyFixture();
  fixture.provider.startMachine = async () => {
    throw Object.assign(
      new EnvironmentProviderError(
        "FLY_RESOURCE_CONFLICT",
        "Machine is replacing.",
        { status: 409, phase: "fly.machine.start" },
      ),
      {
        authoritativeState: {
          machineId: compute.externalId,
          state: "replacing",
          image: desired.runtimeImage,
        },
      },
    );
  };
  const provider = new EnvironmentInfrastructureProviderV2LegacyAdapter(
    new FlyEnvironmentInfrastructureProviderV2(fixture.provider),
    {
      connectionId: placement.connectionId,
      provider: "fly",
      organizationId: identity.organizationId,
      environmentId: identity.environmentId,
      workspaceId: workspaceIdentity.workspaceId,
    },
  );

  await assert.rejects(
    () =>
      provider.startMachine({
        appName: scope.externalId,
        machineId: compute.externalId,
      }),
    (error) => {
      assert.ok(error instanceof EnvironmentProviderError);
      assert.equal(error.status, 409);
      assert.deepEqual(
        (error as EnvironmentProviderError & { authoritativeState?: unknown })
          .authoritativeState,
        {
          machineId: compute.externalId,
          state: "replacing",
          image: desired.runtimeImage,
        },
      );
      return true;
    },
  );
});

function legacyFixture() {
  const calls: string[] = [];
  const inputs: Record<string, unknown> = {};
  const record = <T>(name: string, input: T) => {
    calls.push(name);
    inputs[name] = input;
  };
  const machine = {
    id: "machine-1",
    state: "started",
    region: "iad",
    standbyForMachineIds: ["machine-primary"],
    cpuKind: "shared",
    cpus: 2,
    memoryMb: 4096,
    image: desired.runtimeImage,
    resolvedImageDigest: `sha256:${"a".repeat(64)}`,
    instanceId: "instance-1",
    workspaceId: workspaceIdentity.workspaceId,
    mounts: [{ volumeId: storage.externalId, path: "/workspace" }],
  };
  const provider: EnvironmentInfrastructureProvider = {
    descriptor: {
      id: "fly",
      label: "Fly.io Machines",
      capabilities: REQUIRED_ENVIRONMENT_PROVIDER_CAPABILITIES,
      evidence: "isolated_provider",
    },
    async ensureEnvironmentApp(input) {
      record("ensureEnvironmentApp", input);
      return {
        id: "app-id",
        name: input.appName,
        organizationSlug: "organization",
        network: input.networkName,
      };
    },
    async ensureEnvironmentGateway(input) {
      record("ensureEnvironmentGateway", input);
      return {
        machineId: "gateway-machine",
        state: "started",
        region: input.region,
        routerUrl: "https://environment.example.test",
        sharedIp: "203.0.113.10",
        serviceToken: input.serviceToken ?? "",
      };
    },
    async ensureWorkspaceVolume(input) {
      record("ensureWorkspaceVolume", input);
      return {
        id: storage.externalId,
        name: "workspace-volume",
        region: input.region,
        sizeGb: 20,
        encrypted: true,
      };
    },
    async ensureWorkspaceMachine(input) {
      record("ensureWorkspaceMachine", input);
      return machine;
    },
    async createReplacementWorkspaceVolume(input) {
      record("createReplacementWorkspaceVolume", input);
      return {
        id: "replacement-volume",
        name: "replacement-volume",
        region: input.region,
        sizeGb: 20,
        encrypted: true,
      };
    },
    async isWorkspaceSnapshotUsable(input) {
      record("isWorkspaceSnapshotUsable", input);
      return true;
    },
    async createReplacementWorkspaceMachine(input) {
      record("createReplacementWorkspaceMachine", input);
      return { ...machine, id: "replacement-machine" };
    },
    async getMachine(input) {
      record("getMachine", input);
      return machine;
    },
    async startMachine(input) {
      record("startMachine", input);
    },
    async stopMachine(input) {
      record("stopMachine", input);
    },
    async deleteMachine(input) {
      record("deleteMachine", input);
    },
    async deleteVolume(input) {
      record("deleteVolume", input);
    },
    async deleteEnvironmentApp(input) {
      record("deleteEnvironmentApp", input);
    },
    async listEnvironmentResources(input) {
      record("listEnvironmentResources", input);
      return {
        machines: [
          {
            id: machine.id,
            state: machine.state,
            region: machine.region,
            workspaceId: workspaceIdentity.workspaceId,
            replacementId: null,
            mountedVolumeIds: [storage.externalId],
          },
        ],
        volumes: [
          {
            id: storage.externalId,
            name: "workspace-volume",
            region: "iad",
            sizeGb: 20,
            attachedMachineId: machine.id,
          },
        ],
      };
    },
    async waitForMachine(input) {
      record("waitForMachine", input);
    },
    async waitForMachineHealth(input) {
      record("waitForMachineHealth", input);
    },
    async createVolumeSnapshot(input) {
      record("createVolumeSnapshot", input);
      return { id: snapshot.externalId, state: "created" };
    },
    async updateMachineImage(input) {
      record("updateMachineImage", input);
      return { ...machine, image: input.runtimeImage };
    },
  };
  return { provider, calls, inputs };
}
