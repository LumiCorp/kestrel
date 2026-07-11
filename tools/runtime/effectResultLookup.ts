import type { SharedToolModule } from "../contracts.js";
import { parseObjectInput, requireStringField } from "../helpers.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";

export const effectResultLookupTool: SharedToolModule = {
  definition: {
    name: "effect_result_lookup",
    description: "Lookup persisted effect result by idempotency key.",
    inputSchema: {
      type: "object",
      properties: {
        idempotencyKey: { type: "string" },
      },
      required: ["idempotencyKey"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "runtime",
      latencyClass: "low",
      costClass: "free",
      executionClass: "sandboxed_only",
      capabilityClasses: ["runtime.effect_lookup"],
    },
    presentation: {
      displayName: "Effect Result Lookup",
      aliases: ["effect result lookup", "effect lookup", "idempotency lookup"],
      keywords: ["effect", "idempotency", "runtime", "lookup"],
      provider: "kestrel",
      toolFamily: "runtime",
    },
  },
  createHandler(context) {
    if (context.store === undefined) {
      throw createRuntimeFailure(
        "TOOL_CONTEXT_INVALID",
        "effect_result_lookup requires tool context.store.",
        {
          subsystem: "tooling",
          toolName: "effect_result_lookup",
          classification: "configuration",
          recoverable: false,
        },
      );
    }

    return async (input: unknown) => {
      const body = parseObjectInput("effect_result_lookup", input);
      const idempotencyKey = requireStringField("effect_result_lookup", body, "idempotencyKey");

      return context.store?.getEffectResult(idempotencyKey) ?? null;
    };
  },
};
