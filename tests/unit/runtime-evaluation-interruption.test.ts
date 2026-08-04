import test from "node:test";
import assert from "node:assert/strict";

import {
  LEAN_RUNTIME_EVALUATION_BUDGET_V1,
  RUNTIME_EVALUATION_THRESHOLDS_V1,
  createRuntimeEvaluationPolicyV1,
} from "../../src/kestrel/contracts/evaluation.js";
import type { ArtifactIntent } from "../../src/kestrel/contracts/execution.js";
import type { PersistedArtifact } from "../../src/kestrel/contracts/store.js";
import { COMPLETION_EVIDENCE_ASSET_BUNDLE_V1 } from "../../src/evaluation/assets.js";
import {
  RUNTIME_EVALUATION_ARTIFACT_TYPES,
  RuntimeEvaluationCoordinator,
  createDefaultRuntimeEvaluatorRegistry,
} from "../../src/evaluation/index.js";
import { ExecutionBoundaryPolicyRuntime } from "../../src/security/ExecutionBoundaryPolicy.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { bindTestRuntimeEvaluationCalibration } from "../helpers/runtimeEvaluationCalibration.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

for (const crash of [
  {
    name: "request persistence",
    type: RUNTIME_EVALUATION_ARTIFACT_TYPES.request,
    timing: "after" as const,
    resumedDisposition: "continue",
    resumedJudgeCalls: 1,
  },
  {
    name: "action start",
    type: RUNTIME_EVALUATION_ARTIFACT_TYPES.attempt,
    timing: "after" as const,
    resumedDisposition: "review",
    resumedJudgeCalls: 0,
  },
  {
    name: "judge response before verdict persistence",
    type: RUNTIME_EVALUATION_ARTIFACT_TYPES.verdict,
    timing: "before" as const,
    resumedDisposition: "review",
    resumedJudgeCalls: 0,
  },
  {
    name: "verdict persistence",
    type: RUNTIME_EVALUATION_ARTIFACT_TYPES.verdict,
    timing: "after" as const,
    resumedDisposition: "continue",
    resumedJudgeCalls: 0,
  },
  {
    name: "decision persistence",
    type: RUNTIME_EVALUATION_ARTIFACT_TYPES.decision,
    timing: "after" as const,
    resumedDisposition: "continue",
    resumedJudgeCalls: 0,
  },
]) {
  test(`evaluation interruption at ${crash.name} resumes or fails closed`, async () => {
    const durableStore = new InMemorySessionStore();
    const interruptedStore = new InterruptingArtifactStore(
      durableStore,
      crash.type,
      crash.timing,
    );
    let firstJudgeCalls = 0;
    const interrupted = coordinator(interruptedStore, async () => {
      firstJudgeCalls += 1;
      return judgeResult();
    });
    await assert.rejects(
      interrupted.evaluateHook(finalInput()),
      new RegExp(`crash ${crash.timing} ${escapeRegExp(crash.type)}`, "u"),
    );

    let resumedJudgeCalls = 0;
    const resumed = coordinator(durableStore, async () => {
      resumedJudgeCalls += 1;
      return judgeResult();
    });
    const result = await resumed.evaluateHook(finalInput());

    assert.equal(result?.decision.disposition, crash.resumedDisposition);
    assert.equal(resumedJudgeCalls, crash.resumedJudgeCalls);
    assert.ok(firstJudgeCalls <= 1);
    if (crash.resumedDisposition === "review") {
      assert.equal(result?.decision.reasonCode, "EVALUATION_CALL_INTERRUPTED");
    } else {
      assert.equal(result?.decision.reasonCode, "EVALUATION_PASSED");
    }
  });
}

test("a persisted evaluation decision is immutable across repeated restart consumption", async () => {
  const store = new InMemorySessionStore();
  let judgeCalls = 0;
  const initial = coordinator(store, async () => {
    judgeCalls += 1;
    return judgeResult();
  });
  const first = await initial.evaluateHook(finalInput());
  const restarted = coordinator(store, async () => {
    judgeCalls += 1;
    throw new Error("Persisted evaluation must not rerun the judge.");
  });
  const second = await restarted.evaluateHook(finalInput());
  const third = await restarted.evaluateHook(finalInput());

  assert.equal(judgeCalls, 1);
  assert.equal(second?.request.requestId, first?.request.requestId);
  assert.equal(second?.decision.decisionId, first?.decision.decisionId);
  assert.equal(third?.decision.decisionId, first?.decision.decisionId);
});

