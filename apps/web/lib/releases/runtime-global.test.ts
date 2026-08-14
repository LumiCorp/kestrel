import assert from "node:assert/strict";
import test from "node:test";
import type { EnvironmentProviderMachine } from "@/lib/environments/providers/contracts";
import {
  buildGlobalAppApplyingResult,
  isReleaseWorkerHeartbeatReady,
  isMatchingTurnWorkerHeartbeat,
  updateGlobalAppMachines,
  validateGlobalAppMachineTopology,
} from "./runtime";

const oldImage = `registry.fly.io/kestrel-one-turn-worker@sha256:${"a".repeat(64)}`;
const desiredImage = `registry.fly.io/kestrel-one-turn-worker@sha256:${"b".repeat(64)}`;

function machine(
  id: string,
  state: string,
  standbyForMachineIds: string[] = [],
): EnvironmentProviderMachine {
  return {
    id,
    state,
    region: "iad",
    image: oldImage,
    standbyForMachineIds,
  };
}

test("global topology accepts a started primary and stopped related standby", () => {
  assert.deepEqual(
    validateGlobalAppMachineTopology([
      machine("primary", "started"),
      machine("standby", "stopped", ["primary"]),
    ]).map(({ machine: item, expectedState }) => [item.id, expectedState]),
    [
      ["primary", "started"],
      ["standby", "stopped"],
    ],
  );
});

test("global topology accepts a promoted standby", () => {
  assert.doesNotThrow(() =>
    validateGlobalAppMachineTopology([
      machine("primary", "stopped"),
      machine("standby", "started", ["primary"]),
    ]),
  );
});

test("global topology accepts multiple ordinary started service Machines", () => {
  assert.doesNotThrow(() =>
    validateGlobalAppMachineTopology([
      machine("service-a", "started"),
      machine("service-b", "started"),
    ]),
  );
});

test("global topology rejects unrelated stopped Machines", () => {
  assert.throws(
    () =>
      validateGlobalAppMachineTopology([
        machine("service", "started"),
        machine("unrelated", "stopped"),
      ]),
    /unrelated non-running Machine 'unrelated'/u,
  );
});

test("global topology rejects malformed and ambiguous standby relationships", () => {
  assert.throws(
    () =>
      validateGlobalAppMachineTopology([
        machine("primary", "started"),
        machine("standby", "stopped", ["missing"]),
      ]),
    /malformed standby relationship/u,
  );
  assert.throws(
    () =>
      validateGlobalAppMachineTopology([
        machine("primary", "started"),
        machine("standby-a", "stopped", ["primary"]),
        machine("standby-b", "stopped", ["primary"]),
      ]),
    /ambiguous standby relationship/u,
  );
});

test("production-shaped global update preserves the stopped standby without a started wait", async () => {
  const before = [
    machine("080e9e56c72d08", "started"),
    machine("185d33ec3e5628", "stopped", ["080e9e56c72d08"]),
  ];
  const waits: Array<{ machineId: string; state: string }> = [];
  const updates: string[] = [];
  const client = {
    async updateMachineImage(input: { machineId: string }) {
      updates.push(input.machineId);
      const current = before.find((item) => item.id === input.machineId)!;
      return { ...current, image: desiredImage };
    },
    async waitForMachine(input: { machineId: string; state: string }) {
      waits.push(input);
    },
    async waitForMachineHealth() {},
    async getMachine(input: { machineId: string }) {
      const current = before.find((item) => item.id === input.machineId)!;
      return { ...current, image: desiredImage };
    },
  };

  await updateGlobalAppMachines({
    appName: "kestrel-one-turn-worker",
    client,
    desiredImage,
    machines: before,
    role: "turn-worker",
    sourceRevision: "a".repeat(40),
    waitForWorkerReadiness: async () => {},
  });

  assert.deepEqual(updates, ["185d33ec3e5628", "080e9e56c72d08"]);
  assert.deepEqual(waits, []);
});

test("turn-worker readiness rejects stale, wrong-revision, and wrong-fingerprint heartbeats", () => {
  const now = new Date("2026-08-13T12:00:30.000Z");
  const expected = {
    machineIds: ["primary"],
    sourceRevision: "a".repeat(40),
    configurationFingerprint: `sha256:${"b".repeat(64)}`,
    notBefore: new Date("2026-08-13T12:00:00.000Z"),
    now,
  };
  const heartbeat = {
    machineId: "primary",
    sourceRevision: expected.sourceRevision,
    configurationFingerprint: expected.configurationFingerprint,
    contractRevision: 1,
    processStartedAt: new Date("2026-08-13T12:00:01.000Z"),
    heartbeatAt: new Date("2026-08-13T12:00:29.000Z"),
  };
  assert.equal(isMatchingTurnWorkerHeartbeat(heartbeat, expected), true);
  assert.equal(
    isMatchingTurnWorkerHeartbeat(
      { ...heartbeat, sourceRevision: "c".repeat(40) },
      expected,
    ),
    false,
  );
  assert.equal(
    isMatchingTurnWorkerHeartbeat(
      {
        ...heartbeat,
        configurationFingerprint: `sha256:${"d".repeat(64)}`,
      },
      expected,
    ),
    false,
  );
  assert.equal(
    isMatchingTurnWorkerHeartbeat(
      {
        ...heartbeat,
        processStartedAt: new Date("2026-08-13T11:59:00.000Z"),
      },
      expected,
    ),
    false,
  );
});

