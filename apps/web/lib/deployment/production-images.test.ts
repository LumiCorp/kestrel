import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeProductionImageRequest,
  deployPlatformImage,
  isNewerProductionImage,
  productionImageInputSchema,
  ProductionImageAuthorizationError,
} from "./production-images";

const workerHealthCheck = {
  name: "worker",
  port: 8081,
  path: "/healthz",
  timeoutSeconds: 5,
  gracePeriodSeconds: 30,
};

test("production image input binds each platform role to its fixed repository", () => {
  const parsed = productionImageInputSchema.parse({
    kind: "platform",
    role: "turn-worker",
    image: "registry.fly.io/kestrel-one-turn-worker:production-42-1",
  });
  assert.equal(parsed.kind, "platform");
  if (parsed.kind === "platform") assert.equal(parsed.role, "turn-worker");
  assert.throws(() =>
    productionImageInputSchema.parse({
      kind: "platform",
      role: "turn-worker",
      image: "registry.fly.io/kestrel-one-control-worker:production-42-1",
    }),
  );
});

test("production image bearer authorization fails closed", () => {
  authorizeProductionImageRequest("Bearer exact-token", "exact-token");
  assert.throws(
    () => authorizeProductionImageRequest("Bearer wrong-token", "exact-token"),
    ProductionImageAuthorizationError,
  );
});

test("stale production ordering applies only within one repository", () => {
  assert.equal(
    isNewerProductionImage(
      "registry.fly.io/kestrel-one-turn-worker:production-43-1",
      "registry.fly.io/kestrel-one-turn-worker:production-42-2",
    ),
    true,
  );
  assert.equal(
    isNewerProductionImage(
      "registry.fly.io/wrong-worker:production-99-1",
      "registry.fly.io/kestrel-one-turn-worker:production-42-2",
    ),
    false,
  );
});

test("production runtime input binds both roles to one build", () => {
  const input = {
    kind: "environment-runtime",
    workspaceImage:
      "ghcr.io/lumicorp/kestrel-workspace-runtime:production-42-1",
    routerImage: "ghcr.io/lumicorp/kestrel-environment-router:production-42-1",
    sourceRevision: "a".repeat(40),
    githubRunId: "4200",
    githubRunAttempt: 1,
  } as const;
  assert.doesNotThrow(() => productionImageInputSchema.parse(input));
  assert.throws(() =>
    productionImageInputSchema.parse({
      ...input,
      routerImage:
        "ghcr.io/lumicorp/kestrel-environment-router:production-43-1",
    }),
  );
});

test("platform image deployment proves a stopped standby before updating the active Machine", async () => {
  const calls: string[] = [];
  const fly = fakeFly(calls);
  await deployPlatformImage({
    fly,
    appName: "kestrel-one-turn-worker",
    healthCheck: workerHealthCheck,
    image: "registry.fly.io/kestrel-one-turn-worker:production-42-1",
  });
  assert.deepEqual(calls, [
    "list",
    "update:standby",
    "start:standby",
    "wait:standby:started",
    "health:standby:worker",
    "update:active",
    "wait:active:started",
    "health:active:worker",
    "stop:standby",
    "wait:standby:stopped",
    "list",
  ]);
});

test("platform image deployment restores the stopped standby when its health fails", async () => {
  const calls: string[] = [];
  const fly = fakeFly(calls, "standby");
  await assert.rejects(
    deployPlatformImage({
      fly,
      appName: "kestrel-one-turn-worker",
      healthCheck: workerHealthCheck,
      image: "registry.fly.io/kestrel-one-turn-worker:production-42-1",
    }),
    /standby failed/u,
  );
  assert.equal(calls.includes("update:active"), false);
  assert.deepEqual(calls.slice(-2), ["stop:standby", "wait:standby:stopped"]);
});

test("platform image deployment keeps the proven standby running when the active Machine fails", async () => {
  const calls: string[] = [];
  const fly = fakeFly(calls, "active");
  await assert.rejects(
    deployPlatformImage({
      fly,
      appName: "kestrel-one-turn-worker",
      healthCheck: workerHealthCheck,
      image: "registry.fly.io/kestrel-one-turn-worker:production-42-1",
    }),
    /active failed/u,
  );
  assert.deepEqual(calls.slice(-2), ["stop:active", "wait:active:stopped"]);
  assert.equal(calls.includes("stop:standby"), false);
});

test("platform image deployment creates a stopped standby for a one-Machine app", async () => {
  const calls: string[] = [];
  const fly = fakeFly(calls, null, [
    { id: "active", state: "started", region: "iad", image: "old" },
  ]);
  await deployPlatformImage({
    fly,
    appName: "kestrel-one-runpod-worker",
    healthCheck: workerHealthCheck,
    image: "registry.fly.io/kestrel-one-runpod-worker:production-42-1",
  });
  assert.equal(calls[1], "clone:active");
  assert.deepEqual(calls.slice(-3), [
    "stop:standby",
    "wait:standby:stopped",
    "list",
  ]);
});

test("platform image deployment stops a failed bootstrap Machine", async () => {
  const calls: string[] = [];
  const fly = fakeFly(calls, "primary", [
    { id: "primary", state: "stopped", region: "iad", image: "old" },
    { id: "standby", state: "stopped", region: "iad", image: "old" },
  ]);
  await assert.rejects(
    deployPlatformImage({
      fly,
      appName: "kestrel-one-control-worker",
      healthCheck: workerHealthCheck,
      image: "registry.fly.io/kestrel-one-control-worker:production-42-1",
    }),
    /primary failed/u,
  );
  assert.deepEqual(calls.slice(-2), ["stop:primary", "wait:primary:stopped"]);
  assert.equal(calls.includes("update:standby"), false);
});

