import type { GuardrailConfig } from "../kestrel/contracts/execution.js";
import type { ModelBudgetClass, ModelUsage } from "../kestrel/contracts/model-io.js";


const UNBOUNDED_RUNTIME_BUDGET_MS = Number.MAX_SAFE_INTEGER;

export class GuardrailViolationError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class Guardrails {
  private readonly config: GuardrailConfig;
  private readonly startedAt: number;
  private readonly externalDeadlineMs: number | undefined;
  private readonly stepVisits = new Map<string, number>();
  private stepsExecuted = 0;
  private toolCalls = 0;
  private effectToolCalls = 0;
  private modelCalls = 0;
  private actionModelCalls = 0;
  private maintenanceModelCalls = 0;
  private inputTokens = 0;
  private cachedInputTokens = 0;
  private cacheWriteInputTokens = 0;
  private outputTokens = 0;
  private reasoningTokens = 0;
  private totalTokens = 0;
  private pricedCostUsd = 0;
  private hasPricedCostEvidence = false;
  private validationRejections = 0;

  constructor(
    config: GuardrailConfig,
    initial?: {
      stepsExecuted?: number | undefined;
      toolCalls?: number | undefined;
      modelCalls?: number | undefined;
      actionModelCalls?: number | undefined;
      maintenanceModelCalls?: number | undefined;
    },
    runtimeBudget?: {
      externalDeadlineMs?: number | undefined;
    },
  ) {
    this.config = config;
    this.startedAt = Date.now();
    this.externalDeadlineMs =
      typeof runtimeBudget?.externalDeadlineMs === "number" &&
      Number.isFinite(runtimeBudget.externalDeadlineMs) &&
      runtimeBudget.externalDeadlineMs > 0
        ? Math.trunc(runtimeBudget.externalDeadlineMs)
        : undefined;
    this.stepsExecuted = readNonNegativeInt(initial?.stepsExecuted);
    this.toolCalls = readNonNegativeInt(initial?.toolCalls);
    this.modelCalls = readNonNegativeInt(initial?.modelCalls);
    this.actionModelCalls = readNonNegativeInt(initial?.actionModelCalls ?? initial?.modelCalls);
    this.maintenanceModelCalls = readNonNegativeInt(initial?.maintenanceModelCalls);
  }

  onStep(stepName: string): void {
    this.stepsExecuted += 1;
    if (this.stepsExecuted > this.config.maxStepsPerRun) {
      throw new GuardrailViolationError(
        "MAX_STEPS_EXCEEDED",
        `maxStepsPerRun exceeded (${this.config.maxStepsPerRun})`,
      );
    }

    if (this.config.maxStepVisits !== undefined) {
      const visits = (this.stepVisits.get(stepName) ?? 0) + 1;
      this.stepVisits.set(stepName, visits);
    }

  }

  onToolCall(toolName?: string): void {
    if (isRuntimeInternalTool(toolName)) {
      return;
    }
    this.toolCalls += 1;
    if (this.toolCalls > this.config.maxToolCallsPerRun) {
      throw new GuardrailViolationError(
        "MAX_TOOL_CALLS_EXCEEDED",
        `maxToolCallsPerRun exceeded (${this.config.maxToolCallsPerRun})`,
      );
    }
  }

  onEffectToolCall(toolName?: string): void {
    if (isRuntimeInternalTool(toolName)) {
      return;
    }
    this.effectToolCalls += 1;
    this.onToolCall(toolName);
  }

  onModelCall(budgetClass: ModelBudgetClass = "action"): void {
    if (budgetClass === "maintenance") {
      if (
        this.config.maxMaintenanceModelCallsPerRun !== undefined &&
        this.maintenanceModelCalls >= this.config.maxMaintenanceModelCallsPerRun
      ) {
        throw new GuardrailViolationError(
          "MAX_MAINTENANCE_MODEL_CALLS_EXCEEDED",
          `maxMaintenanceModelCallsPerRun exceeded (${this.config.maxMaintenanceModelCallsPerRun})`,
        );
      }
      this.modelCalls += 1;
      this.maintenanceModelCalls += 1;
      return;
    }
    this.modelCalls += 1;
    this.actionModelCalls += 1;
    if (this.actionModelCalls > this.config.maxModelCallsPerRun) {
      throw new GuardrailViolationError(
        "MAX_MODEL_CALLS_EXCEEDED",
        `maxModelCallsPerRun exceeded (${this.config.maxModelCallsPerRun})`,
      );
    }
  }

