import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import {
  parseRunnerStructuredReviewInteractionV1,
  type RunnerInteractionRequestV1,
} from "@kestrel-agents/protocol";

import { getDesktopComposerSubmissionPolicy } from "../apps/desktop/renderer/src/composerPolicy.js";
import { readThreadStructuredReview } from "../apps/web/lib/turns/structured-review.js";
import {
  readExactReview,
  resolveExactReviewOptionId,
} from "../cli/app/waitForPrompt.js";
import { loadShellAndDotEnv } from "../cli/config/EnvLoader.js";
import type { TuiProfile } from "../cli/contracts.js";
import {
  KestrelChatRuntime,
  createRuntimeFactoryWithStore,
} from "../cli/runtime/KestrelChatRuntime.js";
import { DEFAULT_OPENAI_MODEL } from "../models/openai/OpenAiEnv.js";
import { createDefaultRuntimeEvaluatorRegistry } from "../src/evaluation/index.js";
import { COMPLETION_EVIDENCE_ASSET_BUNDLE_V1 } from "../src/evaluation/assets.js";
import { Kestrel } from "../src/kestrel/Kestrel.js";
import {
  LEAN_RUNTIME_EVALUATION_BUDGET_V1,
  RUNTIME_EVALUATION_THRESHOLDS_V1,
  createRuntimeEvaluationPolicyV1,
} from "../src/kestrel/contracts/evaluation.js";
import type { ModelGateway } from "../src/kestrel/contracts/model-io.js";
import { resolveProfileWithEvaluationPolicy } from "../src/profile/evaluationPolicy.js";
import { fingerprintResolvedProfile } from "../src/profile/kestrelOnePolicy.js";
import { InMemorySessionStore } from "../src/store/InMemorySessionStore.js";
import { legacyRecoveryReviewInteractionFixture } from "../tests/fixtures/structured-review-contract.js";
import { createTestToolGateway } from "../tests/helpers/createTestToolGateway.js";
import { bindTestRuntimeEvaluationCalibration } from "../tests/helpers/runtimeEvaluationCalibration.js";

const SAFE_FAILURE_KEY = "invalid-live-explicit-semantics-key";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

interface ProviderEvidence {
  status: number;
  credential: "live" | "invalid" | "other";
  injected: boolean;
}

