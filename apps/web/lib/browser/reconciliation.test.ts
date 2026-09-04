import assert from "node:assert/strict";
import test from "node:test";

import { parseBrowserSessionV1 } from "../../../../src/browser/contracts.js";
import { BROWSER_RUNTIME_RELEASE_MANIFEST } from "../../../../src/browser/runtimeReleaseManifest.js";
import type {
  BrowserMachineInfrastructureProvider,
  EnvironmentProviderMachine,
} from "@/lib/environments/providers/contracts";
import type { HostedBrowserResourceRecord } from "./store";
import {
  type HostedBrowserReconciliationRecord,
  type HostedBrowserReconciliationStore,
  reconcileHostedBrowserSessionsForEnvironment,
} from "./reconciliation";

const now = new Date("2026-08-30T12:00:00.000Z");
const digest = `registry.fly.io/browser@sha256:${"a".repeat(64)}`;

test("startup waits for create and attach visibility but never grants readiness", async () => {
  for (const attached of [false, true]) {
    const opening = record("opening");
    if (!attached) opening.resource = null;
    const fixture = makeFixture([opening], []);
    const result = await fixture.reconcile();
    assert.equal(result.pendingSessions, 1);
    assert.equal(result.healthySessions, 0);
    assert.deepEqual(fixture.events, []);
  }
});

test("an exact pinned image may still be resolving only during Fly startup", async () => {
  for (const state of ["created", "starting", "started"]) {
    const fixture = makeFixture(
      [record("opening")],
      [machine({ state, image: digest, resolvedImageDigest: undefined })],
    );
    const result = await fixture.reconcile();
    assert.equal(result.pendingSessions, state === "started" ? 0 : 1);
    assert.equal(result.lostSessions, state === "started" ? 1 : 0);
  }
});

test("startup deadline is exact, fixed at creation, and still applies after Fly starts", async () => {
  for (const openingAgeMs of [59_999, 60_000, 60_001]) {
    for (const state of ["starting", "started"]) {
      const fixture = makeFixture(
        [record("opening", { openingAgeMs })],
        [machine({ state })],
      );
      const result = await fixture.reconcile();
      assert.equal(result.pendingSessions, openingAgeMs < 60_000 ? 1 : 0);
      assert.deepEqual(
        fixture.events,
        openingAgeMs < 60_000
          ? []
          : ["terminal:lost", "delete:machine-1", "confirm"],
      );
    }
  }
});

test("a completed opening remains healthy past the startup deadline", async () => {
  const fixture = makeFixture([record("ready")], [machine()]);
  assert.equal((await fixture.reconcile()).healthySessions, 1);
  assert.deepEqual(fixture.events, []);
});

test("unattached startup expires and deletes only its exact owned Machine", async () => {
  const opening = record("opening", { openingAgeMs: 60_000 });
  opening.resource = null;
  const fixture = makeFixture(
    [opening],
    [
      machine({
        state: "created",
        image: digest,
        resolvedImageDigest: undefined,
      }),
    ],
  );
  assert.equal((await fixture.reconcile()).lostSessions, 1);
  assert.deepEqual(fixture.events, ["terminal:lost", "delete:machine-1"]);
});

test("startup never excuses an identity, image, region, mount, or stopped-state mismatch", async () => {
  for (const mismatch of [
    { browserSessionId: "foreign" },
    { browserGeneration: 2 },
    { region: "ord" },
    { resolvedImageDigest: `sha256:${"b".repeat(64)}` },
    { image: `registry.fly.io/browser@sha256:${"b".repeat(64)}` },
    { image: undefined, resolvedImageDigest: undefined },
    { mounts: [{ volumeId: "foreign", path: "/data" }] },
    { state: "stopped" },
  ]) {
    const fixture = makeFixture(
      [record("opening")],
      [machine({ state: "starting", ...mismatch })],
    );
    assert.equal((await fixture.reconcile()).lostSessions, 1);
    assert.equal(fixture.events[0], "terminal:lost");
  }
});

test("a stale provider list cannot delete a now-running ready worker", async () => {
  const fixture = makeFixture([record("ready")], [machine()]);
  fixture.machines.listBrowserMachines = async () => [
    machine({ state: "starting" }),
  ];
  assert.equal((await fixture.reconcile()).healthySessions, 1);
  assert.deepEqual(fixture.events, []);
});

