import {
  COMPLETION_EVIDENCE_EVALUATOR_ID,
  COMPLETION_EVIDENCE_EVALUATOR_VERSION,
  LEAN_RUNTIME_EVALUATION_BUDGET_V1,
  RUNTIME_EVALUATION_VERDICT_VERSION,
  parseRuntimeEvaluationRequestV1,
  parseRuntimeEvaluationVerdictV1,
  type RuntimeEvaluationAssertionV1,
  type RuntimeEvaluationRequestV1,
} from "../kestrel/contracts/evaluation.js";
import {
  COMPLETION_EVIDENCE_ASSERTIONS_V1,
  COMPLETION_EVIDENCE_ASSET_BUNDLE_V1,
  COMPLETION_EVIDENCE_OUTPUT_SCHEMA_V1,
  COMPLETION_EVIDENCE_PROMPT_V1,
  COMPLETION_EVIDENCE_RUBRIC_V1,
} from "./assets.js";
import type {
  RuntimeEvaluator,
  RuntimeEvaluatorContextV1,
} from "./RuntimeEvaluatorRegistry.js";
import {
  RuntimeEvaluationFailure,
  RuntimeEvaluatorRegistry,
} from "./RuntimeEvaluatorRegistry.js";

export class CompletionEvidenceEvaluator implements RuntimeEvaluator {
  readonly evaluatorId = COMPLETION_EVIDENCE_EVALUATOR_ID;
  readonly evaluatorVersion = COMPLETION_EVIDENCE_EVALUATOR_VERSION;

  async evaluate(
    input: Parameters<RuntimeEvaluator["evaluate"]>[0],
    context: RuntimeEvaluatorContextV1,
  ) {
    const request = parseRuntimeEvaluationRequestV1(input);
    if (
      request.evaluator.evaluatorId !== this.evaluatorId ||
      request.evaluator.evaluatorVersion !== this.evaluatorVersion ||
      request.assets.revision !== COMPLETION_EVIDENCE_ASSET_BUNDLE_V1.revision
    ) {
      throw new Error(
        "Completion-evidence evaluator request identity is stale.",
      );
    }
    const providerOptions = evaluationProviderOptions(request.judge.provider);
    const result = await context.invokeJudge({
      model: request.judge.model,
      input: {
        rubric: COMPLETION_EVIDENCE_RUBRIC_V1,
        projection: request.projection,
      },
      messages: [
        { role: "system", content: COMPLETION_EVIDENCE_PROMPT_V1 },
        {
          role: "user",
          content: JSON.stringify({
            rubric: COMPLETION_EVIDENCE_RUBRIC_V1,
            projection: request.projection,
          }),
        },
      ],
      tools: [],
      responseSchema: COMPLETION_EVIDENCE_OUTPUT_SCHEMA_V1 as unknown as Record<
        string,
        unknown
      >,
      responseFormat: "json",
      ...(providerOptions !== undefined ? { providerOptions } : {}),
      reasoning: { mode: "off" },
      metadata: {
        purpose: "runtime_evaluation",
        evaluationRequestId: request.requestId,
        evaluationAssetRevision: request.assets.revision,
      },
    });
    if (
      result.provider !== request.judge.provider ||
      result.requestedModel !== request.judge.model
    ) {
      throw new Error(
        "Completion-evidence judge route does not match the pinned request route.",
      );
    }
    const output = requireRecord(
      result.output,
      "Completion-evidence judge output",
    );
    const assertions = parseJudgeAssertions(output.assertions);
    const usage = {
      inputTokens: nonNegativeInteger(result.usage.inputTokens),
      outputTokens: nonNegativeInteger(result.usage.outputTokens),
    };
    const totalTokens = usage.inputTokens + usage.outputTokens;
    const costUsd = calculateCostUsd(usage, request);
    if (
      usage.inputTokens >
        LEAN_RUNTIME_EVALUATION_BUDGET_V1.maxInputTokensPerEvaluation ||
      usage.outputTokens >
        LEAN_RUNTIME_EVALUATION_BUDGET_V1.maxOutputTokensPerEvaluation ||
      request.budget.totalTokensUsed + totalTokens >
        LEAN_RUNTIME_EVALUATION_BUDGET_V1.maxTotalTokens ||
      request.budget.totalCostUsd + costUsd >
        LEAN_RUNTIME_EVALUATION_BUDGET_V1.maxTotalCostUsd
    ) {
      throw new RuntimeEvaluationFailure(
        "EVALUATION_BUDGET_EXCEEDED",
        "Completion-evidence evaluation exceeded its exact token or spend budget.",
      );
    }
    if (result.latencyMs > LEAN_RUNTIME_EVALUATION_BUDGET_V1.timeoutMs) {
      throw new RuntimeEvaluationFailure(
        "EVALUATION_TIMEOUT",
        "Completion-evidence evaluation exceeded its exact latency budget.",
      );
    }
    return parseRuntimeEvaluationVerdictV1({
      version: RUNTIME_EVALUATION_VERDICT_VERSION,
      verdictId: `evaluation-verdict:${request.requestId}`,
      requestId: request.requestId,
      evaluator: request.evaluator,
      judge: {
        provider: result.provider,
        requestedModel: result.requestedModel,
        observedModelRevision: result.observedModelRevision,
        routeIndependence: "shared_primary_route",
      },
      score: output.score,
      confidence: output.confidence,
      assertions,
      rationale: output.rationale,
      reasonCodes: output.reasonCodes,
      repairable: output.repairable,
      usage: {
        ...usage,
        totalTokens,
        costUsd,
      },
      latencyMs: result.latencyMs,
      createdAt: new Date().toISOString(),
    });
  }
}

