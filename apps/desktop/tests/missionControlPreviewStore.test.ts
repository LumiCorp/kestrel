import test from "node:test";
import assert from "node:assert/strict";

import {
  createMissionControlPreviewStore,
  createPreviewMissionControlProject,
  reducePreviewMissionControlIntent,
} from "../renderer/src/missionControlPreviewStore.js";
import type { DesktopMissionControlActionIntent } from "../src/contracts.js";
import { parseMissionControlProjectStateRecord } from "../../../src/missionControl/projectAuthority.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-17T12:00:00.000Z";

test("Mission Control preview fixtures are authoritative and Done is fully accepted", async () => {
  const response = await createPreviewMissionControlProject(PROJECT_ID, NOW);
  assert.doesNotThrow(() => parseMissionControlProjectStateRecord(response.project));

  const done = response.project.document.items["preview-done"]!;
  const attempt = done.attempts.find(
    (candidate) => candidate.id === done.currentAttemptId,
  );
  const bundle = done.reviewBundles?.find(
    (candidate) => candidate.id === done.currentReviewBundleId,
  );
  const decision = done.reviewDecisions?.at(-1);
  assert.equal(done.phase, "done");
  assert.equal(attempt?.status, "completed");
  assert.ok(bundle);
  assert.equal(decision?.decision, "accepted");
  assert.equal(decision?.attemptId, attempt?.id);
  assert.equal(decision?.bundleId, bundle?.id);
  assert.equal(
    decision?.candidateFingerprint,
    bundle?.candidate.candidateFingerprint,
  );
  assert.deepEqual(
    bundle?.evidence
      .filter((entry) => entry.kind === "validation")
      .map((entry) => entry.outcome),
    ["passed", "passed"],
  );
});

test("Mission Control preview resequencing requires the exact current phase set", async () => {
  const current = await createPreviewMissionControlProject(PROJECT_ID, NOW);
  const first = current.project.document.items["preview-ready"]!;
  current.project.document.items["preview-ready-2"] = {
    ...structuredClone(first),
    id: "preview-ready-2",
    title: "Second Ready item",
    order: 2,
  };
  const before = structuredClone(current);
  const base = {
    type: "resequence" as const,
    projectId: PROJECT_ID,
    expectedRevision: current.project.revision,
    targetPhase: "ready" as const,
  };

  for (const orderedItemIds of [
    ["preview-ready"],
    ["preview-ready", "preview-ready"],
    ["preview-ready", "preview-active"],
  ]) {
    await assert.rejects(
      reducePreviewMissionControlIntent(
        current,
        { ...base, orderedItemIds },
        { now: NOW, createId: () => "unused" },
      ),
      /complete current phase set/u,
    );
    assert.deepEqual(current, before);
  }

  const reordered = await reducePreviewMissionControlIntent(
    current,
    { ...base, orderedItemIds: ["preview-ready-2", "preview-ready"] },
    { now: NOW, createId: () => "unused" },
  );
  assert.equal(reordered.project.revision, current.project.revision + 1);
  assert.equal(reordered.project.document.items["preview-ready-2"]?.order, 0);
  assert.equal(reordered.project.document.items["preview-ready"]?.order, 1);
});