  onModelUsage(usage: ModelUsage | undefined): void {
    if (usage === undefined) {
      return;
    }
    if (typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens)) {
      this.inputTokens += usage.inputTokens;
    }
    if (typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens)) {
      this.outputTokens += usage.outputTokens;
    }
    if (typeof usage.cachedInputTokens === "number" && Number.isFinite(usage.cachedInputTokens)) {
      this.cachedInputTokens += usage.cachedInputTokens;
    }
    if (typeof usage.cacheWriteInputTokens === "number" && Number.isFinite(usage.cacheWriteInputTokens)) {
      this.cacheWriteInputTokens += usage.cacheWriteInputTokens;
    }
    if (typeof usage.reasoningTokens === "number" && Number.isFinite(usage.reasoningTokens)) {
      this.reasoningTokens += usage.reasoningTokens;
    }
    if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
      this.totalTokens += usage.totalTokens;
      return;
    }
    this.totalTokens = this.inputTokens + this.outputTokens;
  }

  onModelCost(costUsd: number | undefined): void {
    if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0) {
      this.hasPricedCostEvidence = true;
      this.pricedCostUsd += costUsd;
    }
  }

  onValidationRejection(): void {
    this.validationRejections += 1;
  }

  telemetry(): {
    stepsExecuted: number;
    toolCalls: number;
    effectToolCalls?: number | undefined;
    modelCalls: number;
    actionModelCalls?: number | undefined;
    maintenanceModelCalls?: number | undefined;
    durationMs: number;
    inputTokens?: number | undefined;
    cachedInputTokens?: number | undefined;
    cacheWriteInputTokens?: number | undefined;
    outputTokens?: number | undefined;
    reasoningTokens?: number | undefined;
    totalTokens?: number | undefined;
    pricedCostUsd?: number | undefined;
    validationRejections?: number | undefined;
  } {
    return {
      stepsExecuted: this.stepsExecuted,
      toolCalls: this.toolCalls,
      ...(this.effectToolCalls > 0 ? { effectToolCalls: this.effectToolCalls } : {}),
      modelCalls: this.modelCalls,
      ...(this.maintenanceModelCalls > 0
        ? {
            actionModelCalls: this.actionModelCalls,
            maintenanceModelCalls: this.maintenanceModelCalls,
          }
        : {}),
      durationMs: Date.now() - this.startedAt,
      ...(this.inputTokens > 0 ? { inputTokens: this.inputTokens } : {}),
      ...(this.cachedInputTokens > 0 ? { cachedInputTokens: this.cachedInputTokens } : {}),
      ...(this.cacheWriteInputTokens > 0 ? { cacheWriteInputTokens: this.cacheWriteInputTokens } : {}),
      ...(this.outputTokens > 0 ? { outputTokens: this.outputTokens } : {}),
      ...(this.reasoningTokens > 0 ? { reasoningTokens: this.reasoningTokens } : {}),
      ...(this.totalTokens > 0 ? { totalTokens: this.totalTokens } : {}),
      ...(this.hasPricedCostEvidence ? { pricedCostUsd: this.pricedCostUsd } : {}),
      ...(this.validationRejections > 0 ? { validationRejections: this.validationRejections } : {}),
    };
  }

  budgetSnapshot(): {
    remainingMs: number;
    tokensUsed: number;
    toolCallsUsed: number;
  } {
    const remainingMs =
      this.externalDeadlineMs !== undefined
        ? Math.max(0, this.externalDeadlineMs - Date.now())
        : UNBOUNDED_RUNTIME_BUDGET_MS;
    return {
      remainingMs,
      tokensUsed: this.totalTokens,
      toolCallsUsed: this.toolCalls,
      ...(this.inputTokens > 0 ? { inputTokens: this.inputTokens } : {}),
      ...(this.outputTokens > 0 ? { outputTokens: this.outputTokens } : {}),
    };
  }

  thrashIndex(): number {
    // Compatibility metric: this is state-machine step recurrence, not semantic agent thrash.
    // Do not use it to infer repeated intent or to trigger recovery policy.
    if (this.stepsExecuted === 0) {
      return 0;
    }

    const uniqueSteps = this.stepVisits.size;
    if (uniqueSteps === 0) {
      return 0;
    }

    return Number(((this.stepsExecuted - uniqueSteps) / this.stepsExecuted).toFixed(4));
  }

  configSnapshot(): {
    maxStepsPerRun: number;
  } {
    return {
      maxStepsPerRun: this.config.maxStepsPerRun,
    };
  }
}

function isRuntimeInternalTool(toolName: string | undefined): boolean {
  return toolName === "FinalizeAnswer" ||
    toolName === "effect_result_lookup" ||
    toolName?.startsWith("planning.") === true;
}

function readNonNegativeInt(value: number | undefined): number {
  if (typeof value !== "number" || Number.isFinite(value) === false) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}
