import type { SharedToolModule } from "../contracts.js";
import { createToolInputError, parseObjectInput } from "../helpers.js";
import { buildAgentToolSuccessResult } from "../toolResult.js";

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

      const output = context.onFinalize !== undefined
        ? await context.onFinalize(input)
        : { finalized: true, payload: input };
      return buildAgentToolSuccessResult({
        toolName: "FinalizeAnswer",
        input,
        output,
        presentation: readFinalizePresentation(input),
      });
    };
  },
};

function readFinalizePresentation(input: unknown) {
  const root = asRecord(input);
  const data = asRecord(root?.data);
  const ui = asRecord(data?.ui);
  const artifacts = Array.isArray(ui?.artifacts) ? ui.artifacts : [];
  return {
    artifacts: artifacts.flatMap((value) => {
      const artifact = asRecord(value);
      const id = readNonEmptyString(artifact?.id);
      const title = readNonEmptyString(artifact?.title);
      const kind = readNonEmptyString(artifact?.kind);
      if (artifact === undefined || !(id && title && kind)) return [];
      const metadata = readArtifactMetadata(artifact);
      return [{
        id,
        title,
        kind,
        ...(readNonEmptyString(artifact?.url)
          ? { url: readNonEmptyString(artifact?.url) }
          : {}),
        ...(readNonEmptyString(artifact?.mediaType)
          ? { mediaType: readNonEmptyString(artifact?.mediaType) }
          : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      }];
    }),
  };
}

function readArtifactMetadata(
  artifact: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const metadata = { ...(asRecord(artifact.metadata) ?? {}) };
  for (const field of ["status", "stdout", "stderr", "text", "chunk", "chunkPreview"] as const) {
    if (typeof artifact[field] === "string") {
      metadata[field] = artifact[field];
    }
  }
  for (const field of ["exitCode", "durationMs"] as const) {
    const value = artifact[field];
    if (value === null || (typeof value === "number" && Number.isFinite(value))) {
      metadata[field] = value;
    }
  }
  if (typeof artifact.truncated === "boolean") {
    metadata.truncated = artifact.truncated;
  }
  for (const field of ["toolContext", "source"] as const) {
    const value = asRecord(artifact[field]);
    if (value !== undefined) {
      metadata[field] = value;
    }
  }
  if (Array.isArray(artifact.sources)) {
    metadata.sources = artifact.sources;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

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
          return ;
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
