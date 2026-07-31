import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MissionControlActionIdentityConflictError,
  MissionControlRevisionConflictError,
  createEmptyMissionControlProjectDocument,
} from "../src/missionControl/projectAuthority.js";
import { createSessionStoreFromEnv } from "../src/store/createSessionStore.js";
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