test("platform image deployment rejects an older build without mutating Machines", async () => {
  const calls: string[] = [];
  const result = await deployPlatformImage({
    fly: fakeFly(calls, null, [
      {
        id: "active",
        state: "started",
        region: "iad",
        image: "registry.fly.io/kestrel-one-turn-worker:production-43-1",
      },
      {
        id: "standby",
        state: "stopped",
        region: "iad",
        image: "registry.fly.io/kestrel-one-turn-worker:production-43-1",
      },
    ]),
    appName: "kestrel-one-turn-worker",
    healthCheck: workerHealthCheck,
    image: "registry.fly.io/kestrel-one-turn-worker:production-42-2",
  });
  assert.equal(result.stale, true);
  assert.deepEqual(calls, ["list"]);
});

test("platform image deployment refuses a transitional Machine inventory", async () => {
  const calls: string[] = [];
  await assert.rejects(
    deployPlatformImage({
      fly: fakeFly(calls, null, [
        { id: "active", state: "started", region: "iad", image: "old" },
        { id: "replacing", state: "replacing", region: "iad", image: "old" },
      ]),
      appName: "kestrel-one-control-worker",
      healthCheck: workerHealthCheck,
      image: "registry.fly.io/kestrel-one-control-worker:production-42-1",
    }),
    /replacing; retry after the app reaches a stable state/u,
  );
  assert.deepEqual(calls, ["list"]);
});

test("platform image deployment updates every stopped Machine before success", async () => {
  const calls: string[] = [];
  await deployPlatformImage({
    fly: fakeFly(calls, null, [
      { id: "active", state: "started", region: "iad", image: "old" },
      { id: "standby", state: "stopped", region: "iad", image: "old" },
      { id: "extra", state: "stopped", region: "iad", image: "old" },
    ]),
    appName: "kestrel-one-runpod-worker",
    healthCheck: workerHealthCheck,
    image: "registry.fly.io/kestrel-one-runpod-worker:production-42-1",
  });
  assert.ok(calls.includes("update:extra"));
  assert.equal(calls.at(-1), "list");
});

test("platform image deployment rejects one tag resolving to different digests", async () => {
  const calls: string[] = [];
  await assert.rejects(
    deployPlatformImage({
      fly: fakeFly(calls, null, undefined, (machineId) =>
        machineId === "active"
          ? `sha256:${"a".repeat(64)}`
          : `sha256:${"b".repeat(64)}`,
      ),
      appName: "kestrel-one-turn-worker",
      healthCheck: workerHealthCheck,
      image: "registry.fly.io/kestrel-one-turn-worker:production-42-1",
    }),
    /resolved .* to different image digests/u,
  );
});

function fakeFly(
  calls: string[],
  failHealth: string | null = null,
  machines = [
    { id: "active", state: "started", region: "iad", image: "old" },
    { id: "standby", state: "stopped", region: "iad", image: "old" },
  ],
  digestForMachine: (machineId: string) => string = () =>
    `sha256:${"c".repeat(64)}`,
) {
  const currentMachines: Array<{
    id: string;
    state: string;
    region: string;
    image: string;
    resolvedImageDigest?: string;
  }> = machines.map((machine) => ({ ...machine }));
  return {
    async listAppMachines() {
      calls.push("list");
      return currentMachines.map((machine) => ({ ...machine }));
    },
    async cloneMachineAsStoppedStandby(input: {
      machineId: string;
      runtimeImage: string;
    }) {
      calls.push(`clone:${input.machineId}`);
      const standby = {
        id: "standby",
        state: "stopped",
        region: "iad",
        image: input.runtimeImage,
        resolvedImageDigest: digestForMachine("standby"),
      };
      currentMachines.push(standby);
      return standby;
    },
    async updateMachineImage(input: {
      machineId: string;
      runtimeImage: string;
    }) {
      calls.push(`update:${input.machineId}`);
      const machine = currentMachines.find(
        (candidate) => candidate.id === input.machineId,
      );
      if (machine) {
        machine.image = input.runtimeImage;
        machine.resolvedImageDigest = digestForMachine(input.machineId);
      }
      return {
        id: input.machineId,
        state: machine?.state ?? "started",
        region: "iad",
        image: input.runtimeImage,
        resolvedImageDigest: digestForMachine(input.machineId),
      };
    },
    async startMachine(input: { machineId: string }) {
      calls.push(`start:${input.machineId}`);
      const machine = currentMachines.find(
        (candidate) => candidate.id === input.machineId,
      );
      if (machine) machine.state = "started";
    },
    async stopMachine(input: { machineId: string }) {
      calls.push(`stop:${input.machineId}`);
      const machine = currentMachines.find(
        (candidate) => candidate.id === input.machineId,
      );
      if (machine) machine.state = "stopped";
    },
    async waitForMachine(input: { machineId: string; state: string }) {
      calls.push(`wait:${input.machineId}:${input.state}`);
    },
    async waitForMachineHealth(input: {
      machineId: string;
      checkName: string;
    }) {
      calls.push(`health:${input.machineId}:${input.checkName}`);
      if (failHealth === input.machineId) {
        throw new Error(`${input.machineId} failed`);
      }
    },
  } as unknown as Parameters<typeof deployPlatformImage>[0]["fly"];
}
