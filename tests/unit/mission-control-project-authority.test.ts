import test from "node:test";
import assert from "node:assert/strict";

import {
  MissionControlActionIdentityConflictError,
  MissionControlItemVersionConflictError,
  MissionControlProjectService,
  MissionControlRevisionConflictError,
  MissionControlTransitionError,
  createEmptyMissionControlProjectDocument,
  reduceMissionControlProjectAction,
  type MissionControlProjectAction,
} from "../../src/missionControl/projectAuthority.js";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const ACTION_TS = "2026-07-30T12:00:00.000Z";

test(
  "canonical project work-item lifecycle is scoped, explicit, and replay safe",
  async () => {
    const store = new InMemorySessionStore();
    const service = new MissionControlProjectService(store);

    const operatorCreate = action({
      type: "item.create",
      projectId: PROJECT_A,
      actionId: "create-operator",
      expectedRevision: 0,
      itemId: "operator-item",
      title: "Operator work",
      instructions: "Created directly by the operator.",
      createdBy: "operator",
      order: 0,
    });
    const operatorResult = await service.execute(operatorCreate);
    assert.equal(operatorResult.project.document.items["operator-item"]?.phase, "ready");
    assert.equal(operatorResult.project.document.items["operator-item"]?.version, 1);

    const proposalResult = await service.execute(action({
      type: "item.create",
      projectId: PROJECT_A,
      actionId: "create-proposal",
      expectedRevision: 1,
      itemId: "agent-item",
      title: "Agent proposal",
      instructions: "Requires operator approval.",
      createdBy: "agent",
      order: 1,
    }));
    assert.equal(proposalResult.project.document.items["agent-item"]?.phase, "proposed");

    const approvalResult = await service.execute(action({
      type: "item.approve",
      projectId: PROJECT_A,
      actionId: "approve-proposal",
      expectedRevision: 2,
      itemId: "agent-item",
      expectedItemVersion: 1,
    }));
    assert.equal(approvalResult.project.document.items["agent-item"]?.phase, "ready");
    assert.equal(approvalResult.project.document.items["agent-item"]?.version, 2);

    const reorderResult = await service.execute(action({
      type: "item.reorder",
      projectId: PROJECT_A,
      actionId: "reorder-ready",
      expectedRevision: 3,
      itemId: "operator-item",
      expectedItemVersion: 1,
      targetPhase: "ready",
      order: 2,
    }));
    assert.equal(reorderResult.project.document.items["operator-item"]?.order, 2);
    assert.equal(reorderResult.project.document.items["operator-item"]?.phase, "ready");

    await assert.rejects(
      service.execute(action({
        type: "item.reorder",
        projectId: PROJECT_A,
        actionId: "drag-to-active",
        expectedRevision: 4,
        itemId: "operator-item",
        expectedItemVersion: 2,
        targetPhase: "active",
        order: 0,
      })),
      MissionControlTransitionError,
    );
    assert.equal((await service.getProject(PROJECT_A)).revision, 4);

    await assert.rejects(
      service.execute(action({
        type: "item.return_to_ready",
        projectId: PROJECT_A,
        actionId: "invalid-return",
        expectedRevision: 4,
        itemId: "operator-item",
        expectedItemVersion: 2,
      })),
      MissionControlTransitionError,
    );

    const discarded = await service.execute(action({
      type: "item.discard",
      projectId: PROJECT_A,
      actionId: "discard-proposal",
      expectedRevision: 4,
      itemId: "agent-item",
      expectedItemVersion: 2,
    }));
    assert.equal(discarded.project.document.items["agent-item"]?.phase, "discarded");
    assert.deepEqual(
      discarded.project.document.history.map((entry) => entry.actionId),
      [
        "create-operator",
        "create-proposal",
        "approve-proposal",
        "reorder-ready",
        "discard-proposal",
      ],
    );

    const replay = await service.execute(action({
      type: "item.discard",
      projectId: PROJECT_A,
      actionId: "discard-proposal",
      expectedRevision: 4,
      itemId: "agent-item",
      expectedItemVersion: 2,
    }));
    assert.equal(replay.duplicate, true);
    assert.deepEqual(replay.project, discarded.project);

    await assert.rejects(
      service.execute(action({
        type: "item.discard",
        projectId: PROJECT_A,
        actionId: "discard-proposal",
        expectedRevision: 5,
        itemId: "operator-item",
        expectedItemVersion: 2,
      })),
      MissionControlActionIdentityConflictError,
    );
    await assert.rejects(
      service.execute(action({
        type: "item.discard",
        projectId: PROJECT_A,
        actionId: "stale-project",
        expectedRevision: 4,
        itemId: "operator-item",
        expectedItemVersion: 2,
      })),
      MissionControlRevisionConflictError,
    );
    await assert.rejects(
      service.execute(action({
        type: "item.discard",
        projectId: PROJECT_A,
        actionId: "stale-item",
        expectedRevision: 5,
        itemId: "operator-item",
        expectedItemVersion: 1,
      })),
      MissionControlItemVersionConflictError,
    );

    await assert.rejects(
      service.execute(action({
        type: "autopilot.configure",
        projectId: PROJECT_A,
        actionId: "unconfirmed-autopilot",
        expectedRevision: 5,
        enabled: true,
        wipLimit: 2,
      })),
      MissionControlTransitionError,
    );
    const configured = await service.execute(action({
      type: "autopilot.configure",
      projectId: PROJECT_A,
      actionId: "confirmed-autopilot",
      expectedRevision: 5,
      enabled: true,
      wipLimit: 2,
      confirmedAt: ACTION_TS,
    }));
    assert.deepEqual(configured.project.document.autopilot, {
      enabled: true,
      wipLimit: 2,
      confirmedAt: ACTION_TS,
    });

    const otherProject = await service.execute(action({
      type: "item.create",
      projectId: PROJECT_B,
      actionId: "create-other-project",
      expectedRevision: 0,
      itemId: "other-item",
      title: "Other project",
      instructions: "Must remain isolated.",
      createdBy: "operator",
      order: 0,
    }));
    assert.deepEqual(Object.keys(otherProject.project.document.items), ["other-item"]);
    assert.equal(otherProject.project.document.autopilot.enabled, false);
    assert.equal((await service.getProject(PROJECT_A)).revision, 6);
  },
);