function evaluationProviderOptions(
  provider: RuntimeEvaluationRequestV1["judge"]["provider"],
) {
  const maxTokens = 500;
  if (provider === "openai") return { openai: { maxTokens } };
  if (provider === "openrouter") return { openrouter: { maxTokens } };
  if (provider === "anthropic") return { anthropic: { maxTokens } };
  return undefined;
}

export function createDefaultRuntimeEvaluatorRegistry(): RuntimeEvaluatorRegistry {
  const registry = new RuntimeEvaluatorRegistry();
  registry.register(new CompletionEvidenceEvaluator());
  return registry;
}

function parseJudgeAssertions(value: unknown): RuntimeEvaluationAssertionV1[] {
  if (!Array.isArray(value))
    throw new Error("Completion-evidence judge assertions must be an array.");
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of value) {
    const record = requireRecord(item, "Completion-evidence judge assertion");
    if (
      typeof record.assertionId !== "string" ||
      byId.has(record.assertionId)
    ) {
      throw new Error(
        "Completion-evidence judge assertion identity is invalid or duplicated.",
      );
    }
    byId.set(record.assertionId, record);
  }
  return COMPLETION_EVIDENCE_ASSERTIONS_V1.map((definition) => {
    const record = byId.get(definition.assertionId);
    if (
      record === undefined ||
      byId.size !== COMPLETION_EVIDENCE_ASSERTIONS_V1.length
    ) {
      throw new Error(
        "Completion-evidence judge assertions do not match the pinned assertion set.",
      );
    }
    return {
      assertionId: definition.assertionId,
      required: definition.required,
      passed: record.passed,
      rationale: record.rationale,
      evidenceRefs: record.evidenceRefs,
    } as RuntimeEvaluationAssertionV1;
  });
}

function calculateCostUsd(
  usage: { inputTokens: number; outputTokens: number },
  request: Parameters<RuntimeEvaluator["evaluate"]>[0],
): number {
  return (
    (usage.inputTokens * request.judge.pricing.inputUsdPerMillionTokens +
      usage.outputTokens * request.judge.pricing.outputUsdPerMillionTokens) /
    1_000_000
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