test("global update waits for each Machine's pre-update state", async () => {
  const before = [
    machine("primary", "stopped"),
    machine("standby", "started", ["primary"]),
  ];
  const waits: Array<{ machineId: string; state: string }> = [];
  const client = {
    async updateMachineImage(input: { machineId: string }) {
      const current = before.find((item) => item.id === input.machineId)!;
      return { ...current, state: "updating", image: desiredImage };
    },
    async waitForMachine(input: { machineId: string; state: string }) {
      waits.push(input);
    },
    async waitForMachineHealth() {},
    async getMachine(input: { machineId: string }) {
      const current = before.find((item) => item.id === input.machineId)!;
      return { ...current, image: desiredImage };
    },
  };

  await updateGlobalAppMachines({
    appName: "kestrel-one-turn-worker",
    client,
    desiredImage,
    machines: before,
    role: "turn-worker",
    sourceRevision: "a".repeat(40),
    waitForWorkerReadiness: async () => {},
  });

  assert.deepEqual(waits, [
    {
      machineId: "primary",
      state: "stopped",
      appName: "kestrel-one-turn-worker",
      timeoutSeconds: 120,
    },
    {
      machineId: "standby",
      state: "started",
      appName: "kestrel-one-turn-worker",
      timeoutSeconds: 120,
    },
  ]);
});

test("global update rejects a persisted digest mismatch", async () => {
  const before = [machine("service", "started")];
  const client = {
    async updateMachineImage() {
      return { ...before[0]!, image: desiredImage };
    },
    async waitForMachine() {},
    async waitForMachineHealth() {},
    async getMachine() {
      return before[0]!;
    },
  };

  await assert.rejects(
    updateGlobalAppMachines({
      appName: "kestrel-one-turn-worker",
      client,
      desiredImage,
      machines: before,
      role: "turn-worker",
      sourceRevision: "a".repeat(40),
      waitForWorkerReadiness: async () => {},
    }),
    /did not remain started on the release digest/u,
  );
});

test("runpod worker update requires image readiness only for the started Machine", async () => {
  const before = [
    machine("primary", "started"),
    machine("standby", "stopped", ["primary"]),
  ];
  const readiness: string[] = [];
  const updates: Array<{
    machineId: string;
    envPatch?: Record<string, string | undefined>;
  }> = [];
  const client = {
    async updateMachineImage(input: {
      machineId: string;
      envPatch?: Record<string, string | undefined>;
    }) {
      updates.push(input);
      const current = before.find((item) => item.id === input.machineId)!;
      return { ...current, image: desiredImage };
    },
    async waitForMachine() {},
    async waitForMachineHealth() {},
    async getMachine(input: { machineId: string }) {
      const current = before.find((item) => item.id === input.machineId)!;
      return { ...current, image: desiredImage };
    },
  };
  await updateGlobalAppMachines({
    appName: "kestrel-one-runpod-worker",
    client,
    desiredImage,
    machines: before,
    role: "runpod-worker",
    sourceRevision: "a".repeat(40),
    waitForWorkerReadiness: async (input) => {
      readiness.push(input.machineId);
    },
  });
  assert.deepEqual(readiness, ["primary"]);
  assert.deepEqual(
    updates.map(({ machineId, envPatch }) => ({ machineId, envPatch })),
    [
      {
        machineId: "standby",
        envPatch: { KESTREL_RELEASE_IMAGE: desiredImage },
      },
      {
        machineId: "primary",
        envPatch: { KESTREL_RELEASE_IMAGE: desiredImage },
      },
    ],
  );
});

test("worker readiness rejects a fresh matching heartbeat from before the update", () => {
  const notBefore = new Date("2026-08-13T12:00:00.000Z");
  const heartbeat = {
    sourceRevision: "a".repeat(40),
    image: desiredImage,
    startedAt: new Date("2026-08-13T11:59:59.999Z"),
    heartbeatAt: new Date("2026-08-13T12:00:01.000Z"),
  };
  assert.equal(
    isReleaseWorkerHeartbeatReady({
      heartbeat,
      sourceRevision: heartbeat.sourceRevision,
      expectedDigest: `sha256:${"b".repeat(64)}`,
      notBefore,
      now: heartbeat.heartbeatAt,
    }),
    false,
  );
  heartbeat.startedAt = notBefore;
  assert.equal(
    isReleaseWorkerHeartbeatReady({
      heartbeat,
      sourceRevision: heartbeat.sourceRevision,
      expectedDigest: `sha256:${"b".repeat(64)}`,
      notBefore,
      now: heartbeat.heartbeatAt,
    }),
    true,
  );
});

test("a subsequent applying attempt preserves retry evidence", () => {
  assert.deepEqual(
    buildGlobalAppApplyingResult(
      {
        retryAttempt: 13,
        firstFailureAt: "2026-08-12T15:47:15.319Z",
        nextAttemptAt: "2026-08-12T16:32:30.777Z",
      },
      [
        machine("primary", "started"),
        machine("standby", "stopped", ["primary"]),
      ],
    ),
    {
      retryAttempt: 13,
      firstFailureAt: "2026-08-12T15:47:15.319Z",
      nextAttemptAt: "2026-08-12T16:32:30.777Z",
      machineIds: ["primary", "standby"],
    },
  );
});
