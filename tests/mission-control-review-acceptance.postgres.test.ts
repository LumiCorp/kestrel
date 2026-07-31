import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionStore } from "../src/kestrel/contracts/store.js";
import {
  MissionControlReviewGateError,
  MissionControlReviewService,
  type MissionControlResolvedReviewEvidence,
  type MissionControlReviewEvidenceResolver,
} from "../src/missionControl/reviewAuthority.js";
import {
  parseMissionControlCompletionContract,
  type MissionControlCompletionContract,
  type MissionControlReviewBundle,
} from "../src/missionControl/reviewContracts.js";
import { createSessionStoreFromEnv } from "../src/store/createSessionStore.js";
import { contractTest } from "./helpers/contract-test.js";

const ACTION_TS = "2026-07-30T12:00:00.000Z";
const CANDIDATE_A = `sha256:${"a".repeat(64)}`;
const CANDIDATE_B = `sha256:${"b".repeat(64)}`;
const WORKSPACE_ROOT = "/workspace/project";

const CODE_CONTRACT: MissionControlCompletionContract = {
  workType: "code",
  changeOutcome: "changes",
  validation: {
    mode: "required",
    actionIds: ["package:test"],
  },
  requiredEvidence: ["automated_review", "delivery"],
};

const NON_CODE_CONTRACT: MissionControlCompletionContract = {
  workType: "non_code",
  changeOutcome: "no_change",
  validation: {
    mode: "not_applicable",
    reason: "This work produces a durable non-code artifact.",
  },
  requiredEvidence: ["artifact"],
};

