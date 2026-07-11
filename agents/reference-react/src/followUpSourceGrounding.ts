import { createHash } from "node:crypto";

import { asArray, asRecord, asString } from "../../shared/valueAccess.js";
import {
  allowlistedCandidateNames,
  buildToolIntentContext,
  buildCandidateViews,
  resolveExecutionIntentToolName,
} from "./toolIntent.js";
import type {
  DecisionContextExecutionIntent,
  DecisionContextIntentMetadata,
  DecisionContextToolIntent,
  FollowUpGroundingSummary,
  PriorSourceCandidate,
  ToolExecutionClass,
} from "./types.js";

interface GroundingInput {
  userMessage: string | undefined;
  toolIntent?: DecisionContextToolIntent | undefined;
  executionIntent?: DecisionContextExecutionIntent | undefined;
  intentMetadata?: DecisionContextIntentMetadata | undefined;
  priorSources: PriorSourceCandidate[];
  capabilityManifest: GroundingCapabilityManifestItem[];
}

interface GroundingResult {
  toolIntent?: DecisionContextToolIntent | undefined;
  executionIntent: DecisionContextExecutionIntent | undefined;
  grounding: FollowUpGroundingSummary | undefined;
}

interface GroundingCapabilityManifestItem {
  name: string;
  description?: string | undefined;
  freshnessClass?: string | undefined;
  latencyClass?: string | undefined;
  costClass?: string | undefined;
  capabilityClasses?: string[] | undefined;
  executionClass?: ToolExecutionClass | undefined;
}

