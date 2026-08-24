import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { createWorkspaceBackupEncryptionStream } from "@/lib/environments/backup-crypto";
import {
  CanaryInconclusiveError,
  assertCanaryPreflight,
  assertFinalAttempt,
  assertFirstAttempt,
  assertNoTemporaryResources,
  exactCanaryConfirmation,
  parseWorkspaceBackupRetryCanaryArgs,
  readProviderVolumeSnapshots,
  runWorkspaceBackupRetryCanary,
  sanitizeCanaryEvidence,
  verifyKwb2Archive,
  type BackupObservation,
  type CanaryDependencies,
  type CanaryTarget,
} from "./workspace-backup-retry-canary";

test("snapshot inventory delegates to the organization-scoped provider", async () => {
  const calls: Array<{ appName: string; volumeId: string }> = [];
  const snapshots = await readProviderVolumeSnapshots({
    provider: {
      async listVolumeSnapshots(input) {
        calls.push(input);
        return [{ id: "snapshot-1", state: "running" }];
      },
    },
    appName: "tenant-environment-app",
    volumeId: "tenant-source-volume",
  });

  assert.deepEqual(calls, [
    {
      appName: "tenant-environment-app",
      volumeId: "tenant-source-volume",
    },
  ]);
  assert.deepEqual(snapshots, [{ id: "snapshot-1", state: "running" }]);
});