test("ready, generation, and resource-attachment races prevent stale deletion", async () => {
  for (const race of ["ready", "generation", "machine", "attach"] as const) {
    const opening = record("opening", { openingAgeMs: 60_000 });
    if (race === "attach") opening.resource = null;
    const fixture = makeFixture([opening], [machine({ state: "starting" })]);
    const mark = fixture.store.markTerminal;
    fixture.store.markTerminal = async (input) => {
      if (race === "ready") opening.session.state = "ready";
      if (race === "generation") opening.session.generation = 2;
      if (race === "machine") opening.resource!.machineId = "replacement";
      if (race === "attach") opening.resource = record("opening").resource;
      return mark(input);
    };
    assert.equal((await fixture.reconcile()).failureCount, 1);
    assert.deepEqual(fixture.events, []);
  }
});

test("provider lookup failure leaves startup ownership and cleanup untouched", async () => {
  const fixture = makeFixture([record("opening")], [machine()]);
  fixture.machines.getMachine = async () => {
    throw new Error("unavailable");
  };
  assert.equal((await fixture.reconcile()).failureCount, 1);
  assert.deepEqual(fixture.events, []);
});

for (const state of ["created", "starting"]) {
  test(`does not delete an exact opening worker while Fly is ${state}`, async () => {
    const opening = record("opening");
    opening.session.createdAt = new Date(now.getTime() - 11_000).toISOString();
    opening.session.updatedAt = opening.session.createdAt;
    opening.session.lastActivityAt = opening.session.createdAt;
    const fixture = makeFixture([opening], [machine({ state })]);
    const result = await fixture.reconcile();
    assert.equal(result.lostSessions, 0);
    assert.deepEqual(fixture.events, []);
  });
}

test("preserves a matching opening worker within its deadlines", async () => {
  const fixture = makeFixture([record("opening")], [machine()]);
  const result = await fixture.reconcile();
  assert.equal(result.pendingSessions, 1);
  assert.deepEqual(fixture.events, []);
  assert.deepEqual(fixture.scope, {
    organizationId: "org-1",
    environmentId: "env-1",
    now,
  });
});

test("marks a missing opening worker lost after its startup deadline", async () => {
  const fixture = makeFixture(
    [record("opening", { openingAgeMs: 60_000 })],
    [],
  );
  const result = await fixture.reconcile();
  assert.equal(result.lostSessions, 1);
  assert.equal(result.cleanedSessions, 1);
  assert.deepEqual(fixture.events, [
    "terminal:lost",
    "delete:machine-1",
    "confirm",
  ]);
});

test("preserves an exact opening worker before its resource attach commits", async () => {
  const unattached = record("opening");
  unattached.resource = null;
  const fixture = makeFixture([unattached], [machine()]);
  const result = await fixture.reconcile();
  assert.equal(result.pendingSessions, 1);
  assert.deepEqual(fixture.events, []);
});

test("marks expiry durably before deleting and confirming cleanup", async () => {
  const fixture = makeFixture(
    [record("ready", { expired: true })],
    [machine()],
  );
  const result = await fixture.reconcile();
  assert.equal(result.expiredSessions, 1);
  assert.equal(result.cleanedSessions, 1);
  assert.deepEqual(fixture.events, [
    "terminal:expired",
    "delete:machine-1",
    "confirm",
  ]);
});

test("expires a resource-less opening and deletes its exact labeled worker", async () => {
  const unattached = record("opening", { expired: true });
  unattached.resource = null;
  const fixture = makeFixture([unattached], [machine()]);
  const result = await fixture.reconcile();
  assert.equal(result.expiredSessions, 1);
  assert.equal(result.cleanedSessions, 1);
  assert.deepEqual(fixture.events, ["terminal:expired", "delete:machine-1"]);
});

test("retries terminal cleanup after a deletion failure", async () => {
  const fixture = makeFixture([record("expired")], [machine()], true);
  const first = await fixture.reconcile();
  assert.equal(first.failureCount, 1);
  assert.equal(first.cleanedSessions, 0);
  assert.deepEqual(fixture.events, ["delete:machine-1"]);

  fixture.failDelete = false;
  fixture.events.length = 0;
  const second = await fixture.reconcile();
  assert.equal(second.failureCount, 0);
  assert.equal(second.cleanedSessions, 1);
  assert.deepEqual(fixture.events, ["delete:machine-1", "confirm"]);
});

