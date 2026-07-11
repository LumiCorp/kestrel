import type { SharedToolModule } from "../contracts.js";
import { createToolInputError, parseObjectInput } from "../helpers.js";

export const finalizeAnswerTool: SharedToolModule = {
  definition: {
    name: "FinalizeAnswer",
    description: "Finalize an agent turn with a caller-facing payload. For code changes, success means the main requested outcome passed after the final edit and every explicit task constraint was checked; include what passed, or report that validation failed or could not be run. On web clients, optional data.ui.blocks, data.ui.controls, and data.ui.artifacts may enrich the final answer; live tool activity is rendered by the runtime and does not need to be restated here.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
    },
    capability: {
      freshnessClass: "runtime",
      latencyClass: "low",
      costClass: "free",
      executionClass: "sandboxed_only",
      capabilityClasses: ["runtime.finalize"],
    },
    presentation: {
      displayName: "Finalize Answer",
      aliases: ["finalize answer", "finalize", "finish response"],
      keywords: ["finalize", "answer", "response", "runtime"],
      provider: "kestrel",
      toolFamily: "runtime",
    },
  },
  createHandler(context) {
    return async (input: unknown) => {
      if (context.strictFinalizeProvenance === true) {
        assertFinalizeProvenance(input);
      }

      if (context.onFinalize !== undefined) {
        return context.onFinalize(input);
      }

      return {
        finalized: true,
        payload: input,
      };
    };
  },
};

function assertFinalizeProvenance(input: unknown): void {
  const record = parseObjectInput("FinalizeAnswer", input);
  const data =
    typeof record.data === "object" && record.data !== null && Array.isArray(record.data) === false
      ? (record.data as Record<string, unknown>)
      : undefined;
  if (data === undefined) {
    return;
  }

  const claims = Array.isArray(data.claims) ? data.claims : [];
  if (claims.length === 0) {
    return;
  }

  const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
  const artifactIds = new Set(
    artifacts
      .map((value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return undefined;
        }
        const artifact = value as Record<string, unknown>;
        return typeof artifact.id === "string" ? artifact.id : undefined;
      })
      .filter((value): value is string => value !== undefined),
  );

  for (const value of claims) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw createToolInputError("FinalizeAnswer", "Each claim must be an object in strict provenance mode.");
    }

    const claim = value as Record<string, unknown>;
    const text = typeof claim.text === "string" ? claim.text : "";
    if (text.trim().length === 0) {
      throw createToolInputError("FinalizeAnswer", "claim.text is required in strict provenance mode.", {
        field: "data.claims[].text",
      });
    }

    const evidenceIds = Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [];
    if (evidenceIds.length === 0) {
      throw createToolInputError("FinalizeAnswer", "claim.evidenceIds is required in strict provenance mode.", {
        field: "data.claims[].evidenceIds",
      });
    }

    for (const evidenceId of evidenceIds) {
      if (typeof evidenceId !== "string" || evidenceId.trim().length === 0) {
        throw createToolInputError("FinalizeAnswer", "evidenceIds must be non-empty strings in strict provenance mode.", {
          field: "data.claims[].evidenceIds[]",
        });
      }
      if (artifactIds.size > 0 && artifactIds.has(evidenceId) === false) {
        throw createToolInputError(
          "FinalizeAnswer",
          `Missing evidence artifact '${evidenceId}' in strict provenance mode.`,
          {
            evidenceId,
          },
        );
      }
    }
  }
}