export function collectPriorSources(input: {
  reactState: Record<string, unknown>;
  toolOutcomeCache: Array<{ toolName?: string; output?: unknown; stepIndex?: number; updatedAt?: string }>;
}): PriorSourceCandidate[] {
  const candidates: PriorSourceCandidate[] = [];
  const lastAction = asRecord(input.reactState.lastActionResult);
  const evidenceRecoverySummary = asRecord(asRecord(input.reactState.postToolVerification)?.evidenceRecoverySummary);

  candidates.push(...readRetainedSourceCandidates(evidenceRecoverySummary));

  if (asString(lastAction?.kind) === "tool") {
    const toolName = asString(lastAction?.name);
    if (toolName !== undefined) {
      candidates.push(
        ...readToolSources({
          toolName,
          output: lastAction?.output,
          stepIndex: readNumber(lastAction?.stepIndex),
        }),
      );
    }
  }

  if (asString(lastAction?.kind) === "tool_batch") {
    for (const item of asArray(lastAction?.items)) {
      const record = asRecord(item);
      const toolName = asString(record?.name);
      if (toolName === undefined) {
        continue;
      }
      candidates.push(
        ...readToolSources({
          toolName,
          output: record?.output,
          stepIndex: readNumber(record?.stepIndex),
        }),
      );
    }
  }

  for (const entry of input.toolOutcomeCache) {
    if (entry.toolName === undefined) {
      continue;
    }
    candidates.push(
      ...readToolSources({
        toolName: entry.toolName,
        output: entry.output,
        stepIndex: entry.stepIndex,
        updatedAt: entry.updatedAt,
      }),
    );
  }

  const deduped: PriorSourceCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.url.trim();
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

export function applyFollowUpSourceGrounding(input: GroundingInput): GroundingResult {
  const effectiveExecutionIntent =
    input.executionIntent ??
    (input.toolIntent === undefined
      ? undefined
      : {
          objective: input.toolIntent.objective,
          candidateTools: input.toolIntent.candidateTools.map((candidate) =>
            typeof candidate === "string" ? candidate : candidate.name
          ),
          ...(input.toolIntent.operationIntent !== undefined
            ? { operationIntent: input.toolIntent.operationIntent }
            : {}),
          ...(input.toolIntent.inputHints !== undefined ? { inputHints: input.toolIntent.inputHints } : {}),
          ...(input.toolIntent.command !== undefined ? { command: input.toolIntent.command } : {}),
          ...(input.toolIntent.commandMode !== undefined ? { commandMode: input.toolIntent.commandMode } : {}),
          ...(input.toolIntent.clarification !== undefined ? { clarification: input.toolIntent.clarification } : {}),
        });
  const effectiveIntentMetadata =
    input.intentMetadata ??
    (input.toolIntent === undefined
      ? undefined
      : {
          ...(input.toolIntent.workflowIntent !== undefined
            ? { workflowIntent: input.toolIntent.workflowIntent }
            : {}),
          ...(input.toolIntent.repoScope !== undefined ? { repoScope: input.toolIntent.repoScope } : {}),
          ...(input.toolIntent.verificationIntent !== undefined
            ? { verificationIntent: input.toolIntent.verificationIntent }
            : {}),
          ...(input.toolIntent.workspaceTargets !== undefined
            ? { workspaceTargets: input.toolIntent.workspaceTargets }
            : {}),
          ...(input.toolIntent.hostWorkflowKind !== undefined
            ? { hostWorkflowKind: input.toolIntent.hostWorkflowKind }
            : {}),
          ...(input.toolIntent.executionPreference !== undefined
            ? { executionPreference: input.toolIntent.executionPreference }
            : {}),
          ...(input.toolIntent.followUpSourceSelection !== undefined
            ? { followUpSourceSelection: input.toolIntent.followUpSourceSelection }
            : {}),
          ...(input.toolIntent.toolUseIntent !== undefined
            ? { toolUseIntent: input.toolIntent.toolUseIntent }
            : {}),
        });

  if (effectiveExecutionIntent === undefined) {
    return {
      toolIntent: undefined,
      executionIntent: undefined,
      grounding: undefined,
    };
  }

  const candidateViews = buildCandidateViews(effectiveExecutionIntent, input.capabilityManifest);
  const chosenToolName = resolveExecutionIntentToolName({
    execution: effectiveExecutionIntent,
    candidateViews,
    metadata: effectiveIntentMetadata,
  });
  const capabilityManifestItem =
    chosenToolName === undefined
      ? undefined
      : input.capabilityManifest.find((tool) => tool.name === chosenToolName);
  const isFetchTool =
    capabilityManifestItem?.capabilityClasses?.includes("web.fetch") === true ||
    capabilityManifestItem?.capabilityClasses?.includes("web.scrape") === true;

  if (effectiveExecutionIntent.inputHints?.url !== undefined && effectiveExecutionIntent.inputHints.url.trim().length > 0) {
    return {
      executionIntent: {
        ...effectiveExecutionIntent,
        inputHints: {
          ...effectiveExecutionIntent.inputHints,
          urlSource: effectiveExecutionIntent.inputHints.urlSource ?? "user",
        },
      },
      toolIntent: buildToolIntentContext(
        {
          version: "v3",
          execution: {
            ...effectiveExecutionIntent,
            inputHints: {
              ...effectiveExecutionIntent.inputHints,
              urlSource: effectiveExecutionIntent.inputHints.urlSource ?? "user",
            },
          },
          ...(effectiveIntentMetadata !== undefined ? { metadata: effectiveIntentMetadata } : {}),
          confidence: input.toolIntent?.confidence ?? 1,
        },
        input.capabilityManifest,
      ),
      grounding: {
        status: "provided_url",
        reason: "url already present in tool intent",
        matchedUrl: effectiveExecutionIntent.inputHints.url,
        candidateCount: input.priorSources.length,
      },
    };
  }

  const selection = effectiveIntentMetadata?.followUpSourceSelection;
  if (selection === undefined) {
    if (isFetchTool) {
      return {
        executionIntent: effectiveExecutionIntent,
        grounding: {
          status: "insufficient",
          reason: "follow-up source selection is required for fetch follow-ups",
          candidateCount: input.priorSources.length,
        },
      };
    }

    return {
      executionIntent: input.executionIntent,
      grounding: undefined,
    };
  }

  if (selection.kind === "use_prior_source") {
    const matched = input.priorSources.find((source) => source.id === selection.candidateId);
    if (matched === undefined) {
      return {
        executionIntent: input.executionIntent,
        grounding: {
          status: "insufficient",
          reason: selection.reason ?? `follow-up source '${selection.candidateId}' was not found`,
          candidateId: selection.candidateId,
          candidateCount: input.priorSources.length,
        },
      };
    }

    return {
      executionIntent: {
        ...effectiveExecutionIntent,
        inputHints: {
          ...(effectiveExecutionIntent.inputHints ?? {}),
          url: matched.url,
          urlSource: "prior_result_grounding",
        },
      },
      grounding: {
        status: "selected_prior_source",
        reason: selection.reason ?? "selected prior source",
        candidateId: matched.id,
        matchedUrl: matched.url,
        ...(matched.title !== undefined ? { matchedTitle: matched.title } : {}),
        candidateCount: input.priorSources.length,
      },
    };
  }

  if (selection.kind === "search_pivot") {
    const toolName = selection.toolName;
    const query = selection.query;
    if (toolName === undefined || query === undefined) {
      return {
        executionIntent: effectiveExecutionIntent,
        grounding: {
          status: "insufficient",
          reason: "search pivot selection is missing toolName or query",
          candidateCount: input.priorSources.length,
        },
      };
    }

    const manifestItem = input.capabilityManifest.find((tool) => tool.name === toolName);
    if (manifestItem === undefined) {
      return {
        executionIntent: effectiveExecutionIntent,
        grounding: {
          status: "insufficient",
          reason: selection.reason ?? `search pivot tool '${toolName}' is unavailable`,
          toolName,
          query,
          candidateCount: input.priorSources.length,
        },
      };
    }

    return {
      executionIntent: {
        ...effectiveExecutionIntent,
        candidateTools: [toolName],
        inputHints: {
          ...(effectiveExecutionIntent.inputHints ?? {}),
          query,
        },
      },
      grounding: {
        status: "search_pivot",
        reason: selection.reason ?? "pivoted to explicit search",
        toolName,
        query,
        candidateCount: input.priorSources.length,
      },
    };
  }

  return {
    executionIntent: effectiveExecutionIntent,
    grounding: {
      status: "insufficient",
      reason: selection.reason ?? "follow-up grounding was intentionally withheld",
      candidateCount: input.priorSources.length,
    },
  };
}

function readToolSources(input: {
  toolName: string;
  output: unknown;
  stepIndex?: number | undefined;
  updatedAt?: string | undefined;
}): PriorSourceCandidate[] {
  if (
    input.toolName !== "internet.news" &&
    input.toolName !== "internet.search" &&
    input.toolName !== "internet.search_advanced" &&
    input.toolName !== "internet.research"
  ) {
    return [];
  }

  const record = asRecord(input.output);
  if (record === undefined) {
    return [];
  }

  if (input.toolName === "internet.research") {
    return asArray(record.sources)
      .map((item) => buildPriorSourceCandidate(asRecord(item), input.toolName, input.stepIndex, input.updatedAt, asString(record.input)))
      .filter((item): item is PriorSourceCandidate => item !== undefined);
  }

  const contextHint = asString(record.query);
  const results = asArray(record.results);
  const highlights = asArray(record.highlights);
  const items = results.length > 0 ? results : highlights;
  return items
    .map((item) => buildPriorSourceCandidate(asRecord(item), input.toolName, input.stepIndex, input.updatedAt, contextHint))
    .filter((item): item is PriorSourceCandidate => item !== undefined);
}

function buildPriorSourceCandidate(
  record: Record<string, unknown> | undefined,
  toolName: string,
  stepIndex: number | undefined,
  updatedAt: string | undefined,
  contextHint: string | undefined,
): PriorSourceCandidate | undefined {
  const url = asString(record?.url);
  if (url === undefined || url.trim().length === 0) {
    return undefined;
  }

  const normalizedUrl = url.trim();
  const title = asString(record?.title);
  const source = asString(record?.source);
  const category = asString(record?.category);
  const publishedAt = asString(record?.publishedAt);
  const summary = asString(record?.summary);
  const snippet = asString(record?.snippet);
  const id = buildPriorSourceCandidateId(normalizedUrl);

  return {
    id,
    url: normalizedUrl,
    toolName,
    ...(title !== undefined ? { title } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(stepIndex !== undefined ? { stepIndex } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(contextHint !== undefined ? { contextHint } : {}),
  };
}

function readRetainedSourceCandidates(
  evidenceRecoverySummary: Record<string, unknown> | undefined,
): PriorSourceCandidate[] {
  return asArray(evidenceRecoverySummary?.retainedCandidates)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry): PriorSourceCandidate | undefined => {
      const url = asString(entry.url);
      const toolName = asString(entry.toolName);
      if (url === undefined || toolName === undefined || url.trim().length === 0) {
        return undefined;
      }
      const normalizedUrl = url.trim();
      const title = asString(entry.title);
      const source = asString(entry.publisher);
      const category = asString(entry.category);
      const summary = asString(entry.summary);
      const updatedAt = asString(entry.updatedAt);
      const id = buildPriorSourceCandidateId(normalizedUrl);
      return {
        id,
        url: normalizedUrl,
        toolName,
        ...(title !== undefined ? { title } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      };
    })
    .filter((entry): entry is PriorSourceCandidate => entry !== undefined);
}

function buildPriorSourceCandidateId(normalizedUrl: string): string {
  return createHash("sha256")
    .update(normalizedUrl)
    .digest("hex")
    .slice(0, 16);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