test("fails a wrong worker closed before deletion", async () => {
  const fixture = makeFixture(
    [record("opening")],
    [machine({ browserGeneration: 2 })],
  );
  const result = await fixture.reconcile();
  assert.equal(result.lostSessions, 1);
  assert.deepEqual(fixture.events, [
    "terminal:lost",
    "delete:machine-1",
    "confirm",
  ]);
});

test("fails an attached worker from an obsolete configured release", async () => {
  const obsolete = record("ready");
  obsolete.resource!.workerImageDigest = `registry.fly.io/browser@sha256:${"b".repeat(64)}`;
  const fixture = makeFixture([obsolete], [machine()]);
  const result = await fixture.reconcile();
  assert.equal(result.lostSessions, 1);
  assert.deepEqual(fixture.events.slice(0, 3), [
    "terminal:lost",
    "delete:machine-1",
    "confirm",
  ]);
});

test("deletes Browser-labeled machines not owned by a scoped durable record", async () => {
  const fixture = makeFixture([], [machine({ id: "orphan-1" })]);
  const result = await fixture.reconcile();
  assert.equal(result.orphanMachinesDeleted, 1);
  assert.deepEqual(fixture.events, ["delete:orphan-1"]);
});

test("does not orphan a durable worker outside the bounded session batch", async () => {
  const fixture = makeFixture([], [machine()], false, ["machine-1"]);
  const result = await fixture.reconcile();
  assert.equal(result.orphanMachinesDeleted, 0);
  assert.deepEqual(fixture.events, []);
});

test("bounds deterministic orphan deletion to 100 Machines per run", async () => {
  const orphanMachines = Array.from({ length: 105 }, (_, index) =>
    machine({ id: `orphan-${String(index).padStart(3, "0")}` }),
  );
  const fixture = makeFixture([], orphanMachines);
  const result = await fixture.reconcile();
  assert.equal(result.orphanMachinesDeleted, 100);
  assert.equal(
    fixture.events.filter((event) => event.startsWith("delete:")).length,
    100,
  );
  assert.equal(fixture.events.includes("delete:orphan-104"), false);
});

test("bounds orphan deletion attempts when every deletion fails", async () => {
  const orphanMachines = Array.from({ length: 105 }, (_, index) =>
    machine({ id: `orphan-${String(index).padStart(3, "0")}` }),
  );
  const fixture = makeFixture([], orphanMachines, true);
  const result = await fixture.reconcile();
  assert.equal(result.orphanMachinesDeleted, 0);
  assert.equal(result.failureCount, 100);
  assert.equal(
    fixture.events.filter((event) => event.startsWith("delete:")).length,
    100,
  );
  assert.equal(fixture.events.includes("delete:orphan-100"), false);
});

test("bounds orphan deletion attempts across mixed outcomes", async () => {
  const orphanMachines = Array.from({ length: 105 }, (_, index) =>
    machine({ id: `orphan-${String(index).padStart(3, "0")}` }),
  );
  const failedMachineIds = Array.from(
    { length: 50 },
    (_, index) => `orphan-${String(index * 2).padStart(3, "0")}`,
  );
  const fixture = makeFixture([], orphanMachines, false, [], failedMachineIds);
  const result = await fixture.reconcile();
  assert.equal(result.orphanMachinesDeleted, 50);
  assert.equal(result.failureCount, 50);
  assert.equal(
    fixture.events.filter((event) => event.startsWith("delete:")).length,
    100,
  );
  assert.equal(fixture.events.includes("delete:orphan-100"), false);
});

function record(
  state: "opening" | "ready" | "expired",
  options: { expired?: boolean; openingAgeMs?: number } = {},
): HostedBrowserReconciliationRecord {
  const terminal = state === "expired";
  return {
    session: parseBrowserSessionV1({
      version: "browser_session_v1",
      sessionId: "session-1",
      threadId: "thread-1",
      mode: "operator",
      state,
      engineRevision: BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision,
      generation: 1,
      effectiveAllowlistRevision: "revision-1",
      createdAt:
        state === "opening" && !options.expired
          ? new Date(
              now.getTime() - (options.openingAgeMs ?? 11_000),
            ).toISOString()
          : "2026-08-30T10:00:00.000Z",
      updatedAt:
        state === "opening" && !options.expired
          ? now.toISOString()
          : "2026-08-30T10:30:00.000Z",
      lastActivityAt:
        state === "opening" && !options.expired
          ? now.toISOString()
          : "2026-08-30T10:30:00.000Z",
      idleExpiresAt: options.expired
        ? "2026-08-30T11:00:00.000Z"
        : "2026-08-30T12:30:00.000Z",
      hardExpiresAt: "2026-08-30T18:00:00.000Z",
      ...(terminal ? { terminalReason: "BROWSER_SESSION_EXPIRED" } : {}),
    }),
    resource: {
      sessionId: "session-1",
      originatingTurnId: "turn-1",
      previewLeaseId: null,
      machineId: "machine-1",
      machineGeneration: 1,
      workerImageDigest: digest,
      proxyAuthorityRevision: "revision-1",
      cleanupRequestedAt: terminal ? now : null,
      cleanupConfirmedAt: null,
    },
  };
}

