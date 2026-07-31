import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MissionControlActionIdentityConflictError,
  MissionControlProjectService,
  MissionControlRevisionConflictError,
  createEmptyMissionControlProjectDocument,
} from "../src/missionControl/projectAuthority.js";
import {
  MissionControlAuthorityGateError,
  MissionControlAuthorityService,
} from "../src/missionControl/authority.js";
import {
  MissionControlMigrationGateError,
  MissionControlMigrationService,
  fingerprintLegacySource,
} from "../src/missionControl/migrationAuthority.js";
import { createEmptyProjectSnapshot } from "../src/project/state.js";
import type { ProductProjectSnapshot } from "../src/project/contracts.js";
import { createSessionStoreFromEnv } from "../src/store/createSessionStore.js";
import { InMemorySessionStore } from "../src/store/InMemorySessionStore.js";
import { contractTest } from "./helpers/contract-test.js";

const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);
const FINGERPRINT_C = "c".repeat(64);
const FINGERPRINT_D = "d".repeat(64);

contractTest(
  "runtime.mission-control-project-persistence",
  "project state, receipts, and outbox commit atomically with project isolation",
  async (context) => {
    const databaseUrl =
      process.env.KESTREL_PRODUCT_RUNNER_DATABASE_URL?.trim();
    const temporaryRoot =
      databaseUrl === undefined ? await mkdtemp(join(tmpdir(), "kestrel-mc-")) : undefined;
    const handle = createSessionStoreFromEnv(
      databaseUrl === undefined
        ? {
            driver: "sqlite",
            sqlitePath: join(temporaryRoot!, "runtime"),
            enforceSchemaV3: false,
          }
        : {
            driver: "postgres",
            databaseUrl,
            enforceSchemaV3: false,
          },
    );
    await handle.ready();
    context.after(async () => {
      await handle.close();
      if (temporaryRoot !== undefined) {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    });

    const projectA = randomUUID();
    const projectB = randomUUID();
    const projectC = randomUUID();
    const projectD = randomUUID();
    const store = handle.store;

    const first = await store.updateMissionControlProjectState({
      projectId: projectA,
      actionId: "project-a-action",
      requestFingerprint: FINGERPRINT_A,
      expectedRevision: 0,
      apply: (current) => ({
        document: {
          ...current,
          autopilot: {
            enabled: false,
            wipLimit: 2,
          },
        },
        effects: [{
          effectId: "project-a-effect",
          effectType: "mission-control.test",
          payload: { projectId: projectA },
        }],
      }),
    });
    assert.equal(first.project.revision, 1);
    assert.equal(first.effects.length, 1);
    assert.equal(first.effects[0]?.projectId, projectA);

    const replay = await store.updateMissionControlProjectState({
      projectId: projectA,
      actionId: "project-a-action",
      requestFingerprint: FINGERPRINT_A,
      expectedRevision: 0,
      apply: () => {
        throw new Error("Exact replay must return the receipt.");
      },
    });
    assert.equal(replay.duplicate, true);
    assert.deepEqual(replay.project, first.project);
    assert.deepEqual(replay.effects, first.effects);
    await assert.rejects(
      store.updateMissionControlProjectState({
        projectId: projectA,
        actionId: "project-a-action",
        requestFingerprint: FINGERPRINT_B,
        expectedRevision: 1,
        apply: (current) => ({ document: current, effects: [] }),
      }),
      MissionControlActionIdentityConflictError,
    );

    await store.updateMissionControlProjectState({
      projectId: projectB,
      actionId: "project-b-action",
      requestFingerprint: FINGERPRINT_B,
      expectedRevision: 0,
      apply: (current) => ({
        document: current,
        effects: [{
          effectId: "project-b-effect",
          effectType: "mission-control.test",
          payload: { projectId: projectB },
        }],
      }),
    });
    assert.equal((await store.getMissionControlProjectState(projectA))?.revision, 1);
    assert.equal((await store.getMissionControlProjectState(projectB))?.revision, 1);
    assert.deepEqual(
      (await store.listMissionControlOutbox(projectA)).map((entry) => entry.effectId),
      ["project-a-effect"],
    );
    assert.deepEqual(
      (await store.listMissionControlOutbox(projectB)).map((entry) => entry.effectId),
      ["project-b-effect"],
    );

    await assert.rejects(
      store.updateMissionControlProjectState({
        projectId: projectC,
        actionId: "rollback-action",
        requestFingerprint: FINGERPRINT_C,
        expectedRevision: 0,
        apply: () => {
          throw new Error("rollback");
        },
      }),
      /rollback/u,
    );
    assert.equal(await store.getMissionControlProjectState(projectC), null);
    assert.deepEqual(await store.listMissionControlOutbox(projectC), []);

    await assert.rejects(
      store.updateMissionControlProjectState({
        projectId: projectD,
        actionId: "cross-project-action",
        requestFingerprint: FINGERPRINT_D,
        expectedRevision: 0,
        apply: () => ({
          document: createEmptyMissionControlProjectDocument(projectA),
          effects: [{
            effectId: "must-not-commit",
            effectType: "mission-control.test",
            payload: {},
          }],
        }),
      }),
      /document project mismatch/u,
    );
    assert.equal(await store.getMissionControlProjectState(projectD), null);
    assert.deepEqual(await store.listMissionControlOutbox(projectD), []);

    const concurrentProject = randomUUID();
    const attempts = await Promise.allSettled([
      store.updateMissionControlProjectState({
        projectId: concurrentProject,
        actionId: "concurrent-a",
        requestFingerprint: FINGERPRINT_A,
        expectedRevision: 0,
        apply: (current) => ({ document: current, effects: [] }),
      }),
      store.updateMissionControlProjectState({
        projectId: concurrentProject,
        actionId: "concurrent-b",
        requestFingerprint: FINGERPRINT_B,
        expectedRevision: 0,
        apply: (current) => ({ document: current, effects: [] }),
      }),
    ]);
    assert.equal(
      attempts.filter((attempt) => attempt.status === "fulfilled").length,
      1,
    );
    const rejected = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    assert.ok(rejected);
    assert.ok(rejected.reason instanceof MissionControlRevisionConflictError);
    assert.equal(
      (await store.getMissionControlProjectState(concurrentProject))?.revision,
      1,
    );
  },
);

contractTest(
  "runtime.mission-control-project-persistence",
  "staged migration is deterministic, conflict blocked, drift safe, and project scoped",
  async (context) => {
    const databaseUrl =
      process.env.KESTREL_PRODUCT_RUNNER_DATABASE_URL?.trim();
    const temporaryRoot =
      databaseUrl === undefined
        ? await mkdtemp(join(tmpdir(), "kestrel-mc-migration-"))
        : undefined;
    const handle = createSessionStoreFromEnv(
      databaseUrl === undefined
        ? {
            driver: "sqlite",
            sqlitePath: join(temporaryRoot!, "runtime"),
            enforceSchemaV3: false,
          }
        : {
            driver: "postgres",
            databaseUrl,
            enforceSchemaV3: false,
          },
    );
    await handle.ready();
    context.after(async () => {
      await handle.close();
      if (temporaryRoot !== undefined) {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    });

    const store = handle.store;
    const migration = new MissionControlMigrationService(store);
    const ids = {
      empty: randomUUID(),
      replay: randomUUID(),
      single: randomUUID(),
      equivalent: randomUUID(),
      conflict: randomUUID(),
      drift: randomUUID(),
      invalid: randomUUID(),
      moved: randomUUID(),
      missing: randomUUID(),
      ambiguous: randomUUID(),
      other: randomUUID(),
    };
    const registrations = [
      registration(ids.empty, "/workspace/empty"),
      registration(ids.replay, "/workspace/replay"),
      registration(ids.single, "/workspace/single"),
      registration(ids.equivalent, "/workspace/equivalent"),
      registration(ids.conflict, "/workspace/conflict"),
      registration(ids.drift, "/workspace/drift"),
      registration(ids.invalid, "/workspace/invalid"),
      registration(ids.moved, "/workspace/moved", ["/workspace/old"]),
      registration(ids.missing, "/workspace/missing"),
      registration(ids.ambiguous, "/workspace/ambiguous"),
      registration(ids.other, "/workspace/ambiguous"),
    ];

    const empty = await migration.execute(
      stageAction(ids.empty, "stage-empty", 0, registrations),
    );
    assert.equal(empty.project.document.migration?.status, "staged_empty");
    assert.deepEqual(empty.project.document.items, {});

    const replayAction = stageAction(
      ids.replay,
      "stage-replay",
      0,
      registrations,
    );
    const replayInitial = await migration.execute(replayAction);
    await seedLegacy(
      store,
      "legacy-replay-after-stage",
      legacySnapshot("/workspace/replay", task("late-task", "Late")),
    );
    const replayed = await migration.execute(replayAction);
    assert.equal(replayed.duplicate, true);
    assert.deepEqual(replayed.project, replayInitial.project);

    await seedLegacy(
      store,
      "legacy-single",
      legacySnapshot("/workspace/single", task("task-1", "One")),
    );
    const single = await migration.execute(
      stageAction(ids.single, "stage-single", 0, registrations),
    );
    assert.equal(single.project.document.migration?.status, "staged");
    assert.equal(
      single.project.document.items["legacy:task:task-1"]?.title,
      "One",
    );

    const equivalentSnapshot = legacySnapshot(
      "/workspace/equivalent",
      task("same-task", "Equivalent"),
    );
    await seedLegacy(store, "legacy-equivalent-a", equivalentSnapshot);
    await seedLegacy(store, "legacy-equivalent-b", equivalentSnapshot);
    const equivalent = await migration.execute(
      stageAction(ids.equivalent, "stage-equivalent", 0, registrations),
    );
    assert.equal(equivalent.project.document.migration?.sources.length, 2);
    assert.equal(equivalent.project.document.migration?.candidates.length, 1);
    assert.equal(equivalent.project.document.migration?.status, "staged");

    await seedLegacy(
      store,
      "legacy-conflict-a",
      legacySnapshot("/workspace/conflict", task("conflict-task", "A")),
    );
    await seedLegacy(
      store,
      "legacy-conflict-b",
      legacySnapshot("/workspace/conflict", task("conflict-task", "B")),
    );
    const conflict = await migration.execute(
      stageAction(ids.conflict, "stage-conflict", 0, registrations),
    );
    assert.equal(
      conflict.project.document.migration?.status,
      "needs_resolution",
    );
    assert.equal(conflict.project.document.migration?.candidates.length, 2);
    assert.deepEqual(conflict.project.document.items, {});
    const selectedCandidate =
      conflict.project.document.migration?.candidates[0]?.id;
    assert.ok(selectedCandidate);
    const resolved = await migration.execute({
      type: "migration.resolve",
      projectId: ids.conflict,
      actionId: "resolve-conflict",
      actionTs: "2026-07-30T14:00:00.000Z",
      expectedRevision: 1,
      registrations,
      operatorId: "operator",
      resolution: { type: "source", candidateId: selectedCandidate },
    });
    assert.equal(resolved.project.document.migration?.status, "resolved");
    assert.equal(
      resolved.project.document.migration?.resolution?.type,
      "source",
    );

    await seedLegacy(
      store,
      "legacy-drift-a",
      legacySnapshot("/workspace/drift", task("drift-task", "A")),
    );
    await seedLegacy(
      store,
      "legacy-drift-b",
      legacySnapshot("/workspace/drift", task("drift-task", "B")),
    );
    const drift = await migration.execute(
      stageAction(ids.drift, "stage-drift", 0, registrations),
    );
    const driftCandidate = drift.project.document.migration?.candidates[0]?.id;
    assert.ok(driftCandidate);
    await seedLegacy(
      store,
      "legacy-drift-b",
      legacySnapshot("/workspace/drift", task("drift-task", "changed")),
    );
    await assert.rejects(
      migration.execute({
        type: "migration.resolve",
        projectId: ids.drift,
        actionId: "resolve-drift",
        actionTs: "2026-07-30T14:05:00.000Z",
        expectedRevision: 1,
        registrations,
        operatorId: "operator",
        resolution: { type: "source", candidateId: driftCandidate },
      }),
      (error: unknown) =>
        error instanceof MissionControlMigrationGateError &&
        error.reason === "source_drift",
    );

    await seedLegacy(
      store,
      "legacy-invalid",
      legacySnapshot(
        "/workspace/invalid",
        task("running-task", "Running", "running"),
      ),
    );
    const invalid = await migration.execute(
      stageAction(ids.invalid, "stage-invalid", 0, registrations),
    );
    assert.equal(
      invalid.project.document.migration?.status,
      "needs_resolution",
    );
    assert.equal(
      invalid.project.document.migration?.candidates[0]?.valid,
      false,
    );
    await assert.rejects(
      migration.execute({
        type: "migration.resolve",
        projectId: ids.invalid,
        actionId: "resolve-invalid",
        actionTs: "2026-07-30T14:10:00.000Z",
        expectedRevision: 1,
        registrations,
        operatorId: "operator",
        resolution: {
          type: "source",
          candidateId:
            invalid.project.document.migration?.candidates[0]?.id ?? "",
        },
      }),
      (error: unknown) =>
        error instanceof MissionControlMigrationGateError &&
        error.reason === "candidate_invalid",
    );

    await seedLegacy(
      store,
      "legacy-moved",
      legacySnapshot("/workspace/old", task("moved-task", "Moved")),
    );
    const moved = await migration.execute(
      stageAction(ids.moved, "stage-moved", 0, registrations),
    );
    const movedSource = moved.project.document.migration?.sources.find(
      (source) => source.sourceId === "session:legacy-moved",
    );
    assert.equal(movedSource?.linkStatus, "moved");
    assert.equal(moved.project.document.migration?.status, "needs_rebind");
    assert.ok(movedSource);
    const rebound = await migration.execute({
      type: "migration.rebind",
      projectId: ids.moved,
      actionId: "rebind-moved",
      actionTs: "2026-07-30T14:15:00.000Z",
      expectedRevision: 1,
      registrations,
      sourceId: movedSource.sourceId,
      sourceFingerprint: movedSource.sourceFingerprint,
      operatorId: "operator",
    });
    assert.equal(rebound.project.document.migration?.status, "staged");
    assert.equal(
      (
        await store.listMissionControlMigrationSourceBindings?.()
      )?.find((binding) => binding.sourceId === movedSource.sourceId)?.projectId,
      ids.moved,
    );

    await seedLegacy(store, "legacy-missing", legacySnapshot("", task("missing", "Missing")));
    const missing = await migration.execute(
      stageAction(ids.missing, "stage-missing", 0, registrations),
    );
    assert.equal(missing.project.document.migration?.status, "needs_rebind");
    assert.equal(
      missing.project.document.migration?.sources.find(
        (source) => source.sourceId === "session:legacy-missing",
      )?.linkStatus,
      "missing_project",
    );

    await seedLegacy(
      store,
      "legacy-ambiguous",
      legacySnapshot("/workspace/ambiguous", task("ambiguous", "Ambiguous")),
    );
    const ambiguous = await migration.execute(
      stageAction(ids.ambiguous, "stage-ambiguous", 0, registrations),
    );
    assert.equal(
      ambiguous.project.document.migration?.sources.find(
        (source) => source.sourceId === "session:legacy-ambiguous",
      )?.linkStatus,
      "ambiguous_project",
    );

    const cleared = await migration.execute({
      type: "migration.clear",
      projectId: ids.moved,
      actionId: "clear-moved",
      actionTs: "2026-07-30T14:20:00.000Z",
      expectedRevision: 2,
      operatorId: "operator",
    });
    assert.equal(cleared.project.document.migration, undefined);
    assert.ok(await store.getSessionProductState?.("legacy-moved"));
    assert.equal(
      (
        await store.listMissionControlMigrationSourceBindings?.()
      )?.some((binding) => binding.sourceId === movedSource.sourceId),
      false,
    );
    const replayedClear = await migration.execute({
      type: "migration.clear",
      projectId: ids.moved,
      actionId: "clear-moved",
      actionTs: "2026-07-30T14:20:00.000Z",
      expectedRevision: 2,
      operatorId: "operator",
    });
    assert.equal(replayedClear.duplicate, true);
    assert.equal(replayedClear.project.document.migration, undefined);

    const liveSources = await store.listMissionControlLegacySources?.();
    assert.equal(
      liveSources?.find((source) => source.sourceId === "session:legacy-single")
        ?.projectPath,
      "/workspace/single",
    );
    assert.equal(
      fingerprintLegacySource(
        liveSources?.find(
          (source) => source.sourceId === "session:legacy-single",
        )!,
      ),
      single.project.document.migration?.sources[0]?.sourceFingerprint,
    );
  },
);

contractTest(
  "runtime.mission-control-project-persistence",
  "authority cutover freezes legacy writes and rollback exports complete canonical state",
  async (context) => {
    const databaseUrl =
      process.env.KESTREL_PRODUCT_RUNNER_DATABASE_URL?.trim();
    const temporaryRoot =
      databaseUrl === undefined
        ? await mkdtemp(join(tmpdir(), "kestrel-mc-authority-"))
        : undefined;
    const handle = createSessionStoreFromEnv(
      databaseUrl === undefined
        ? {
            driver: "sqlite",
            sqlitePath: join(temporaryRoot!, "runtime"),
            enforceSchemaV3: false,
          }
        : {
            driver: "postgres",
            databaseUrl,
            enforceSchemaV3: false,
          },
    );
    await handle.ready();
    context.after(async () => {
      await handle.close();
      if (temporaryRoot !== undefined) {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    });

    const store = handle.store;
    const projectId = randomUUID();
    const driftProjectId = randomUUID();
    await seedLegacy(
      store,
      "legacy-authority",
      legacySnapshot(
        "/workspace/authority",
        task("legacy-task", "Legacy work"),
      ),
    );
    await seedLegacy(
      store,
      "legacy-drift-at-cutover",
      legacySnapshot(
        "/workspace/drift-at-cutover",
        task("drift-task", "Before drift"),
      ),
    );

    const authority = new MissionControlAuthorityService(store);
    const projects = new MissionControlProjectService(store);
    const stagedDocument = await isolatedStagedDocument(
      projectId,
      "legacy-authority",
      legacySnapshot(
        "/workspace/authority",
        task("legacy-task", "Legacy work"),
      ),
    );
    const driftStagedDocument = await isolatedStagedDocument(
      driftProjectId,
      "legacy-drift-at-cutover",
      legacySnapshot(
        "/workspace/drift-at-cutover",
        task("drift-task", "Before drift"),
      ),
    );
    const actualSources = await store.listMissionControlLegacySources?.();
    assert.ok(actualSources);
    alignStagedSource(
      stagedDocument,
      actualSources.find(
        (source) => source.sourceId === "session:legacy-authority",
      ),
    );
    alignStagedSource(
      driftStagedDocument,
      actualSources.find(
        (source) =>
          source.sourceId === "session:legacy-drift-at-cutover",
      ),
    );
    await store.updateMissionControlProjectState({
      projectId,
      actionId: "stage-authority",
      requestFingerprint: "1".repeat(64),
      expectedRevision: 0,
      apply: () => ({ document: stagedDocument, effects: [] }),
    });
    await store.updateMissionControlProjectState({
      projectId: driftProjectId,
      actionId: "stage-authority-drift",
      requestFingerprint: "2".repeat(64),
      expectedRevision: 0,
      apply: () => ({ document: driftStagedDocument, effects: [] }),
    });
    await seedLegacy(
      store,
      "legacy-drift-at-cutover",
      legacySnapshot(
        "/workspace/drift-at-cutover",
        task("drift-task", "After drift"),
      ),
    );
    await assert.rejects(
      authority.execute({
        type: "authority.activate",
        projectId: driftProjectId,
        actionId: "activate-drifted",
        actionTs: "2026-07-30T15:00:00.000Z",
        expectedRevision: 1,
      }),
      (error: unknown) =>
        error instanceof MissionControlAuthorityGateError &&
        error.reason === "source_drift",
    );
    assert.equal(
      (await projects.getProject(driftProjectId)).authorityEpoch,
      0,
    );

    const activated = await authority.execute({
      type: "authority.activate",
      projectId,
      actionId: "activate-authority",
      actionTs: "2026-07-30T15:01:00.000Z",
      expectedRevision: 1,
    });
    assert.equal(activated.project.authorityEpoch, 1);
    assert.equal(activated.project.revision, 2);
    assert.ok(store.saveSessionProjectSnapshot);
    await assert.rejects(
      () => store.saveSessionProjectSnapshot!({
        sessionId: "legacy-authority",
        snapshot: legacySnapshot(
          "/workspace/authority",
          task("forbidden-task", "Forbidden dual write"),
        ),
      }),
      (error: unknown) =>
        (error as { code?: string }).code ===
        "MISSION_CONTROL_LEGACY_SOURCE_FROZEN",
    );

    const canonical = await projects.execute({
      type: "item.create",
      projectId,
      actionId: "canonical-create",
      actionTs: "2026-07-30T15:02:00.000Z",
      expectedRevision: 2,
      itemId: "canonical-task",
      title: "Canonical work",
      instructions: "Created after project authority cutover.",
      createdBy: "operator",
      completionContract: {
        workType: "non_code",
        changeOutcome: "no_change",
        validation: {
          mode: "not_applicable",
          reason: "No source change is required.",
        },
        requiredEvidence: [],
      },
      order: 2,
    });
    assert.equal(canonical.project.document.items["canonical-task"]?.phase, "ready");

    const rolledBack = await authority.execute({
      type: "authority.rollback",
      projectId,
      actionId: "rollback-authority",
      actionTs: "2026-07-30T15:03:00.000Z",
      expectedRevision: 3,
      operatorId: "operator",
    });
    assert.equal(rolledBack.project.authorityEpoch, 0);
    assert.equal(rolledBack.project.document.autopilot.enabled, false);
    const exported = await store.getSessionProductState?.("legacy-authority");
    assert.equal(
      exported?.projectSnapshot.taskQueue.tasks["canonical-task"]?.title,
      "Canonical work",
    );
    assert.equal(
      exported?.projectSnapshot.activity.at(-1)?.timestamp,
      "2026-07-30T15:03:00.000Z",
    );

    await store.saveSessionProjectSnapshot({
      sessionId: "legacy-authority",
      snapshot: exported!.projectSnapshot,
    });
    assert.equal(
      (await store.getSessionProductState?.("legacy-authority"))?.projectSnapshot
        .taskQueue.tasks["canonical-task"]?.title,
      "Canonical work",
    );
  },
);

function registration(
  projectId: string,
  path: string,
  previousPaths: string[] = [],
) {
  return { projectId, path, previousPaths };
}

function stageAction(
  projectId: string,
  actionId: string,
  expectedRevision: number,
  registrations: ReturnType<typeof registration>[],
) {
  return {
    type: "migration.stage" as const,
    projectId,
    actionId,
    actionTs: "2026-07-30T13:00:00.000Z",
    expectedRevision,
    registrations,
  };
}

function task(
  id: string,
  title: string,
  status: "queued" | "running" = "queued",
) {
  return {
    id,
    title,
    instructions: `${title} instructions`,
    priority: "medium" as const,
    status,
    createdBy: "user" as const,
    createdAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
    order: 1,
    evidence: [],
  };
}

function legacySnapshot(
  workspaceRoot: string,
  legacyTask: ReturnType<typeof task>,
): ProductProjectSnapshot {
  const snapshot = createEmptyProjectSnapshot();
  return {
    ...snapshot,
    setup: {
      ...snapshot.setup,
      workspaceRoot,
      repoRoot: workspaceRoot,
      repoLabel: workspaceRoot || "Unbound",
    },
    taskQueue: {
      ...snapshot.taskQueue,
      tasks: { [legacyTask.id]: legacyTask },
    },
  };
}

async function seedLegacy(
  store: ReturnType<typeof createSessionStoreFromEnv>["store"],
  sessionId: string,
  snapshot: ProductProjectSnapshot,
): Promise<void> {
  await store.ensureSession(sessionId);
  await store.saveSessionProjectSnapshot?.({ sessionId, snapshot });
}

async function isolatedStagedDocument(
  projectId: string,
  sessionId: string,
  snapshot: ProductProjectSnapshot,
) {
  const store = new InMemorySessionStore();
  await seedLegacy(store, sessionId, snapshot);
  return (
    await new MissionControlMigrationService(store).execute(
      stageAction(
        projectId,
        `stage-${sessionId}`,
        0,
        [registration(projectId, snapshot.setup.workspaceRoot)],
      ),
    )
  ).project.document;
}

function alignStagedSource(
  document: Awaited<ReturnType<typeof isolatedStagedDocument>>,
  source:
    | NonNullable<
        Awaited<
          ReturnType<
            NonNullable<
              ReturnType<typeof createSessionStoreFromEnv>["store"]["listMissionControlLegacySources"]
            >
          >
        >
      >[number]
    | undefined,
): void {
  assert.ok(source);
  const migrationSource = document.migration?.sources.find(
    (candidate) => candidate.sourceId === source.sourceId,
  );
  assert.ok(migrationSource);
  migrationSource.sourceVersion = source.sourceVersion;
  migrationSource.sourceFingerprint = fingerprintLegacySource(source);
}
