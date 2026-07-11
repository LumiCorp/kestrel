import type {
  PersistedEffect,
  SessionRecord,
} from "../kestrel/contracts/store.js";
import {
  createEffectLookupError,
  createEffectRegistrationError,
} from "./errors.js";

export interface EffectExecutionContext {
  runId: string;
  sessionId: string;
  stepIndex: number;
  runtimeBudgetRemainingMs?: number | undefined;
  signal?: AbortSignal | undefined;
  session?: SessionRecord | null | undefined;
}

export type EffectHandler = (
  effect: PersistedEffect,
  context: EffectExecutionContext,
) => Promise<unknown>;

export class EffectRegistry {
  private readonly handlers = new Map<string, EffectHandler>();

  register(type: string, handler: EffectHandler): void {
    if (type.trim().length === 0) {
      throw createEffectRegistrationError(
        "EFFECT_REGISTRATION_INVALID",
        "Effect type cannot be empty.",
        { contractPath: "effect.type" },
      );
    }
    if (this.handlers.has(type)) {
      throw createEffectRegistrationError(
        "EFFECT_REGISTRATION_DUPLICATE",
        `Effect handler already registered for '${type}'.`,
        { effectType: type },
      );
    }
    this.handlers.set(type, handler);
  }

  resolve(type: string): EffectHandler {
    const handler = this.handlers.get(type);
    if (handler === undefined) {
      throw createEffectLookupError(type);
    }

    return handler;
  }
}