function machine(
  overrides: Partial<EnvironmentProviderMachine> = {},
): EnvironmentProviderMachine {
  return {
    id: "machine-1",
    state: "started",
    region: "iad",
    browserSessionId: "session-1",
    browserGeneration: 1,
    resolvedImageDigest: `sha256:${"a".repeat(64)}`,
    mounts: [],
    ...overrides,
  };
}

function makeFixture(
  records: HostedBrowserReconciliationRecord[],
  initialMachines: EnvironmentProviderMachine[],
  initialFailDelete = false,
  additionalOwnedMachineIds: string[] = [],
  failedMachineIds: string[] = [],
) {
  const events: string[] = [];
  let scope: { organizationId: string; environmentId: string } | undefined;
  let failDelete = initialFailDelete;
  const machinesById = new Map(initialMachines.map((item) => [item.id, item]));
  const store: HostedBrowserReconciliationStore = {
    async read(sessionId) {
      return structuredClone(
        records.find((item) => item.session.sessionId === sessionId) ?? null,
      );
    },
    async listForReconciliation(input) {
      scope = input;
      return structuredClone(records);
    },
    async recordReconciliationAttempt() {},
    async ownsPendingMachine(input) {
      return (
        additionalOwnedMachineIds.includes(input.machineId) ||
        records.some(
          (item) =>
            (item.resource?.machineId === input.machineId &&
              item.resource.cleanupConfirmedAt === null) ||
            (item.resource === null &&
              item.session.state === "opening" &&
              item.session.sessionId === input.browserSessionId &&
              item.session.generation === input.browserGeneration),
        )
      );
    },
    async markTerminal(input) {
      const current = records.find(
        (item) => item.session.sessionId === input.sessionId,
      );
      if (!current) throw new Error("missing fixture session");
      if (
        input.expectedState !== current.session.state ||
        input.expectedGeneration !== current.session.generation ||
        input.expectedMachineId !== (current.resource?.machineId ?? null)
      ) {
        throw new Error("BROWSER_SESSION_LOST");
      }
      events.push(`terminal:${input.state}`);
      current.session = parseBrowserSessionV1({
        ...current.session,
        state: input.state,
        terminalReason: input.reason,
        updatedAt: input.now.toISOString(),
      });
      return current.session;
    },
    async confirmCleanup() {
      events.push("confirm");
    },
  };
  const machines = {
    async createBrowserMachine() {
      throw new Error("not used");
    },
    async listBrowserMachines(input: { sessionId?: string }) {
      return [...machinesById.values()].filter(
        (item) => !input.sessionId || item.browserSessionId === input.sessionId,
      );
    },
    async getMachine(input: { machineId: string }) {
      return machinesById.get(input.machineId) ?? null;
    },
    async deleteMachine(input: { machineId: string }) {
      events.push(`delete:${input.machineId}`);
      if (failDelete || failedMachineIds.includes(input.machineId)) {
        throw new Error("delete failed");
      }
      machinesById.delete(input.machineId);
    },
    async waitForMachine(input: { machineId: string }) {
      events.push(`wait:${input.machineId}`);
    },
  } as BrowserMachineInfrastructureProvider;
  return {
    events,
    records,
    machinesById,
    store,
    machines,
    get scope() {
      return scope;
    },
    get failDelete() {
      return failDelete;
    },
    set failDelete(value: boolean) {
      failDelete = value;
    },
    reconcile: () =>
      reconcileHostedBrowserSessionsForEnvironment({
        organizationId: "org-1",
        environmentId: "env-1",
        appName: "app-1",
        region: "iad",
        workerImageDigest: digest,
        store,
        machines,
        now,
      }),
  };
}