function coordinator(
  store: Pick<InMemorySessionStore, "appendArtifacts" | "getArtifact" | "listArtifacts">,
  invokeJudge: () => Promise<ReturnType<typeof judgeResult>>,
) {
  const evaluation = bindTestRuntimeEvaluationCalibration(policy());
  return new RuntimeEvaluationCoordinator({
    policy: evaluation.policy,
    calibrationRecord: evaluation.calibrationRecord,
    executionProfileFingerprint: "c".repeat(64),
    evaluatorRegistry: createDefaultRuntimeEvaluatorRegistry(),
    store,
    executionBoundaryRuntime: new ExecutionBoundaryPolicyRuntime(),
    appendLifecycleEvent: async () => {},
    invokeJudge,
  });
}

class InterruptingArtifactStore {
  private interrupted = false;

  constructor(
    private readonly store: InMemorySessionStore,
    private readonly targetType: string,
    private readonly timing: "before" | "after",
  ) {}

  getArtifact(input: { artifactId: string; sessionId: string }) {
    return this.store.getArtifact(input);
  }

  listArtifacts(input: {
    sessionId: string;
    runId?: string | undefined;
    stepIndex?: number | undefined;
    type?: string | undefined;
    limit?: number | undefined;
  }): Promise<PersistedArtifact[]> {
    return this.store.listArtifacts(input);
  }

  async appendArtifacts(
    runId: string,
    sessionId: string,
    stepIndex: number,
    artifacts: ArtifactIntent[],
  ): Promise<PersistedArtifact[]> {
    const targeted =
      this.interrupted === false &&
      artifacts.some((artifact) => artifact.type === this.targetType);
    if (targeted && this.timing === "before") {
      this.interrupted = true;
      throw new Error(`crash before ${this.targetType}`);
    }
    const persisted = await this.store.appendArtifacts(
      runId,
      sessionId,
      stepIndex,
      artifacts,
    );
    if (targeted && this.timing === "after") {
      this.interrupted = true;
      throw new Error(`crash after ${this.targetType}`);
    }
    return persisted;
  }
}

function finalInput() {
  return {
    runId: "run-evaluation-interruption",
    sessionId: "session-evaluation-interruption",
    threadId: "thread-evaluation-interruption",
    stepIndex: 1,
    hookKind: "pre_delivery" as const,
    sourceId: "pre_delivery",
    objective: "Return a complete result.",
    candidateOutput: "Complete result.",
    evidence: [{
      evidenceId: "artifact-1",
      kind: "artifact" as const,
      value: { status: "complete" },
    }],
  };
}

function policy() {
  return createRuntimeEvaluationPolicyV1({
    policyId: "evaluation:interruption",
    evaluator: {
      evaluatorId: "completion-evidence",
      evaluatorVersion: "1.0.0",
    },
    assets: COMPLETION_EVIDENCE_ASSET_BUNDLE_V1,
    judge: {
      route: "profile_primary",
      provider: "openai",
      model: "gpt-5.4-2026-03-05",
      modelRegistrationRevision: HASH_A,
      capabilities: {
        visionInputEnabled: false,
        toolCallingEnabled: true,
        structuredOutputEnabled: true,
        reasoningModes: ["off", "summary", "provider_visible"],
      },
      pricing: {
        priceRevision: HASH_B,
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 8,
      },
    },
    calibration: {
      recordId: "completion-evidence.calibration.openai-gpt-5.4",
      recordRevision: HASH_A,
    },
    hooks: [{ kind: "pre_delivery", mode: "blocking", selectorIds: [] }],
    budget: LEAN_RUNTIME_EVALUATION_BUDGET_V1,
    thresholds: RUNTIME_EVALUATION_THRESHOLDS_V1,
    actions: {
      revisionHandlerId: "evaluation.revise",
      reviewOptionIds: [
        "evaluation.accept_once",
        "evaluation.revise",
        "terminal.fail",
      ],
    },
  });
}

function judgeResult() {
  return {
    output: {
      score: 0.95,
      confidence: 0.9,
      assertions: [
        assertion("outcome_complete"),
        assertion("evidence_consistent"),
        assertion("evaluation_integrity"),
      ],
      rationale: "Complete and supported.",
      reasonCodes: ["COMPLETE"],
      repairable: false,
    },
    provider: "openai" as const,
    requestedModel: "gpt-5.4-2026-03-05",
    observedModelRevision: "gpt-5.4-2026-03-05",
    usage: { inputTokens: 100, outputTokens: 40 },
    latencyMs: 10,
  };
}

function assertion(assertionId: string) {
  return {
    assertionId,
    passed: true,
    rationale: "Passed.",
    evidenceRefs: [],
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