test("Mission Control preview rejects lifecycle-invalid transitions without mutation", async () => {
  const store = createMissionControlPreviewStore({ now: () => NOW });
  let publications = 0;
  store.subscribe(() => { publications += 1; });
  const before = await store.getProject(PROJECT_ID);
  const item = (itemId: string) => before.project.document.items[itemId]!;
  const attempt = (itemId: string) => {
    const workItem = item(itemId);
    return workItem.attempts.find(
      (candidate) => candidate.id === workItem.currentAttemptId,
    )!;
  };
  const review = item("preview-review");
  const reviewAttempt = attempt("preview-review");
  const reviewBundle = review.reviewBundles!.find(
    (candidate) => candidate.id === review.currentReviewBundleId,
  )!;
  const waiting = attempt("preview-waiting");
  const active = attempt("preview-active");
  const contract = item("preview-ready").completionContract!;
  const base = {
    projectId: PROJECT_ID,
    expectedRevision: before.project.revision,
  };
  const invalidIntents: DesktopMissionControlActionIntent[] = [
    {
      ...base,
      type: "start",
      itemId: "preview-done",
      expectedItemVersion: item("preview-done").version,
    },
    {
      ...base,
      type: "update",
      itemId: "preview-active",
      expectedItemVersion: item("preview-active").version,
      title: "Invalid update",
      instructions: "Completed execution already exists.",
      completionContract: contract,
    },
    {
      ...base,
      type: "reply",
      itemId: "preview-waiting",
      expectedItemVersion: item("preview-waiting").version,
      attemptId: waiting.id,
      expectedAttemptVersion: waiting.version,
      requestId: "wrong-request",
      message: "Invalid reply",
    },
    {
      ...base,
      type: "stop",
      itemId: "preview-active",
      expectedItemVersion: item("preview-active").version,
      attemptId: active.id,
      expectedAttemptVersion: active.version,
      runId: "wrong-run",
      commandId: active.runs[0]!.commandId,
    },
    {
      ...base,
      type: "prepare_review",
      itemId: "preview-active",
      expectedItemVersion: item("preview-active").version,
      attemptId: active.id,
      expectedAttemptVersion: active.version,
    },
    {
      ...base,
      type: "accept",
      itemId: review.id,
      expectedItemVersion: review.version,
      attemptId: reviewAttempt.id,
      expectedAttemptVersion: reviewAttempt.version,
      candidateFingerprint: "sha256:invalid",
      bundleId: reviewBundle.id,
    },
    {
      ...base,
      type: "create",
      title: "Invalid follow-up",
      instructions: "A follow-up cannot point at unfinished work.",
      completionContract: contract,
      followUpToItemId: "preview-ready",
    },
    {
      ...base,
      type: "configure_autopilot",
      enabled: true,
      wipLimit: 2,
      confirmed: false,
    },
  ];

  for (const intent of invalidIntents) {
    await assert.rejects(store.execute(intent));
    assert.deepEqual(await store.getProject(PROJECT_ID), before);
  }
  assert.equal(publications, 0);

  const started = await store.execute({
    ...base,
    type: "start",
    itemId: "preview-ready",
    expectedItemVersion: item("preview-ready").version,
  });
  assert.equal(started.project.document.items["preview-ready"]?.phase, "active");
  assert.equal(publications, 1);
});

test("Mission Control preview store is deterministic and publishes only committed transitions", async () => {
  const store = createMissionControlPreviewStore({
    now: () => NOW,
    createId: () => "fixed-id",
    projectPath: () => "/workspace/project",
  });
  let publications = 0;
  store.subscribe(() => {
    publications += 1;
  });
  const initial = await store.getProject(PROJECT_ID);
  assert.equal(store.inspectSetup(PROJECT_ID).projectPath, "/workspace/project");

  await assert.rejects(store.execute({
    type: "configure_autopilot",
    projectId: PROJECT_ID,
    expectedRevision: initial.project.revision - 1,
    enabled: true,
    wipLimit: 2,
    confirmed: true,
  }), /revision conflict/u);
  assert.equal(publications, 0);
  assert.equal((await store.getProject(PROJECT_ID)).project.revision, initial.project.revision);

  const next = await store.execute({
    type: "create",
    projectId: PROJECT_ID,
    expectedRevision: initial.project.revision,
    title: "Deterministic work",
    instructions: "Use the injected preview identity.",
    completionContract: {
      workType: "non_code",
      changeOutcome: "no_change",
      validation: { mode: "not_applicable", reason: "No project changes." },
      requiredEvidence: [],
    },
  });
  assert.equal(publications, 1);
  assert.equal(next.project.document.items["preview-fixed-id"]?.title, "Deterministic work");
});