test(
  "Needs attention returns to Ready only through its explicit lifecycle action",
  () => {
    const created = reduceMissionControlProjectAction(
      createEmptyMissionControlProjectDocument(PROJECT_A),
      action({
        type: "item.create",
        projectId: PROJECT_A,
        actionId: "seed",
        expectedRevision: 0,
        itemId: "recoverable-item",
        title: "Recoverable work",
        instructions: "Return explicitly after attention.",
        createdBy: "operator",
        order: 0,
      }),
    ).document;
    const needsAttention = structuredClone(created);
    const seededItem = needsAttention.items["recoverable-item"];
    assert.ok(seededItem);
    needsAttention.items["recoverable-item"] = {
      ...seededItem,
      phase: "needs_attention",
    };

    const returned = reduceMissionControlProjectAction(
      needsAttention,
      action({
        type: "item.return_to_ready",
        projectId: PROJECT_A,
        actionId: "return-ready",
        expectedRevision: 1,
        itemId: "recoverable-item",
        expectedItemVersion: 1,
      }),
    ).document;
    assert.equal(returned.items["recoverable-item"]?.phase, "ready");
    assert.equal(returned.items["recoverable-item"]?.version, 2);
  },
);

test(
  "pre-run editing, complete phase resequencing, and immutable follow-ups are authoritative",
  async () => {
    const store = new InMemorySessionStore();
    const service = new MissionControlProjectService(store);
    await service.execute(action({
      type: "item.create",
      projectId: PROJECT_A,
      actionId: "create-first",
      expectedRevision: 0,
      itemId: "first",
      title: "First",
      instructions: "First instructions.",
      createdBy: "operator",
      completionContract: nonCodeContract(),
      order: 8,
    }));
    await service.execute(action({
      type: "item.create",
      projectId: PROJECT_A,
      actionId: "create-second",
      expectedRevision: 1,
      itemId: "second",
      title: "Second",
      instructions: "Second instructions.",
      createdBy: "operator",
      completionContract: nonCodeContract(),
      order: 3,
    }));
    const updated = await service.execute(action({
      type: "item.update",
      projectId: PROJECT_A,
      actionId: "update-first",
      expectedRevision: 2,
      itemId: "first",
      expectedItemVersion: 1,
      title: "First, clarified",
      instructions: "Clarified before the first run.",
      completionContract: nonCodeContract(),
    }));
    assert.equal(updated.project.document.items.first?.title, "First, clarified");

    const resequenced = await service.execute(action({
      type: "item.resequence",
      projectId: PROJECT_A,
      actionId: "resequence-ready",
      expectedRevision: 3,
      targetPhase: "ready",
      orderedItemIds: ["first", "second"],
    }));
    assert.equal(resequenced.project.document.items.first?.order, 0);
    assert.equal(resequenced.project.document.items.second?.order, 1);
    await assert.rejects(
      service.execute(action({
        type: "item.resequence",
        projectId: PROJECT_A,
        actionId: "incomplete-resequence",
        expectedRevision: 4,
        targetPhase: "ready",
        orderedItemIds: ["first"],
      })),
      MissionControlTransitionError,
    );

    const seededDone = structuredClone(resequenced.project.document);
    seededDone.items.first = {
      ...seededDone.items.first!,
      phase: "done",
    };
    const followUp = reduceMissionControlProjectAction(
      seededDone,
      action({
        type: "item.create",
        projectId: PROJECT_A,
        actionId: "create-follow-up",
        expectedRevision: 4,
        itemId: "follow-up",
        title: "Follow up: First",
        instructions: "Correct the accepted outcome without reopening it.",
        createdBy: "operator",
        completionContract: nonCodeContract(),
        followUpToItemId: "first",
        order: 2,
      }),
    ).document;
    assert.equal(followUp.items.first?.phase, "done");
    assert.equal(followUp.items["follow-up"]?.followUpToItemId, "first");
  },
);

