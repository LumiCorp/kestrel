import type { ToolPresentationMetadata } from "./contracts.js";
import { createRuntimeFailure } from "../src/runtime/RuntimeFailure.js";

export interface ResolvedToolPresentationMetadata {
  displayName: string;
  aliases: string[];
  keywords: string[];
  provider: string;
  toolFamily: string;
}

export function resolveToolPresentationMetadata(input: {
  name: string;
  presentation: ToolPresentationMetadata;
  extraAliases?: string[] | undefined;
  extraKeywords?: string[] | undefined;
}): ResolvedToolPresentationMetadata {
  const displayName = input.presentation.displayName.trim();
  if (displayName.length === 0) {
    throw createRuntimeFailure(
      "TOOL_PRESENTATION_METADATA_INVALID",
      `Tool '${input.name}' is missing presentation.displayName.`,
      {
        subsystem: "tooling",
        toolName: input.name,
        field: "displayName",
        contractPath: "definition.presentation.displayName",
        classification: "configuration",
        recoverable: false,
      },
    );
  }
  const aliases = uniqueStrings([
    ...input.presentation.aliases,
    ...(input.extraAliases ?? []),
  ]);
  if (aliases.length === 0) {
    throw createRuntimeFailure(
      "TOOL_PRESENTATION_METADATA_INVALID",
      `Tool '${input.name}' is missing presentation.aliases.`,
      {
        subsystem: "tooling",
        toolName: input.name,
        field: "aliases",
        contractPath: "definition.presentation.aliases",
        classification: "configuration",
        recoverable: false,
      },
    );
  }
  const keywords = uniqueStrings([
    ...input.presentation.keywords,
    ...(input.extraKeywords ?? []),
  ]);
  if (keywords.length === 0) {
    throw createRuntimeFailure(
      "TOOL_PRESENTATION_METADATA_INVALID",
      `Tool '${input.name}' is missing presentation.keywords.`,
      {
        subsystem: "tooling",
        toolName: input.name,
        field: "keywords",
        contractPath: "definition.presentation.keywords",
        classification: "configuration",
        recoverable: false,
      },
    );
  }
  const provider = input.presentation.provider.trim();
  if (provider.length === 0) {
    throw createRuntimeFailure(
      "TOOL_PRESENTATION_METADATA_INVALID",
      `Tool '${input.name}' is missing presentation.provider.`,
      {
        subsystem: "tooling",
        toolName: input.name,
        field: "provider",
        contractPath: "definition.presentation.provider",
        classification: "configuration",
        recoverable: false,
      },
    );
  }
  const toolFamily = input.presentation.toolFamily.trim();
  if (toolFamily.length === 0) {
    throw createRuntimeFailure(
      "TOOL_PRESENTATION_METADATA_INVALID",
      `Tool '${input.name}' is missing presentation.toolFamily.`,
      {
        subsystem: "tooling",
        toolName: input.name,
        field: "toolFamily",
        contractPath: "definition.presentation.toolFamily",
        classification: "configuration",
        recoverable: false,
      },
    );
  }

  return {
    displayName,
    aliases,
    keywords,
    provider,
    toolFamily,
  };
}

export function tokenizeSearchText(value: string): string[] {
  const normalized = normalizeSearchText(value);
  if (normalized.length === 0) {
    return [];
  }

  return normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

export function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result;
}