async function main(): Promise<void> {
  await loadShellAndDotEnv(process.cwd(), {
    preferDotEnvKeys: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  });
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  assert.ok(apiKey, "OPENAI_API_KEY is required for the live runtime acceptance test.");

  const model = DEFAULT_OPENAI_MODEL;
  const profile = buildProfile(model);
  const store = new InMemorySessionStore();
  const sessionId = `live-explicit-semantics-${randomUUID()}`;
  const marker = `KESTREL_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const providerEvidence: ProviderEvidence[] = [];
  const originalFetch = globalThis.fetch;
  let injectTransientFailure = true;

  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!isOpenAiRequest(url)) return originalFetch(input, init);
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const credential = authorization.includes(apiKey)
      ? "live"
      : authorization.includes(SAFE_FAILURE_KEY)
        ? "invalid"
        : "other";
    if (credential === "live" && injectTransientFailure) {
      injectTransientFailure = false;
      providerEvidence.push({ status: 503, credential, injected: true });
      return new Response(
        JSON.stringify({ error: { message: "Injected transient failure", type: "server_error" } }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
    const response = await originalFetch(input, init);
    providerEvidence.push({ status: response.status, credential, injected: false });
    return response;
  };

  try {
    const validEnv = buildRuntimeEnvironment(process.env, apiKey, model);
    const invalidEnv = buildRuntimeEnvironment(
      process.env,
      SAFE_FAILURE_KEY,
      model,
    );

    const firstRuntime = createRuntime(profile, store, validEnv);
    const first = await firstRuntime.runTurn({
      sessionId,
      message: `Remember this exact marker for later: ${marker}. Reply briefly to confirm.`,
      eventType: "user.message",
      stepAgent: firstRuntime.getEntryStepAgent(),
      actor: operatorActor(),
    });
    assertCompleted(first, "initial live-model turn");
    assert.equal(first.output.waitFor, undefined);
    const firstDescription = await firstRuntime.describeSession(sessionId);
    const threadId = firstDescription?.threadId;
    assert.ok(threadId, "The first turn did not establish a canonical thread.");
    await firstRuntime.close();

    const restartedRuntime = createRuntime(profile, store, validEnv);
    const followUp = await restartedRuntime.runTurn({
      sessionId,
      message: "What exact marker did I ask you to remember? Reply with only the marker.",
      eventType: "user.message",
      stepAgent: restartedRuntime.getEntryStepAgent(),
      actor: operatorActor(),
    });
    assertCompleted(followUp, "post-restart multi-turn check");
    assert.match(followUp.assistantText ?? "", new RegExp(marker, "u"));
    await restartedRuntime.close();

    const failedRuntime = createRuntime(profile, store, invalidEnv);
    const failed = await failedRuntime.runTurn({
      sessionId,
      message: `Return the remembered marker ${marker}.`,
      eventType: "user.message",
      stepAgent: failedRuntime.getEntryStepAgent(),
      actor: operatorActor(),
    });
    assert.equal(failed.output.status, "FAILED");
    assert.equal(failed.output.waitFor, undefined);
    assert.equal(failed.output.errors?.[0]?.code, "MODEL_AUTH_ERROR");
    await failedRuntime.close();

    const repairedRuntime = createRuntime(profile, store, validEnv);
    const retried = await repairedRuntime.performOperatorAction({
      action: "retry",
      threadId,
      message: "Credential repaired; retry the failed turn.",
      actor: operatorActor(),
    });
    assertCompleted(retried.result, "explicit retry after credential repair");
    assert.match(retried.result?.assistantText ?? "", new RegExp(marker, "u"));
    await repairedRuntime.close();

    const clarification = await proveOrdinaryClarification();
    const evaluation = await proveEvaluationReview({
      model,
      candidate: first.assistantText ?? followUp.assistantText ?? marker,
    });
    const legacy = await proveLegacyWaitCancellation();

    assert.equal(
      providerEvidence.filter((entry) => entry.injected && entry.status === 503).length,
      1,
    );
    assert.ok(
      providerEvidence.some(
        (entry) => entry.credential === "live" && entry.status >= 200 && entry.status < 300,
      ),
      "No successful live OpenAI request was observed.",
    );
    assert.equal(
      providerEvidence.filter(
        (entry) => entry.credential === "invalid" && entry.status === 401,
      ).length,
      1,
      "Authentication failure should make one provider call and never retry.",
    );

    process.stdout.write(`${JSON.stringify({
      status: "passed",
      model,
      sessionId,
      threadId,
      markerDigest: createHash("sha256").update(marker).digest("hex"),
      providerStatuses: providerEvidence.map((entry) => ({
        status: entry.status,
        injected: entry.injected,
        credential: entry.credential,
      })),
      transientRetryCompletedWithoutWait: true,
      terminalAuthFailureCode: "MODEL_AUTH_ERROR",
      explicitRetryCompleted: retried.result?.output.status === "COMPLETED",
      multiTurnRestartCompleted: followUp.output.status === "COMPLETED",
      clarification,
      evaluation,
      legacy,
      surfaces: ["runtime", "desktop", "one_web", "plain_cli", "tui"],
    }, null, 2)}\n`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function buildProfile(model: string): TuiProfile {
  return {
    id: "live-explicit-runtime-semantics",
    label: "Live explicit runtime semantics",
    agent: "kestrel",
    sessionPrefix: "live-explicit-runtime-semantics",
    modelProvider: "openai",
    model,
    agentStageConfig: { modelByStage: { "agent.loop": model } },
    toolAllowlist: ["FinalizeAnswer"],
  };
}

function createRuntime(
  profile: TuiProfile,
  store: InMemorySessionStore,
  env: NodeJS.ProcessEnv,
): KestrelChatRuntime {
  return new KestrelChatRuntime(
    profile,
    createRuntimeFactoryWithStore(store, {
      resolveEnvironment: () => ({
        runtimeEnv: env,
        modelEnv: env,
        internetEnv: env,
        mcpEnv: env,
      }),
    }),
  );
}

async function proveOrdinaryClarification(): Promise<Record<string, unknown>> {
  const store = new InMemorySessionStore();
  const kestrel = createControlledKestrel(store);
  const sessionId = `ordinary-clarification-${randomUUID()}`;
  const requestId = `clarification-${randomUUID()}`;
  const interaction: RunnerInteractionRequestV1 = {
    version: "v1",
    requestId,
    kind: "user_input",
    eventType: "user.reply",
    prompt: "Which deployment region should be used?",
    metadata: { reason: "clarification" },
  };
  kestrel.registerStep("agent.loop", async (context) => {
    if (context.event.type === "user.reply") {
      return {
        status: "COMPLETED",
        statePatch: {
          agent: completedAgentState(context.session.state, "Using iad."),
        },
      };
    }
    return {
      status: "WAITING",
      nextStepAgent: "agent.loop",
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        prompt: interaction.prompt,
        interaction,
        metadata: interaction.metadata,
      },
    };
  });
  const waiting = await kestrel.run({
    id: `event-${randomUUID()}`,
    type: "user.message",
    sessionId,
    stepAgent: "agent.loop",
    payload: { message: "Deploy it." },
  });
  assert.equal(waiting.status, "WAITING");
  assert.equal(
    parseRunnerStructuredReviewInteractionV1(waiting.waitFor?.interaction).kind,
    "ordinary",
  );
  const resumed = await kestrel.run({
    id: `event-${randomUUID()}`,
    type: "user.reply",
    sessionId,
    payload: { message: "iad" },
  });
  assert.equal(resumed.status, "COMPLETED");
  return { requestId, acceptedText: true, status: resumed.status };
}

async function proveEvaluationReview(input: {
  model: string;
  candidate: string;
}): Promise<Record<string, unknown>> {
  const store = new InMemorySessionStore();
  const profile = buildEvaluationProfile(input.model);
  const first = createEvaluationKestrel(store, profile, input.candidate);
  const sessionId = `evaluation-review-${randomUUID()}`;
  const threadId = `evaluation-thread-${randomUUID()}`;
  const waiting = await first.run({
    id: `event-${randomUUID()}`,
    type: "user.message",
    sessionId,
    stepAgent: "agent.loop",
    payload: {
      message: "Evaluate the real-model candidate.",
      metadata: { threadId, actor: operatorActor() },
    },
  });
  assert.equal(waiting.status, "WAITING");
  const waitFor = waiting.waitFor;
  assert.ok(waitFor, "Evaluation did not produce a durable review wait.");
  const review = verifyFirstPartySurfaceClassifications({
    threadId,
    sessionId,
    waitFor,
  });
  assert.equal(resolveExactReviewOptionId(waitFor, "Accept once"), undefined);

  const restarted = createEvaluationKestrel(store, profile, input.candidate, true);
  const accepted = await restarted.run({
    id: `event-${randomUUID()}`,
    type: "user.reply",
    sessionId,
    payload: {
      recoveryOptionId: "evaluation.accept_once",
      metadata: { threadId, actor: operatorActor() },
    },
  });
  assert.equal(accepted.status, "COMPLETED");
  return {
    requestId: review.requestId,
    allowedOptionIds: review.allowedOptionIds,
    freeTextRejected: true,
    selectedOptionId: "evaluation.accept_once",
    restartCompleted: true,
  };
}

async function proveLegacyWaitCancellation(): Promise<Record<string, unknown>> {
  const store = new InMemorySessionStore();
  const kestrel = createControlledKestrel(store);
  const sessionId = `legacy-wait-${randomUUID()}`;
  let legacyWaitProduced = false;
  kestrel.registerStep("agent.loop", async (context) => {
    if (!legacyWaitProduced) {
      legacyWaitProduced = true;
      return {
        status: "WAITING",
        nextStepAgent: "agent.loop",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          prompt: legacyRecoveryReviewInteractionFixture.prompt,
          interaction: structuredClone(
            legacyRecoveryReviewInteractionFixture,
          ) as unknown as RunnerInteractionRequestV1,
          metadata: { reason: "recovery_review" },
        },
      };
    }
    return {
      status: "COMPLETED",
      statePatch: {
        agent: completedAgentState(context.session.state, "Fresh message completed."),
      },
    };
  });
  const waiting = await kestrel.run({
    id: `event-${randomUUID()}`,
    type: "user.message",
    sessionId,
    stepAgent: "agent.loop",
    payload: { message: "Load legacy wait." },
  });
  assert.equal(waiting.status, "WAITING");
  assert.equal(
    parseRunnerStructuredReviewInteractionV1(waiting.waitFor?.interaction).kind,
    "invalid_review",
  );
  await kestrel.cancelActiveRun(sessionId);
  const fresh = await kestrel.run({
    id: `event-${randomUUID()}`,
    type: "user.message",
    sessionId,
    stepAgent: "agent.loop",
    payload: { message: "Start fresh." },
  });
  assert.equal(fresh.status, "COMPLETED");
  return { explicitlyCancelled: true, freshMessageStatus: fresh.status };
}

function createControlledKestrel(store: InMemorySessionStore): Kestrel {
  const modelGateway: ModelGateway = { call: async <T>() => ({}) as T };
  return new Kestrel({
    store,
    modelGateway,
    toolGateway: createTestToolGateway({}),
  });
}

function buildEvaluationProfile(model: string): TuiProfile {
  const policy = createRuntimeEvaluationPolicyV1({
    policyId: "evaluation:live-explicit-semantics",
    evaluator: { evaluatorId: "completion-evidence", evaluatorVersion: "1.0.0" },
    assets: COMPLETION_EVIDENCE_ASSET_BUNDLE_V1,
    judge: {
      route: "profile_primary",
      provider: "openai",
      model,
      modelRegistrationRevision: HASH_A,
      capabilities: {
        visionInputEnabled: false,
        toolCallingEnabled: true,
        structuredOutputEnabled: true,
        reasoningModes: ["off", "summary", "provider_visible"],
      },
      pricing: {
        priceRevision: HASH_B,
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 4,
      },
    },
    calibration: { recordId: "calibration:live", recordRevision: HASH_A },
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
  return resolveProfileWithEvaluationPolicy({
    id: "live-evaluation-review",
    label: "Live evaluation review",
    agent: "reference-react",
    sessionPrefix: "live-evaluation-review",
    modelProvider: "openai",
    model,
    evaluationPolicy: bindTestRuntimeEvaluationCalibration(policy).policy,
  });
}

function createEvaluationKestrel(
  store: InMemorySessionStore,
  profile: TuiProfile,
  candidate: string,
  rejectUnexpectedJudge = false,
): Kestrel {
  const bound = bindTestRuntimeEvaluationCalibration(profile.evaluationPolicy!);
  const kestrel = new Kestrel({
    store,
    modelGateway: { call: async <T>() => ({}) as T },
    toolGateway: createTestToolGateway({}),
    evaluationRuntime: {
      policy: bound.policy,
      calibrationRecord: bound.calibrationRecord,
      executionProfileFingerprint: fingerprintResolvedProfile({
        ...profile,
        evaluationPolicy: bound.policy,
      }),
      evaluatorRegistry: createDefaultRuntimeEvaluatorRegistry(),
      invokeJudge: async () => {
        assert.equal(rejectUnexpectedJudge, false, "Resume unexpectedly invoked evaluation judge.");
        return {
          output: {
            score: 0.2,
            confidence: 0.95,
            assertions: [
              {
                assertionId: "outcome_complete",
                passed: false,
                rationale: "Controlled review acceptance.",
                evidenceRefs: [],
              },
              {
                assertionId: "evidence_consistent",
                passed: false,
                rationale: "Controlled review acceptance.",
                evidenceRefs: [],
              },
              {
                assertionId: "evaluation_integrity",
                passed: true,
                rationale: "Evaluation contract is intact.",
                evidenceRefs: [],
              },
            ],
            rationale: "Require explicit evaluation review.",
            reasonCodes: ["REVIEW_REQUIRED"],
            repairable: false,
          },
          provider: "openai",
          requestedModel: profile.model!,
          observedModelRevision: profile.model!,
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 1,
        };
      },
    },
  });
  kestrel.registerStep("agent.loop", async (context) => ({
    status: "COMPLETED",
    statePatch: {
      agent: completedAgentState(context.session.state, candidate),
    },
  }));
  return kestrel;
}

function completedAgentState(
  state: Record<string, unknown>,
  candidate: string,
): Record<string, unknown> {
  const agent = (state.agent ?? {}) as Record<string, unknown>;
  return {
    ...agent,
    assistantText: candidate,
    finalOutput: { message: candidate },
  };
}

function verifyFirstPartySurfaceClassifications(input: {
  threadId: string;
  sessionId: string;
  waitFor: NonNullable<Awaited<ReturnType<Kestrel["run"]>>["waitFor"]>;
}) {
  const cli = readExactReview(input.waitFor);
  assert.equal(cli.kind, "structured_review");
  assert.equal(cli.reason, "evaluation_review");
  assert.equal(
    resolveExactReviewOptionId(input.waitFor, "1"),
    "evaluation.accept_once",
  );
  assert.equal(
    resolveExactReviewOptionId(input.waitFor, "evaluation.accept_once"),
    "evaluation.accept_once",
  );
  assert.equal(resolveExactReviewOptionId(input.waitFor, "Accept once"), undefined);

  const desktop = getDesktopComposerSubmissionPolicy({
    runActive: false,
    inboxItems: [{
      itemId: `request:${cli.requestId}`,
      kind: "user_input_request",
      threadId: input.threadId,
      sessionId: input.sessionId,
      title: input.waitFor.interaction?.prompt ?? "Evaluation review",
      actionable: true,
      createdAt: new Date().toISOString(),
      requestId: cli.requestId,
      interaction: input.waitFor.interaction,
      metadata: input.waitFor.metadata,
    }],
  });
  assert.equal(desktop.mode, "select_evaluation_option");

  const web = readThreadStructuredReview({
    id: `interaction:${cli.requestId}`,
    requestId: cli.requestId,
    source: "runtime",
    sourceCheckpointId: null,
    kind: "user_input",
    eventType: input.waitFor.eventType,
    prompt: input.waitFor.interaction?.prompt ?? "Evaluation review",
    status: "pending",
    requestEnvelope: structuredClone(input.waitFor.interaction ?? {}),
    responseEnvelope: null,
    responseMessageId: null,
    turnId: null,
    assistantMessageId: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  });
  assert.equal(web.kind, "structured_review");
  return cli;
}

function buildRuntimeEnvironment(
  source: NodeJS.ProcessEnv,
  apiKey: string,
  model: string,
): NodeJS.ProcessEnv {
  return { ...source, OPENAI_API_KEY: apiKey, OPENAI_MODEL: model };
}

function operatorActor() {
  return {
    actorType: "operator" as const,
    actorId: "live-explicit-semantics-operator",
    tenantId: "live-explicit-semantics-tenant",
  };
}

function assertCompleted(
  result: Awaited<ReturnType<KestrelChatRuntime["runTurn"]>> | undefined,
  label: string,
): asserts result is Awaited<ReturnType<KestrelChatRuntime["runTurn"]>> {
  assert.ok(result, `${label} returned no result.`);
  assert.equal(
    result.output.status,
    "COMPLETED",
    `${label} failed: ${JSON.stringify(result.output.errors?.map((error) => ({
      code: error.code,
      message: error.message,
    })))}`,
  );
  assert.ok(result.assistantText?.trim(), `${label} returned no assistant text.`);
}

function isOpenAiRequest(value: string): boolean {
  try {
    const url = new URL(value);
    const configuredBase = new URL(
      process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
    );
    return url.host === configuredBase.host;
  } catch {
    return false;
  }
}

void main().catch((error) => {
  process.stderr.write(
    `[live-structured-review-e2e] failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
