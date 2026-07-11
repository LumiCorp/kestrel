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
import { EffectRegistry } from "./EffectRegistry.js";
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
