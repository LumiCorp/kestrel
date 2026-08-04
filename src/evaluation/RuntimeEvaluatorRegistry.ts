import type {
  RuntimeEvaluationRequestV1,
  RuntimeEvaluationVerdictV1,
} from "../kestrel/contracts/evaluation.js";
import type {
  ModelRequest,
  ModelUsage,
} from "../kestrel/contracts/model-io.js";

export interface RuntimeEvaluationJudgeResultV1 {
  output: unknown;
  provider: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio";
  requestedModel: string;
  observedModelRevision: string;
  usage: ModelUsage;
  latencyMs: number;
}

export interface RuntimeEvaluatorContextV1 {
  signal: AbortSignal;
  invokeJudge(request: ModelRequest): Promise<RuntimeEvaluationJudgeResultV1>;
}

export interface RuntimeEvaluator {
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  evaluate(
    request: RuntimeEvaluationRequestV1,
    context: RuntimeEvaluatorContextV1,
  ): Promise<RuntimeEvaluationVerdictV1>;
}

export class RuntimeEvaluatorRegistry {
  private readonly evaluators = new Map<string, RuntimeEvaluator>();

  register(evaluator: RuntimeEvaluator): void {
    const key = registrationKey(
      evaluator.evaluatorId,
      evaluator.evaluatorVersion,
    );
    if (this.evaluators.has(key)) {
      throw new Error(
        `Runtime evaluator '${evaluator.evaluatorId}@${evaluator.evaluatorVersion}' is already registered.`,
      );
    }
    this.evaluators.set(key, evaluator);
  }

  resolve(input: {
    evaluatorId: string;
    evaluatorVersion: string;
  }): RuntimeEvaluator | undefined {
    return this.evaluators.get(
      registrationKey(input.evaluatorId, input.evaluatorVersion),
    );
  }

  require(input: {
    evaluatorId: string;
    evaluatorVersion: string;
  }): RuntimeEvaluator {
    const evaluator = this.resolve(input);
    if (evaluator === undefined) {
      throw new Error(
        `Runtime evaluator '${input.evaluatorId}@${input.evaluatorVersion}' is not registered.`,
      );
    }
    return evaluator;
  }

  list(): RuntimeEvaluator[] {
    return [...this.evaluators.values()];
  }
}

function registrationKey(
  evaluatorId: string,
  evaluatorVersion: string,
): string {
  const exactId = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u;
  if (
    evaluatorId.trim() !== evaluatorId ||
    evaluatorVersion.trim() !== evaluatorVersion ||
    exactId.test(evaluatorId) === false ||
    exactId.test(evaluatorVersion) === false ||
    /[*?\[\]{}()]/u.test(evaluatorId) ||
    /[*?\[\]{}()]/u.test(evaluatorVersion)
  ) {
    throw new Error(
      "Runtime evaluator identity must use exact identifiers without patterns.",
    );
  }
  return `${evaluatorId}\0${evaluatorVersion}`;
}
