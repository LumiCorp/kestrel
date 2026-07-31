import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MISSION_CONTROL_AUTHORITY_EPOCH,
  MissionControlActionIdentityConflictError,
  MissionControlProjectService,
  parseMissionControlProjectDocument,
} from "../src/missionControl/projectAuthority.js";
import { createSessionStoreFromEnv } from "../src/store/createSessionStore.js";
import { contractTest } from "./helpers/contract-test.js";

contractTest(
  "runtime.mission-control-project-persistence",
  "canonical project authority is active by default and commits receipts atomically",
  async (context) => {
    const databaseUrl =
      process.env.KESTREL_PRODUCT_RUNNER_DATABASE_URL?.trim();
    const temporaryRoot =
      databaseUrl === undefined
        ? await mkdtemp(join(tmpdir(), "kestrel-mc-"))
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

    const projectId = randomUUID();
    const projects = new MissionControlProjectService(handle.store);
    assert.equal(
      (await projects.getProject(projectId)).authorityEpoch,
      MISSION_CONTROL_AUTHORITY_EPOCH,
    );

    const action = {
      type: "item.create" as const,
      projectId,
      actionId: "create-canonical-item",
      actionTs: "2026-07-30T15:00:00.000Z",
      expectedRevision: 0,
      itemId: "canonical-item",
      title: "Canonical work",
      instructions: "Prove the single project-scoped authority.",
      createdBy: "operator" as const,
      completionContract: {
        workType: "non_code" as const,
        changeOutcome: "no_change" as const,
        validation: {
          mode: "not_applicable" as const,
          reason: "Authority persistence proof.",
        },
        requiredEvidence: [],
      },
      order: 1,
    };
    const created = await projects.execute(action);
    assert.equal(created.project.authorityEpoch, MISSION_CONTROL_AUTHORITY_EPOCH);
    assert.equal(created.project.revision, 1);
    assert.equal(created.project.document.items["canonical-item"]?.phase, "ready");

    const replayed = await projects.execute(action);
    assert.equal(replayed.duplicate, true);
    assert.equal(replayed.project.revision, 1);

    await assert.rejects(
      projects.execute({
        ...action,
        title: "Conflicting identity reuse",
      }),
      MissionControlActionIdentityConflictError,
    );
    assert.equal(
      (await handle.store.getMissionControlProjectState(projectId))?.document
        .items["canonical-item"]?.title,
      "Canonical work",
    );

    assert.throws(
      () =>
        parseMissionControlProjectDocument(
          {
            ...created.project.document,
            projectId: randomUUID(),
          },
          projectId,
        ),
      /project mismatch/u,
    );

    const withEffect = await handle.store.updateMissionControlProjectState({
      projectId,
      actionId: "effect-one",
      requestFingerprint: "a".repeat(64),
      expectedRevision: 1,
      apply: (document) => ({
        document: {
          ...document,
          autopilot: { ...document.autopilot, wipLimit: 4 },
        },
        effects: [
          {
            effectId: "shared-effect",
            effectType: "proof.effect",
            payload: { sequence: 1 },
          },
        ],
      }),
    });
    assert.equal(withEffect.project.revision, 2);

    await assert.rejects(
      handle.store.updateMissionControlProjectState({
        projectId,
        actionId: "effect-collision",
        requestFingerprint: "b".repeat(64),
        expectedRevision: 2,
        apply: (document) => ({
          document: {
            ...document,
            autopilot: { ...document.autopilot, wipLimit: 5 },
          },
          effects: [
            {
              effectId: "shared-effect",
              effectType: "proof.effect",
              payload: { sequence: 2 },
            },
          ],
        }),
      }),
    );
    const afterRejectedEffect =
      await handle.store.getMissionControlProjectState(projectId);
    assert.equal(afterRejectedEffect?.revision, 2);
    assert.equal(afterRejectedEffect?.document.autopilot.wipLimit, 4);
  },
);
