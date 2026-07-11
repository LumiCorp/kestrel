import type { PersistedEffect } from "../../kestrel/contracts/store.js";
import type { EffectExecutionContext } from "../EffectRegistry.js";

export async function testNoopHandler(
  effect: PersistedEffect,
  context: EffectExecutionContext,
): Promise<Record<string, unknown>> {
  return {
    noop: true,
    stepIndex: context.stepIndex,
    idempotencyKey: effect.idempotencyKey,
  };
}