contractTest(
  "runtime.mission-control-review-acceptance",
  "candidate-bound review acceptance is exact, atomic, replay safe, and durable",
  async (context) => {
    const databaseUrl =
      process.env.KESTREL_PRODUCT_RUNNER_DATABASE_URL?.trim();
    const temporaryRoot =
      databaseUrl === undefined
        ? await mkdtemp(join(tmpdir(), "kestrel-mc-review-"))
        : undefined;
    const options =
      databaseUrl === undefined
        ? {
            driver: "sqlite" as const,
            sqlitePath: join(temporaryRoot!, "runtime"),
            enforceSchemaV3: false,
          }
        : {
            driver: "postgres" as const,
            databaseUrl,
            enforceSchemaV3: false,
          };
    let handle = createSessionStoreFromEnv(options);
    await handle.ready();
    context.after(async () => {
      await handle.close();
      if (temporaryRoot !== undefined) {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    });

    const gateProject = randomUUID();
    const gateResolver = new MutableEvidenceResolver();
    await seedCompletedItem(handle.store, gateProject, "gate-item", CODE_CONTRACT);
    const gateService = new MissionControlReviewService(
      handle.store,
      gateResolver,
    );

    assert.throws(
      () =>
        parseMissionControlCompletionContract({
          workType: "code",
          changeOutcome: "changes",
          validation: {
            mode: "waived",
            authorizationId: "",
            reason: "No authorization identity.",
          },
          requiredEvidence: [],
        }),
      /authorizationId must be a non-empty string/u,
    );
    gateResolver.resolved.change.conflicted = true;
    await rejectsGate(
      gateService.execute(admitAction(gateProject, "gate-item")),
      "change_conflicted",
    );
    gateResolver.resolved.change.conflicted = false;
    gateResolver.resolved.change.outcome = "no_change";
    await rejectsGate(
      gateService.execute(admitAction(gateProject, "gate-item")),
      "change_outcome_mismatch",
    );
    gateResolver.resolved.change.outcome = "changes";
    gateResolver.resolved.validationResults = [];
    await rejectsGate(
      gateService.execute(admitAction(gateProject, "gate-item")),
      "validation_missing",
    );
    gateResolver.resolved.validationResults = [validation(CANDIDATE_B)];
    await rejectsGate(
      gateService.execute(admitAction(gateProject, "gate-item")),
      "validation_mixed_candidate",
    );
    gateResolver.resolved.validationResults = [{
      ...validation(CANDIDATE_A),
      outcome: "stale",
    }];
    await rejectsGate(
      gateService.execute(admitAction(gateProject, "gate-item")),
      "validation_stale",
    );
    gateResolver.resolved.validationResults = [{
      ...validation(CANDIDATE_A),
      outcome: "failed",
    }];
    await rejectsGate(
      gateService.execute(admitAction(gateProject, "gate-item")),
      "validation_failed",
    );
    gateResolver.resolved.validationResults = [validation(CANDIDATE_A)];
    gateResolver.resolved.conditional = gateResolver.resolved.conditional.filter(
      (entry) => entry.kind !== "delivery",
    );
    await rejectsGate(
      gateService.execute(admitAction(gateProject, "gate-item")),
      "conditional_evidence_missing",
    );
    gateResolver.reset();
    gateResolver.resolved.conditional[0]!.status = "failed";
    await rejectsGate(
      gateService.execute(admitAction(gateProject, "gate-item")),
      "conditional_evidence_failed",
    );
    gateResolver.reset();
    gateResolver.resolved.conditional[0]!.status = "stale";
    await rejectsGate(
      gateService.execute(admitAction(gateProject, "gate-item")),
      "conditional_evidence_stale",
    );
    gateResolver.reset();
    gateResolver.resolved.conditional[0]!.candidateFingerprint = CANDIDATE_B;
    await rejectsGate(
      gateService.execute(admitAction(gateProject, "gate-item")),
      "conditional_evidence_mixed_candidate",
    );
    gateResolver.reset();
    gateResolver.resolved.linkedRuns = [{
      sessionId: "session-gate-item",
      threadId: "session-gate-item",
      runId: "linked-run",
      status: "waiting",
    }];
    await rejectsGate(
      gateService.execute(admitAction(gateProject, "gate-item")),
      "linked_work_unsettled",
    );
    gateResolver.reset();
    gateResolver.resolved.change.candidateFingerprint = CANDIDATE_B;
    await rejectsGate(
      gateService.execute(admitAction(gateProject, "gate-item")),
      "candidate_mismatch",
    );
    gateResolver.reset();

    const admittedGate = await gateService.execute(
      admitAction(gateProject, "gate-item"),
    );
    const gateBundle =
      admittedGate.project.document.items["gate-item"]?.reviewBundles?.[0];
    assert.ok(gateBundle);
    assert.equal(gateBundle.candidate.candidateFingerprint, CANDIDATE_A);
    assert.deepEqual(
      gateBundle.evidence.map((entry) => entry.referenceId).sort(),
      [
        "change-a",
        "delivery-a",
        "review-a",
        "run-command-gate-item",
        "validation-a",
      ],
    );
    await assert.rejects(
      handle.store.updateMissionControlProjectState({
        projectId: gateProject,
        actionId: "tamper-gate-bundle",
        requestFingerprint: "f".repeat(64),
        expectedRevision: 2,
        apply: (document) => {
          const item = document.items["gate-item"];
          assert.ok(item);
          return {
            document: {
              ...document,
              items: {
                ...document.items,
                [item.id]: {
                  ...item,
                  reviewBundles: (item.reviewBundles ?? []).map((bundle) => ({
                    ...bundle,
                    frozenAt: "2026-07-30T12:01:00.000Z",
                  })),
                },
              },
            },
            effects: [],
          };
        },
      }),
      /id does not match its frozen bundle content/u,
    );
    const requested = await gateService.execute({
      type: "review.request_changes",
      projectId: gateProject,
      actionId: "request-gate-changes",
      actionTs: ACTION_TS,
      expectedRevision: 2,
      itemId: "gate-item",
      expectedItemVersion: 2,
      attemptId: "attempt-gate-item",
      expectedAttemptVersion: 1,
      candidateFingerprint: CANDIDATE_A,
      bundleId: gateBundle.id,
      operatorId: "operator-1",
      reason: "Revise the candidate.",
    });
    const requestedItem = requested.project.document.items["gate-item"];
    assert.equal(requestedItem?.phase, "ready");
    assert.equal(requestedItem?.currentReviewBundleId, undefined);
    assert.equal(requestedItem?.reviewBundles?.length, 1);
    assert.deepEqual(
      requestedItem?.reviewDecisions?.map((decision) => decision.decision),
      ["changes_requested"],
    );
    assert.equal(requestedItem?.attempts.length, 1);

    const nonCodeProject = randomUUID();
    const nonCodeResolver = new MutableEvidenceResolver();
    nonCodeResolver.resolved.change.outcome = "no_change";
    nonCodeResolver.resolved.validationResults = [];
    nonCodeResolver.resolved.conditional = [{
      kind: "artifact",
      referenceId: "artifact-a",
      candidateFingerprint: CANDIDATE_A,
      status: "satisfied",
      sessionId: "session-non-code-item",
      threadId: "session-non-code-item",
      runId: "run-non-code-item",
    }];
    await seedCompletedItem(
      handle.store,
      nonCodeProject,
      "non-code-item",
      NON_CODE_CONTRACT,
    );
    const nonCodeService = new MissionControlReviewService(
      handle.store,
      nonCodeResolver,
    );
    const nonCode = await nonCodeService.execute(
      admitAction(nonCodeProject, "non-code-item", {
        validationResults: [],
        automatedReviews: [],
        deliveries: [],
        artifacts: ["artifact-a"],
      }),
    );
    const nonCodeEvidence =
      nonCode.project.document.items["non-code-item"]?.reviewBundles?.[0]?.evidence;
    assert.ok(
      nonCodeEvidence?.some(
        (entry) =>
          entry.kind === "change" && entry.outcome === "no_change",
      ),
    );
    assert.ok(
      nonCodeEvidence?.some(
        (entry) =>
          entry.kind === "validation" &&
          entry.outcome === "not_applicable",
      ),
    );

    const acceptanceProject = randomUUID();
    const acceptanceResolver = new MutableEvidenceResolver();
    await seedCompletedItem(
      handle.store,
      acceptanceProject,
      "accept-item",
      CODE_CONTRACT,
    );
    const acceptanceService = new MissionControlReviewService(
      handle.store,
      acceptanceResolver,
    );
    const admitted = await acceptanceService.execute(
      admitAction(acceptanceProject, "accept-item"),
    );
    const currentBundle =
      admitted.project.document.items["accept-item"]?.reviewBundles?.[0];
    assert.ok(currentBundle);
    const { id: _currentBundleId, ...currentBundleContent } =
      structuredClone(currentBundle);
    const historicalContent: Omit<MissionControlReviewBundle, "id"> = {
      ...currentBundleContent,
      actionId: "historical-bundle",
    };
    const historicalBundle: MissionControlReviewBundle = {
      id: `sha256:${createHash("sha256")
        .update(stableJson(historicalContent))
        .digest("hex")}`,
      ...historicalContent,
    };
    await handle.store.updateMissionControlProjectState({
      projectId: acceptanceProject,
      actionId: "seed-historical-bundle",
      requestFingerprint: "d".repeat(64),
      expectedRevision: 2,
      apply: (document) => {
        const item = document.items["accept-item"];
        assert.ok(item);
        return {
          document: {
            ...document,
            items: {
              ...document.items,
              [item.id]: {
                ...item,
                reviewBundles: [historicalBundle, ...(item.reviewBundles ?? [])],
              },
            },
          },
          effects: [],
        };
      },
    });

    await rejectsGate(
      acceptanceService.execute(
        acceptAction(
          acceptanceProject,
          historicalBundle.id,
          "wrong-bundle",
          3,
        ),
      ),
      "bundle_mismatch",
    );
    acceptanceResolver.currentFingerprint = CANDIDATE_B;
    await rejectsGate(
      acceptanceService.execute(
        acceptAction(
          acceptanceProject,
          currentBundle.id,
          "changed-candidate",
          3,
        ),
      ),
      "candidate_mismatch",
    );
    acceptanceResolver.currentFingerprint = CANDIDATE_A;
    acceptanceResolver.enableCandidateBarrier(2);
    const concurrent = await Promise.allSettled([
      acceptanceService.execute(
        acceptAction(
          acceptanceProject,
          currentBundle.id,
          "accept-one",
          3,
        ),
      ),
      acceptanceService.execute(
        acceptAction(
          acceptanceProject,
          currentBundle.id,
          "accept-two",
          3,
        ),
      ),
    ]);
    assert.equal(
      concurrent.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const winner = concurrent.find(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<MissionControlReviewService["execute"]>>
      > => result.status === "fulfilled",
    );
    assert.ok(winner);
    const acceptedItem = winner.value.project.document.items["accept-item"];
    assert.equal(acceptedItem?.phase, "done");
    assert.equal(acceptedItem?.reviewDecisions?.length, 1);
    const acceptance = acceptedItem?.reviewDecisions?.[0];
    assert.equal(acceptance?.decision, "accepted");
    assert.equal(acceptance?.bundleId, currentBundle.id);
    assert.equal(acceptance?.candidateFingerprint, CANDIDATE_A);
    assert.equal(acceptance?.operatorId, "operator-1");
    assert.ok(
      acceptance?.actionId === "accept-one" ||
        acceptance?.actionId === "accept-two",
    );

    const replay = await acceptanceService.execute(
      acceptAction(
        acceptanceProject,
        currentBundle.id,
        acceptance!.actionId,
        3,
      ),
    );
    assert.equal(replay.duplicate, true);
    assert.deepEqual(replay.project, winner.value.project);

    await handle.close();
    handle = createSessionStoreFromEnv(options);
    await handle.ready();
    const relaunched = await handle.store.getMissionControlProjectState(
      acceptanceProject,
    );
    const relaunchedItem = relaunched?.document.items["accept-item"];
    assert.equal(relaunchedItem?.phase, "done");
    assert.deepEqual(relaunchedItem?.reviewDecisions, acceptedItem?.reviewDecisions);
    assert.deepEqual(relaunchedItem?.reviewBundles, acceptedItem?.reviewBundles);
  },
);

class MutableEvidenceResolver implements MissionControlReviewEvidenceResolver {
  currentFingerprint = CANDIDATE_A;
  resolved: MissionControlResolvedReviewEvidence = resolvedEvidence();
  private barrierTarget = 0;
  private barrierResolvers: Array<() => void> = [];

  reset(): void {
    this.resolved = resolvedEvidence();
  }

  enableCandidateBarrier(target: number): void {
    this.barrierTarget = target;
    this.barrierResolvers = [];
  }

  async resolve(): Promise<MissionControlResolvedReviewEvidence> {
    return structuredClone(this.resolved);
  }

  async currentCandidate(): Promise<{ candidateFingerprint: string }> {
    if (this.barrierTarget > 0) {
      await new Promise<void>((resolve) => {
        this.barrierResolvers.push(resolve);
        if (this.barrierResolvers.length === this.barrierTarget) {
          const resolvers = this.barrierResolvers;
          this.barrierResolvers = [];
          this.barrierTarget = 0;
          for (const release of resolvers) release();
        }
      });
    }
    return { candidateFingerprint: this.currentFingerprint };
  }
}

async function seedCompletedItem(
  store: SessionStore,
  projectId: string,
  itemId: string,
  completionContract: MissionControlCompletionContract,
): Promise<void> {
  await store.updateMissionControlProjectState({
    projectId,
    actionId: `seed-${itemId}`,
    requestFingerprint: "e".repeat(64),
    expectedRevision: 0,
    apply: (document) => ({
      document: {
        ...document,
        items: {
          ...document.items,
          [itemId]: {
            id: itemId,
            title: `Review ${itemId}`,
            instructions: "Produce candidate-bound evidence.",
            createdBy: "operator",
            completionContract,
            phase: "active",
            order: 0,
            attempts: [{
              id: `attempt-${itemId}`,
              generation: 1,
              initiatedBy: "operator",
              status: "completed",
              version: 1,
              profileId: "desktop_dev_local",
              requestedSessionId: `session-${itemId}`,
              requestedThreadId: `session-${itemId}`,
              dispatchCommandId: `run-command-${itemId}`,
              dispatchRunId: `run-${itemId}`,
              runs: [{
                sessionId: `session-${itemId}`,
                threadId: `session-${itemId}`,
                runId: `run-${itemId}`,
                commandId: `run-command-${itemId}`,
                acceptedAt: ACTION_TS,
              }],
              currentRunId: `run-${itemId}`,
              createdAt: ACTION_TS,
              updatedAt: ACTION_TS,
            }],
            currentAttemptId: `attempt-${itemId}`,
            reviewBundles: [],
            reviewDecisions: [],
            version: 1,
            createdAt: ACTION_TS,
            updatedAt: ACTION_TS,
          },
        },
      },
      effects: [],
    }),
  });
}

function admitAction(
  projectId: string,
  itemId: string,
  overrides: Partial<{
    validationResults: string[];
    automatedReviews: string[];
    deliveries: string[];
    artifacts: string[];
  }> = {},
) {
  return {
    type: "review.admit",
    projectId,
    actionId: `admit-${itemId}`,
    actionTs: ACTION_TS,
    expectedRevision: 1,
    itemId,
    expectedItemVersion: 1,
    attemptId: `attempt-${itemId}`,
    expectedAttemptVersion: 1,
    candidate: {
      workspaceRoot: WORKSPACE_ROOT,
      candidateFingerprint: CANDIDATE_A,
    },
    evidence: {
      change: "change-a",
      validationResults: overrides.validationResults ?? ["validation-a"],
      automatedReviews: overrides.automatedReviews ?? ["review-a"],
      deliveries: overrides.deliveries ?? ["delivery-a"],
      artifacts: overrides.artifacts ?? [],
      checkpoints: [],
      previews: [],
    },
  };
}

function acceptAction(
  projectId: string,
  bundleId: string,
  actionId: string,
  expectedRevision: number,
) {
  return {
    type: "review.accept",
    projectId,
    actionId,
    actionTs: ACTION_TS,
    expectedRevision,
    itemId: "accept-item",
    expectedItemVersion: 2,
    attemptId: "attempt-accept-item",
    expectedAttemptVersion: 1,
    candidateFingerprint: CANDIDATE_A,
    bundleId,
    operatorId: "operator-1",
  };
}

function resolvedEvidence(): MissionControlResolvedReviewEvidence {
  return {
    change: {
      referenceId: "change-a",
      workspaceRoot: WORKSPACE_ROOT,
      candidateFingerprint: CANDIDATE_A,
      outcome: "changes",
      conflicted: false,
    },
    validationResults: [validation(CANDIDATE_A)],
    conditional: [
      {
        kind: "automated_review",
        referenceId: "review-a",
        candidateFingerprint: CANDIDATE_A,
        status: "satisfied",
      },
      {
        kind: "delivery",
        referenceId: "delivery-a",
        candidateFingerprint: CANDIDATE_A,
        status: "satisfied",
      },
    ],
    linkedRuns: [],
  };
}

function validation(
  candidateFingerprint: string,
): MissionControlResolvedReviewEvidence["validationResults"][number] {
  return {
    referenceId: "validation-a",
    actionId: "package:test",
    candidateFingerprint,
    outcome: "passed",
  };
}

async function rejectsGate(
  promise: Promise<unknown>,
  reason: MissionControlReviewGateError["reason"],
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof MissionControlReviewGateError &&
      error.reason === reason,
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
