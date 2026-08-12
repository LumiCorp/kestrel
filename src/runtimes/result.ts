import type { NormalizedOutput } from "../kestrel/contracts/execution.js";
import type { RuntimeTurnResult } from "../runtime/RuntimeTurn.js";

const EMPTY_QUALITY = {
  citationCoverage: 0,
  unresolvedClaims: 0,
  reworkRate: 0,
  thrashIndex: 0,
} as const;

export function createRuntimeResult(input: {
  sessionId: string;
  runId: string;
  status: NormalizedOutput["status"];
  assistantText?: string | null | undefined;
  durationMs: number;
  toolCalls?: number | undefined;
  modelCalls?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  waitFor?: NormalizedOutput["waitFor"] | undefined;
  error?: { code: string; message: string } | undefined;
}): RuntimeTurnResult {
  return {
    assistantText: input.assistantText ?? null,
    output: {
      status: input.status,
      sessionId: input.sessionId,
      runId: input.runId,
      quality: EMPTY_QUALITY,
      errors: input.error === undefined ? [] : [input.error],
      telemetry: {
        stepsExecuted: 1,
        toolCalls: input.toolCalls ?? 0,
        modelCalls: input.modelCalls ?? 1,
        durationMs: input.durationMs,
        ...(input.inputTokens !== undefined
          ? { inputTokens: input.inputTokens }
          : {}),
        ...(input.outputTokens !== undefined
          ? { outputTokens: input.outputTokens }
          : {}),
        ...(input.inputTokens !== undefined && input.outputTokens !== undefined
          ? { totalTokens: input.inputTokens + input.outputTokens }
          : {}),
      },
      ...(input.waitFor !== undefined ? { waitFor: input.waitFor } : {}),
    },
  };
}