test(
  "active project authority never dual-writes a session project snapshot",
  async () => {
    const store = new InMemorySessionStore();
    const session = await store.ensureSession("legacy-session");
    const before = structuredClone(session.state);
    await new MissionControlProjectService(store).execute(action({
      type: "item.create",
      projectId: PROJECT_A,
      actionId: "canonical-create",
      expectedRevision: 0,
      itemId: "canonical-item",
      title: "Canonical authority",
      instructions: "Do not dual write legacy state.",
      createdBy: "operator",
      order: 0,
    }));
    assert.deepEqual((await store.getSession("legacy-session"))?.state, before);
  },
);

test("project subscribers receive committed revisions only", async () => {
  const store = new InMemorySessionStore();
  const revisions: number[] = [];
  const service = new MissionControlProjectService(
    store,
    (project) => revisions.push(project.revision),
  );
  const createdAction = action({
    type: "item.create",
    projectId: PROJECT_A,
    actionId: "published-create",
    expectedRevision: 0,
    itemId: "published-item",
    title: "Published item",
    instructions: "Publish only after the store commits.",
    createdBy: "operator",
    order: 0,
  });
  await service.execute(createdAction);
  await service.execute(createdAction);
  await assert.rejects(service.execute(action({
    type: "item.discard",
    projectId: PROJECT_A,
    actionId: "stale-unpublished",
    expectedRevision: 0,
    itemId: "published-item",
    expectedItemVersion: 1,
  })), MissionControlRevisionConflictError);
  assert.deepEqual(revisions, [1]);
});

type MissionControlActionInput =
  MissionControlProjectAction extends infer Action
    ? Action extends MissionControlProjectAction
      ? Omit<Action, "actionTs"> & { actionTs?: string }
      : never
    : never;

function nonCodeContract() {
  return {
    workType: "non_code" as const,
    changeOutcome: "no_change" as const,
    validation: {
      mode: "not_applicable" as const,
      reason: "No project files change.",
    },
    requiredEvidence: [],
  };
}

function action(
  value: MissionControlActionInput,
): MissionControlProjectAction {
  return {
    actionTs: ACTION_TS,
    ...value,
  } as MissionControlProjectAction;
}