test("the executable keeps tenant snapshots and control-worker reads on separate authorities", async () => {
  const source = await readFile(
    new URL("../workspace-backup-retry-canary.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /createFlyProviderClient\(thread\.organizationId\)[\s\S]*readProviderVolumeSnapshots\(\{\s*provider,/u,
  );
  assert.match(
    source,
    /async function readSourceVolumeSnapshots[\s\S]*createFlyProviderClient\(target\.thread\.organizationId\)[\s\S]*readProviderVolumeSnapshots\(\{\s*provider,/u,
  );
  assert.match(
    source,
    /async function readControlWorkerMachines[\s\S]*captureJson\("fly", \[\s*"machine",\s*"list",/u,
  );
  assert.doesNotMatch(source, /"volumes",\s*"snapshots",\s*"list"/u);
});

test("arguments and exact confirmation bind every destructive target", () => {
  const args = parseWorkspaceBackupRetryCanaryArgs([
    "--",
    "--thread",
    "thread-1",
    "--control-worker-machine",
    "683e222c34d418",
    "--tag",
    "aug23-workspace-backup-retry",
  ]);
  assert.deepEqual(args, {
    threadId: "thread-1",
    controlWorkerMachineId: "683e222c34d418",
    tag: "aug23-workspace-backup-retry",
  });
  assert.equal(
    exactCanaryConfirmation(target()),
    "thread-1 workspace-1 worker-1 candidate-tag",
  );
  assert.throws(
    () => parseWorkspaceBackupRetryCanaryArgs(["--thread", "thread-1"]),
    /--control-worker-machine is required/u,
  );
  assert.throws(
    () =>
      parseWorkspaceBackupRetryCanaryArgs([
        "--thread",
        "thread-1",
        "--control-worker-machine",
        "bad-machine!",
        "--tag",
        "tag",
      ]),
    /exact Fly Machine ID/u,
  );
  assert.throws(
    () =>
      parseWorkspaceBackupRetryCanaryArgs([
        "--thread",
        "thread-1",
        "--control-worker-machine",
        "abc",
        "--tag",
        "tag",
        "--force",
      ]),
    /Unknown argument/u,
  );
});

test("preflight rejects Project, desktop, unready, active, or non-admin Workspaces", () => {
  const cases: Array<[string, (value: CanaryTarget) => void, RegExp]> = [
    [
      "Project Thread",
      (value) => void (value.thread.projectId = "project-1"),
      /no Project/u,
    ],
    [
      "Project Workspace",
      (value) => void (value.workspace.kind = "project"),
      /scratch Workspace/u,
    ],
    [
      "desktop",
      (value) => void (value.workspace.sourceType = "desktop"),
      /Desktop/u,
    ],
    [
      "unready",
      (value) => void (value.workspace.status = "starting"),
      /must be ready/u,
    ],
    [
      "active",
      (value) => value.activeLifecycleOperationIds.push("operation-1"),
      /lifecycle operation/u,
    ],
    [
      "shared",
      (value) => value.otherBoundThreadIds.push("thread-2"),
      /another Thread/u,
    ],
    [
      "member",
      (value) => void (value.actor.organizationRole = "member"),
      /administrator/u,
    ],
  ];
  for (const [name, mutate, expected] of cases) {
    const value = target();
    mutate(value);
    assert.throws(() => assertCanaryPreflight(value), expected, name);
  }
});

test("preflight rejects the wrong Machine, tag, health, or started-worker count", () => {
  const cases: Array<[(value: CanaryTarget) => void, RegExp]> = [
    [
      (value) =>
        void (value.controlWorker.selected = {
          ...value.controlWorker.selected,
          id: "worker-other",
        }),
      /only started/u,
    ],
    [
      (value) => void (value.controlWorker.selected.imageTag = "wrong"),
      /requested tag/u,
    ],
    [
      (value) =>
        void (value.controlWorker.selected.workerCheckStatus = "critical"),
      /health response/u,
    ],
    [
      (value) =>
        value.controlWorker.machines.push({
          ...value.controlWorker.selected,
          id: "worker-2",
        }),
      /only started/u,
    ],
  ];
  for (const [mutate, expected] of cases) {
    const value = target();
    mutate(value);
    assert.throws(() => assertCanaryPreflight(value), expected);
  }
});

test("first-attempt persistence requires one non-ready snapshot and no export resources", () => {
  const value = target();
  const first = observation({ state: "prepare", attempt: 1 });
  assert.deepEqual(
    assertFirstAttempt({
      target: value,
      observation: first,
      snapshots: [
        ...value.baseline.sourceVolumeSnapshots,
        { id: "snapshot-1", state: "prepare" },
      ],
      environment: value.baseline.environment,
    }),
    first.backup.manifest,
  );
  for (const snapshots of [
    value.baseline.sourceVolumeSnapshots,
    [
      ...value.baseline.sourceVolumeSnapshots,
      { id: "snapshot-1", state: "prepare" },
      { id: "snapshot-2", state: "prepare" },
    ],
  ]) {
    assert.throws(
      () =>
        assertFirstAttempt({
          target: value,
          observation: first,
          snapshots,
          environment: value.baseline.environment,
        }),
      /expected exactly one/u,
    );
  }
});

test("an already-created first snapshot is inconclusive and cannot authorize a crash", () => {
  const value = target();
  assert.throws(
    () =>
      assertFirstAttempt({
        target: value,
        observation: observation({ state: "created", attempt: 1 }),
        snapshots: [{ id: "snapshot-1", state: "created" }],
        environment: value.baseline.environment,
      }),
    CanaryInconclusiveError,
  );
});

test("final retry preserves snapshot identity, source volume, and requested timestamp", () => {
  const value = target();
  const first = observation({ state: "prepare", attempt: 1 });
  const final = observation({
    state: "created",
    attempt: 2,
    backupStatus: "available",
    operationStatus: "completed",
    stage: "workspace.backup.available",
    retryCount: 1,
    lastObservedAt: "2026-08-23T00:01:00.000Z",
  });
  first.backup.manifest!.persistedCanaryMarker = { durable: true };
  final.backup.manifest!.persistedCanaryMarker = { durable: true };
  assert.doesNotThrow(() =>
    assertFinalAttempt({
      target: value,
      first,
      final,
      snapshots: [{ id: "snapshot-1", state: "created" }],
      environment: value.baseline.environment,
      worker: value.controlWorker.selected,
    }),
  );
  for (const [key, changed, expected] of [
    ["flySnapshotId", "snapshot-2", /snapshot ID/u],
    ["flySnapshotSourceVolumeId", "volume-2", /source volume/u],
    [
      "flySnapshotRequestedAt",
      "2026-08-23T00:00:10.000Z",
      /requested timestamp/u,
    ],
  ] as const) {
    const invalid = structuredClone(final);
    invalid.backup.manifest![key] = changed;
    assert.throws(
      () =>
        assertFinalAttempt({
          target: value,
          first,
          final: invalid,
          snapshots: [{ id: "snapshot-1", state: "created" }],
          environment: value.baseline.environment,
          worker: value.controlWorker.selected,
        }),
      expected,
    );
  }
  const overwritten = structuredClone(final);
  overwritten.backup.manifest!.persistedCanaryMarker = { durable: false };
  assert.throws(
    () =>
      assertFinalAttempt({
        target: value,
        first,
        final: overwritten,
        snapshots: [{ id: "snapshot-1", state: "created" }],
        environment: value.baseline.environment,
        worker: value.controlWorker.selected,
      }),
    /overwrote first-attempt evidence/u,
  );
  const concurrent = structuredClone(final);
  concurrent.activeWorkspaceOperationIds = ["other-operation"];
  assert.throws(
    () =>
      assertFinalAttempt({
        target: value,
        first,
        final: concurrent,
        snapshots: [{ id: "snapshot-1", state: "created" }],
        environment: value.baseline.environment,
        worker: value.controlWorker.selected,
      }),
    /Another Workspace lifecycle operation/u,
  );
});

test("temporary export resource leaks fail the canary", () => {
  const value = target();
  const leaked = structuredClone(value.baseline.environment);
  leaked.machines.push({
    id: "export-machine",
    state: "started",
    region: "iad",
    workspaceId: value.workspace.id,
    replacementId: "replacement-1",
    mountedVolumeIds: ["export-volume"],
    healthStatus: "passing",
    image: "runtime@sha256:export",
    resolvedImageDigest: "sha256:export",
  });
  assert.throws(
    () => assertNoTemporaryResources(value, leaked),
    /Temporary export resources remain/u,
  );
});

test("KWB2 archive verification authenticates and checksums the decrypted stream", async () => {
  const key = randomBytes(32);
  const archive = Buffer.from("workspace backup retry canary archive");
  const encrypted: Buffer[] = [];
  await pipeline(
    Readable.from([archive]),
    createWorkspaceBackupEncryptionStream(key),
    async function* (source) {
      for await (const chunk of source) encrypted.push(Buffer.from(chunk));
    },
  );
  const expectedChecksumSha256 = await import("node:crypto").then(
    ({ createHash }) => createHash("sha256").update(archive).digest("hex"),
  );
  const verified = await verifyKwb2Archive({
    encrypted: Readable.from(encrypted),
    encryptionKey: key,
    objectKey: "workspace-backups/backup-1.kwb2",
    encryptionKeyId: "backup-v1",
    expectedChecksumSha256,
  });
  assert.equal(verified.header, "KWB2");
  assert.equal(verified.checksumMatches, true);

  const corrupted = Buffer.concat(encrypted);
  corrupted[corrupted.length - 1] ^= 1;
  await assert.rejects(
    verifyKwb2Archive({
      encrypted: Readable.from([corrupted]),
      encryptionKey: key,
      objectKey: "workspace-backups/backup-1.kwb2",
      encryptionKeyId: "backup-v1",
      expectedChecksumSha256,
    }),
  );
});

test("one first-attempt persistence completes on attempt two and retires only after proof", async () => {
  const fixture = orchestrationFixture(null);
  const result = await runWorkspaceBackupRetryCanary({
    args: {
      threadId: "thread-1",
      controlWorkerMachineId: "worker-1",
      tag: "candidate-tag",
    },
    dependencies: fixture.dependencies,
  });
  assert.equal(result.outcome, "passed");
  assert.equal(result.backup?.first?.operation.attempt, 1);
  assert.equal(result.backup?.final?.operation.attempt, 2);
  assert.equal(result.cleanup?.backupRecordPreserved, true);
  assert.equal(fixture.stopCalls, 1);
  assert.ok(fixture.startCalls >= 2);
});

test("post-confirmation target drift blocks every mutation", async () => {
  const fixture = orchestrationFixture(null);
  let queued = false;
  fixture.dependencies.revalidate = async () => {
    const changed = target();
    changed.controlWorker.selected.imageDigest = `sha256:${"c".repeat(64)}`;
    changed.controlWorker.machines[0] = changed.controlWorker.selected;
    return changed;
  };
  fixture.dependencies.queueBackup = async () => {
    queued = true;
    return { backupId: "backup-1", operationId: "operation-1" };
  };
  await assert.rejects(
    runWorkspaceBackupRetryCanary({
      args: {
        threadId: "thread-1",
        controlWorkerMachineId: "worker-1",
        tag: "candidate-tag",
      },
      dependencies: fixture.dependencies,
    }),
    /target changed after preflight/u,
  );
  assert.equal(queued, false);
  assert.equal(fixture.stopCalls, 0);
});

test("every post-stop failure guarantees a worker restart attempt", async (context) => {
  for (const failurePoint of [
    "start",
    "wait",
    "completion",
    "snapshots",
    "inventory",
    "archive",
    "retire",
    "evidence",
  ] as const) {
    await context.test(failurePoint, async () => {
      const fixture = orchestrationFixture(failurePoint);
      await assert.rejects(
        runWorkspaceBackupRetryCanary({
          args: {
            threadId: "thread-1",
            controlWorkerMachineId: "worker-1",
            tag: "candidate-tag",
          },
          dependencies: fixture.dependencies,
        }),
      );
      assert.equal(fixture.stopCalls, 1);
      assert.ok(
        fixture.startCalls >= 2,
        "finally must ensure the worker is started",
      );
    });
  }
});

test("inconclusive snapshot readiness does not stop the worker", async () => {
  const fixture = orchestrationFixture(null, { firstState: "created" });
  await assert.rejects(
    runWorkspaceBackupRetryCanary({
      args: {
        threadId: "thread-1",
        controlWorkerMachineId: "worker-1",
        tag: "candidate-tag",
      },
      dependencies: fixture.dependencies,
    }),
    CanaryInconclusiveError,
  );
  assert.equal(fixture.stopCalls, 0);
  assert.equal(fixture.startCalls, 0);
});

test("evidence redaction removes credentials without removing object and key IDs", () => {
  const secret = "super-secret-token";
  const sanitized = sanitizeCanaryEvidence(
    {
      token: secret,
      nested: { message: `failed with ${secret}` },
      objectKey: "workspace-backups/backup-1.kwb2",
      encryptionKeyId: "backup-v1",
    },
    [secret],
  );
  const json = JSON.stringify(sanitized);
  assert.doesNotMatch(json, /super-secret-token/u);
  assert.match(json, /workspace-backups\/backup-1\.kwb2/u);
  assert.match(json, /backup-v1/u);
});

function target(): CanaryTarget {
  const worker = {
    id: "worker-1",
    state: "started",
    imageTag: "candidate-tag",
    imageRepository: "registry.fly.io/kestrel-one-control-worker",
    imageDigest: `sha256:${"a".repeat(64)}`,
    workerCheckStatus: "passing",
    workerBuildId: "candidate-tag",
  };
  return {
    operator: "operator",
    thread: {
      id: "thread-1",
      projectId: null,
      organizationId: "organization-1",
      createdByUserId: "user-1",
    },
    actor: { id: "user-1", organizationRole: "admin" },
    binding: {
      threadId: "thread-1",
      organizationId: "organization-1",
      environmentId: "environment-1",
      workspaceId: "workspace-1",
    },
    environment: {
      id: "environment-1",
      provider: "fly",
      status: "ready",
      flyAppName: "kestrel-environment-1",
    },
    workspace: {
      id: "workspace-1",
      name: "Canary Workspace",
      kind: "scratch",
      sourceType: "blank",
      status: "ready",
      projectId: null,
      flyMachineId: "source-machine",
      flyVolumeId: "source-volume",
    },
    activeLifecycleOperationIds: [],
    otherBoundThreadIds: [],
    controlWorker: {
      app: "kestrel-one-control-worker",
      repository: "registry.fly.io/kestrel-one-control-worker",
      selected: worker,
      machines: [worker],
    },
    baseline: {
      environment: {
        machines: [
          {
            id: "source-machine",
            state: "started",
            region: "iad",
            workspaceId: "workspace-1",
            replacementId: null,
            mountedVolumeIds: ["source-volume"],
            healthStatus: "passing",
            image: "runtime@sha256:source",
            resolvedImageDigest: "sha256:source",
          },
        ],
        volumes: [
          {
            id: "source-volume",
            name: "workspace-volume",
            region: "iad",
            sizeGb: 20,
            attachedMachineId: "source-machine",
          },
        ],
      },
      sourceVolumeSnapshots: [],
    },
    requestedTag: "candidate-tag",
  };
}

function observation(input: {
  state: string;
  attempt: number;
  backupStatus?: string;
  operationStatus?: string;
  stage?: string;
  retryCount?: number;
  lastObservedAt?: string;
}): BackupObservation {
  return {
    backup: {
      id: "backup-1",
      status: input.backupStatus ?? "creating",
      objectKey:
        input.backupStatus === "available"
          ? "workspace-backups/backup-1.kwb2"
          : null,
      encryptionKeyId: input.backupStatus === "available" ? "backup-v1" : null,
      checksumSha256:
        input.backupStatus === "available" ? "b".repeat(64) : null,
      sizeBytes: input.backupStatus === "available" ? 100 : null,
      manifest: {
        ...(input.backupStatus === "available" ? { backupFormat: "KWB2" } : {}),
        flySnapshotId: "snapshot-1",
        flySnapshotSourceVolumeId: "source-volume",
        flySnapshotState: input.state,
        flySnapshotRequestedAt: "2026-08-23T00:00:00.000Z",
        flySnapshotLastObservedAt:
          input.lastObservedAt ?? "2026-08-23T00:00:01.000Z",
      },
    },
    operation: {
      id: "operation-1",
      status: input.operationStatus ?? "running",
      stage: input.stage ?? "workspace.backup.exporting",
      attempt: input.attempt,
    },
    jobs: [
      {
        id: "job-1",
        state: input.retryCount ? "completed" : "active",
        retryCount: input.retryCount ?? 0,
        retryLimit: 3,
      },
    ],
    activeWorkspaceOperationIds:
      input.operationStatus === "completed" ? [] : ["operation-1"],
  };
}

function orchestrationFixture(
  failurePoint:
    | "start"
    | "wait"
    | "completion"
    | "snapshots"
    | "inventory"
    | "archive"
    | "retire"
    | "evidence"
    | null,
  options: { firstState?: string } = {},
) {
  const value = target();
  let stopCalls = 0;
  let startCalls = 0;
  let waitCalls = 0;
  let snapshotCalls = 0;
  let inventoryCalls = 0;
  const first = observation({
    state: options.firstState ?? "prepare",
    attempt: 1,
  });
  const final = observation({
    state: "created",
    attempt: 2,
    backupStatus: "available",
    operationStatus: "completed",
    stage: "workspace.backup.available",
    retryCount: 1,
    lastObservedAt: "2026-08-23T00:01:00.000Z",
  });
  const dependencies: CanaryDependencies = {
    now: () => new Date("2026-08-23T00:00:00.000Z"),
    preflight: async () => value,
    revalidate: async () => value,
    printTarget: () => undefined,
    confirm: async () => undefined,
    queueBackup: async () => ({
      backupId: "backup-1",
      operationId: "operation-1",
    }),
    waitForFirstSnapshot: async () => first,
    observeEnvironment: async () => {
      inventoryCalls += 1;
      if (failurePoint === "inventory" && inventoryCalls === 2) {
        throw new Error("inventory failed");
      }
      return value.baseline.environment;
    },
    listSnapshots: async () => {
      snapshotCalls += 1;
      if (failurePoint === "snapshots" && snapshotCalls === 2) {
        throw new Error("snapshots failed");
      }
      return [{ id: "snapshot-1", state: "created" }];
    },
    stopWorker: async () => void (stopCalls += 1),
    startWorker: async () => {
      startCalls += 1;
      if (failurePoint === "start" && startCalls === 1)
        throw new Error("start failed");
    },
    waitForWorker: async () => {
      waitCalls += 1;
      if (failurePoint === "wait" && waitCalls === 1)
        throw new Error("wait failed");
      return value.controlWorker.selected;
    },
    waitForCompletion: async () => {
      if (failurePoint === "completion") throw new Error("completion failed");
      return final;
    },
    verifyArchive: async () => {
      if (failurePoint === "archive") throw new Error("archive failed");
      return {
        objectKey: "workspace-backups/backup-1.kwb2",
        encryptionKeyId: "backup-v1",
        backupFormat: "KWB2",
        header: "KWB2",
        decryptedSha256: "b".repeat(64),
        checksumMatches: true,
      };
    },
    retireWorkspace: async () => {
      if (failurePoint === "retire") throw new Error("retire failed");
      return {
        retirementOperationId: "retirement-1",
        workspaceDeleted: true,
        sourceMachineDeleted: true,
        sourceVolumeDeleted: true,
        backupRecordPreserved: true,
        archivePreserved: true,
      };
    },
    writeEvidence: async () => {
      if (failurePoint === "evidence") throw new Error("evidence failed");
    },
  };
  return {
    dependencies,
    get stopCalls() {
      return stopCalls;
    },
    get startCalls() {
      return startCalls;
    },
  };
}
