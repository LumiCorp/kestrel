import type {
  RuntimeError,
  TransitionStatus,
} from "../kestrel/contracts/base.js";
import type {
  EffectRunner,
} from "../kestrel/contracts/execution.js";
import type {
  PersistedEffect,
  EffectStore,
  SandboxCapabilityLeaseStore,
  SessionRepository,
} from "../kestrel/contracts/store.js";
import {
  parseAgentToolResultV2,
  parsePreparedToolCallV1,
} from "../kestrel/contracts/tool-invocation.js";
import type { ToolActivationRefV1 } from "../kestrel/contracts/tool-contract.js";
import type { EffectRegistry } from "./EffectRegistry.js";
import { createEffectExecutionError } from "./errors.js";

export class InlineEffectRunner implements EffectRunner {
  private readonly store: SessionRepository & EffectStore;
  private readonly registry: EffectRegistry;

  constructor(store: SessionRepository & EffectStore, registry: EffectRegistry) {
    this.store = store;
    this.registry = registry;
  }

  async runEffects(
    effects: PersistedEffect[],
    context: {
      runId: string;
      sessionId: string;
      stepIndex: number;
      runtimeBudgetRemainingMs?: number | undefined;
      signal?: AbortSignal | undefined;
      onToolActivity?: ((activity: {
        phase: "started" | "completed" | "failed";
        toolCallId: string;
        toolName: string;
        input?: unknown;
        output?: unknown;
        error?: RuntimeError | undefined;
        durationMs?: number | undefined;
      }) => Promise<void>) | undefined;
    },
  ): Promise<{ stop: boolean; terminalStatus?: TransitionStatus; errors: RuntimeError[] }> {
    const errors: RuntimeError[] = [];

    for (const effect of effects) {
      const session = await this.store.getSession(context.sessionId);
      const existingResult = await this.store.getEffectResult(effect.idempotencyKey);
      if (existingResult !== null) {
        if (existingResult.status === "DONE") {
          await this.store.markEffectStatus(effect.idempotencyKey, "DONE");
          continue;
        }

        await this.store.markEffectStatus(effect.idempotencyKey, "FAILED");
        if (existingResult.error !== undefined) {
          errors.push(existingResult.error);
        }

        if (effect.failurePolicy === "CONTINUE") {
          continue;
        }

        return {
          stop: true,
          terminalStatus: effect.failurePolicy === "WAIT" ? "WAITING" : "FAILED",
          errors,
        };
      }

      const toolActivity = readEffectToolActivity(effect);
      const startedAt = Date.now();
      if (toolActivity !== undefined) {
        await notifyToolActivity(context.onToolActivity, {
          phase: "started",
          toolCallId: toolActivity.toolCallId,
          toolName: toolActivity.toolName,
          input: toolActivity.toolInput,
          ...(toolActivity.activation === undefined
            ? {}
            : { activation: toolActivity.activation }),
        });
      }
      try {
        const handler = this.registry.resolve(effect.type);
        const output = await handler(effect, {
          ...context,
          session,
        });

        const completedEffectResult = {
          idempotencyKey: effect.idempotencyKey,
          status: "DONE" as const,
          output,
          timestamp: new Date().toISOString(),
        };
        const capabilityReplay = readSandboxCapabilityReplayEvidence(output);
        if (capabilityReplay === undefined) {
          await this.store.saveEffectResult(effect.runId, effect.sessionId, completedEffectResult);
        } else {
          const capabilityStore = this.store as typeof this.store & Partial<SandboxCapabilityLeaseStore>;
          if (capabilityStore.saveSandboxCapabilityEffectResult === undefined) {
            throw new Error("Durable sandbox capability effect-result persistence is unavailable");
          }
          if (capabilityReplay.toolCallId !== effect.idempotencyKey) {
            throw new Error("Sandbox capability replay evidence does not match the exact effect action");
          }
          await capabilityStore.saveSandboxCapabilityEffectResult({
            leaseId: capabilityReplay.leaseId,
            bindingDigest: capabilityReplay.bindingDigest,
            toolCallId: capabilityReplay.toolCallId,
            runId: effect.runId,
            sessionId: effect.sessionId,
            result: completedEffectResult,
          });
        }
        await this.store.markEffectStatus(effect.idempotencyKey, "DONE");
        if (toolActivity !== undefined) {
          const evidence = readAgentToolResultV2(output);
          await notifyToolActivity(context.onToolActivity, {
            phase: "completed",
            toolCallId: toolActivity.toolCallId,
            toolName: toolActivity.toolName,
            input: toolActivity.toolInput,
            output,
            durationMs: Date.now() - startedAt,
            ...(evidence === undefined
              ? toolActivity.activation === undefined
                ? {}
                : { activation: toolActivity.activation }
              : {
                  activation: evidence.activation,
                  outcome: evidence.outcome,
                }),
          });
        }
      } catch (error) {
        const runtimeError: RuntimeError = createEffectExecutionError(
          effect.type,
          effect.idempotencyKey,
          error,
        );
        errors.push(runtimeError);

        await this.store.saveEffectResult(effect.runId, effect.sessionId, {
          idempotencyKey: effect.idempotencyKey,
          status: "FAILED",
          error: runtimeError,
          timestamp: new Date().toISOString(),
        });
        await this.store.markEffectStatus(effect.idempotencyKey, "FAILED");
        if (toolActivity !== undefined) {
          await notifyToolActivity(context.onToolActivity, {
            phase: "failed",
            toolCallId: toolActivity.toolCallId,
            toolName: toolActivity.toolName,
            input: toolActivity.toolInput,
            error: runtimeError,
            durationMs: Date.now() - startedAt,
            ...(toolActivity.activation === undefined
              ? {}
              : {
                  activation: toolActivity.activation,
                  outcome: {
                    version: "v1" as const,
                    callId: toolActivity.toolCallId,
                    activation: toolActivity.activation,
                    kind: "failure" as const,
                    startedAt: new Date(startedAt).toISOString(),
                    completedAt: new Date().toISOString(),
                    effectState: "unknown" as const,
                    normalizedFailureCode: runtimeError.code,
                    retryable: false,
                    error: {
                      message: runtimeError.message,
                      ...(runtimeError.details === undefined
                        ? {}
                        : { details: runtimeError.details }),
                    },
                  },
                }),
          });
        }

        if (effect.failurePolicy === "CONTINUE") {
          continue;
        }

        if (effect.failurePolicy === "WAIT") {
          return {
            stop: true,
            terminalStatus: "WAITING",
            errors,
          };
        }

        return {
          stop: true,
          terminalStatus: "FAILED",
          errors,
        };
      }
    }

    return {
      stop: false,
      errors,
    };
  }
}

