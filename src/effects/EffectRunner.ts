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
  SessionRepository,
} from "../kestrel/contracts/store.js";
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
          toolCallId: effect.idempotencyKey,
          toolName: toolActivity.toolName,
          input: toolActivity.toolInput,
        });
      }
      try {
        const handler = this.registry.resolve(effect.type);
        const output = await handler(effect, {
          ...context,
          session,
        });

        await this.store.saveEffectResult(effect.runId, effect.sessionId, {
          idempotencyKey: effect.idempotencyKey,
          status: "DONE",
          output,
          timestamp: new Date().toISOString(),
        });
        await this.store.markEffectStatus(effect.idempotencyKey, "DONE");
        if (toolActivity !== undefined) {
          await notifyToolActivity(context.onToolActivity, {
            phase: "completed",
            toolCallId: effect.idempotencyKey,
            toolName: toolActivity.toolName,
            input: toolActivity.toolInput,
            output,
            durationMs: Date.now() - startedAt,
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
            toolCallId: effect.idempotencyKey,
            toolName: toolActivity.toolName,
            input: toolActivity.toolInput,
            error: runtimeError,
            durationMs: Date.now() - startedAt,
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
  toolName: string;
  toolInput: Record<string, unknown>;
} | undefined {
  if (effect.type !== "execute_tool_call" && effect.type !== "tool.execute") {
    return ;
  }
  const payload = parseOptionalRecord(effect.payload);
  const toolName = typeof payload?.toolName === "string" && payload.toolName.trim().length > 0
    ? payload.toolName.trim()
    : undefined;
  const toolInput = parseOptionalRecord(payload?.toolInput);
  return toolName === undefined || toolInput === undefined
    ? undefined
    : { toolName, toolInput };
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