function readEffectToolActivity(effect: PersistedEffect): {
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  activation?: ToolActivationRefV1 | undefined;
} | undefined {
  if (effect.type !== "execute_tool_call" && effect.type !== "tool.execute") {
    return ;
  }
  const payload = parseOptionalRecord(effect.payload);
  if (payload?.preparedToolCall === undefined) {
    const toolName = typeof payload?.toolName === "string" && payload.toolName.trim().length > 0
      ? payload.toolName.trim()
      : undefined;
    const toolInput = parseOptionalRecord(payload?.toolInput);
    return toolName === undefined || toolInput === undefined
      ? undefined
      : { toolCallId: effect.idempotencyKey, toolName, toolInput };
  }
  try {
    const prepared = parsePreparedToolCallV1(payload.preparedToolCall);
    return {
      toolCallId: prepared.callId,
      toolName: prepared.activation.descriptor.toolId,
      toolInput: prepared.effectiveInput,
      activation: prepared.activation,
    };
  } catch {
    return;
  }
}

function readAgentToolResultV2(value: unknown) {
  try {
    return parseAgentToolResultV2(value);
  } catch {
    return undefined;
  }
}

function readSandboxCapabilityReplayEvidence(value: unknown): {
  leaseId: string;
  bindingDigest: string;
  toolCallId: string;
} | undefined {
  const result = readAgentToolResultV2(value);
  if (result === undefined || (result.outcome.kind !== "success" && result.outcome.kind !== "partial")) return;
  const rawOutput = result.outcome.rawOutput;
  if (typeof rawOutput !== "object" || rawOutput === null || Array.isArray(rawOutput)) return;
  const evidence = (rawOutput as Record<string, unknown>).capabilityReplayEvidence;
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return;
  const record = evidence as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.leaseId !== "string" || record.leaseId.length === 0 ||
    typeof record.bindingDigest !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(record.bindingDigest) ||
    typeof record.toolCallId !== "string" || record.toolCallId.length === 0
  ) return;
  return {
    leaseId: record.leaseId,
    bindingDigest: record.bindingDigest,
    toolCallId: record.toolCallId,
  };
}

async function notifyToolActivity(
  observer: Parameters<EffectRunner["runEffects"]>[1]["onToolActivity"],
  activity: Parameters<NonNullable<Parameters<EffectRunner["runEffects"]>[1]["onToolActivity"]>>[0],
): Promise<void> {
  if (observer === undefined) {
    return;
  }
  await observer(activity).catch(() => {});
}

function parseOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}
