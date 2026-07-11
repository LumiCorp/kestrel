import { canonicalizeDuplicateUrl } from "../runtime/readOnlyResultDuplicates.js";

export interface NormalizedRetrievalGuardInput {
  toolName: string;
  primaryText: string;
  comparableFields: Record<string, string>;
}

export interface NormalizedRetrievalGuardOutput {
  topUrls: string[];
  topDomains: string[];
  topSignals: string[];
}

const RETRIEVAL_TOOL_FAMILIES = new Map<string, string>([
  ["internet.search", "internet.search_like"],
  ["internet.search_advanced", "internet.search_like"],
  ["internet.news", "internet.search_like"],
  ["internet.images", "internet.search_like"],
  ["internet.extract", "internet.page_like"],
  ["internet.crawl", "internet.page_like"],
  ["internet.map", "internet.search_like"],
  ["internet.research", "internet.search_like"],
  ["source.search", "web.search_like"],
  ["source.fetch", "web.page_like"],
  ["source.triage", "web.search_like"],
  ["dev.process.read", "dev.process.read_like"],
]);

const PRIMARY_TEXT_FIELD_PRIORITY = [
  "query",
  "topic",
  "text",
  "prompt",
  "objective",
  "path",
  "processId",
  "workspaceRoot",
  "cursor",
  "title",
  "url",
  "command",
];

const TEXT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "current",
  "exact",
  "for",
  "from",
  "in",
  "latest",
  "new",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "today",
  "with",
]);

const TEXT_TOKEN_ALIASES = new Map<string, string>([
  ["fixture", "game"],
  ["fixtures", "game"],
  ["game", "game"],
  ["games", "game"],
  ["match", "game"],
  ["matches", "game"],
  ["record", "record"],
  ["records", "record"],
  ["result", "result"],
  ["results", "result"],
  ["three", "3"],
  ["two", "2"],
  ["one", "1"],
  ["four", "4"],
  ["five", "5"],
  ["six", "6"],
  ["seven", "7"],
  ["eight", "8"],
  ["nine", "9"],
  ["ten", "10"],
]);

export function normalizeRetrievalGuardInput(
  toolName: string,
  input: Record<string, unknown>,
): NormalizedRetrievalGuardInput {
  const comparableFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(input).sort(([left], [right]) => left.localeCompare(right))) {
    const normalized = normalizeComparableFieldValue(key, value);
    if (normalized !== undefined) {
      comparableFields[key] = normalized;
    }
  }
  return {
    toolName,
    primaryText: readPrimaryText(comparableFields),
    comparableFields,
  };
}

export function normalizeRetrievalGuardOutput(
  _toolName: string,
  output: Record<string, unknown>,
): NormalizedRetrievalGuardOutput {
  const entries = readOutputEntries(output);
  const topUrls: string[] = [];
  const topDomains: string[] = [];
  const topSignals: string[] = [];
  const seenUrls = new Set<string>();
  const seenDomains = new Set<string>();
  const seenSignals = new Set<string>();

  for (const entry of entries) {
    const url = readEntryUrl(entry);
    const domain = readEntryDomain(entry, url);
    const signal = readEntrySignal(entry);
    if (url !== undefined && seenUrls.has(url) === false) {
      seenUrls.add(url);
      topUrls.push(url);
    }
    if (domain !== undefined && seenDomains.has(domain) === false) {
      seenDomains.add(domain);
      topDomains.push(domain);
    }
    if (signal !== undefined && seenSignals.has(signal) === false) {
      seenSignals.add(signal);
      topSignals.push(signal);
    }
    if (topUrls.length >= 5 && topDomains.length >= 5 && topSignals.length >= 5) {
      break;
    }
  }

  return {
    topUrls: topUrls.slice(0, 5),
    topDomains: topDomains.slice(0, 5),
    topSignals: topSignals.slice(0, 5),
  };
}

export function classifyRetrievalRedundancy(input: {
  prior: {
    toolName: string;
    input: NormalizedRetrievalGuardInput;
    output: NormalizedRetrievalGuardOutput;
  };
  current: {
    toolName: string;
    input: NormalizedRetrievalGuardInput;
    output: NormalizedRetrievalGuardOutput;
  };
}): { redundant: boolean } {
  const sameFamily =
    readRetrievalToolFamily(input.prior.toolName) === readRetrievalToolFamily(input.current.toolName);
  const inputSimilar = input.prior.input.primaryText === input.current.input.primaryText;
  const outputSimilar =
    hasSharedValue(input.prior.output.topUrls, input.current.output.topUrls) ||
    hasSharedValue(input.prior.output.topDomains, input.current.output.topDomains) ||
    hasSharedValue(input.prior.output.topSignals, input.current.output.topSignals);

  return {
    redundant: sameFamily && inputSimilar && outputSimilar,
  };
}

export function readRetrievalToolFamily(toolName: string): string {
  return RETRIEVAL_TOOL_FAMILIES.get(toolName) ?? toolName;
}

export function isRetrievalToolName(toolName: string): boolean {
  return RETRIEVAL_TOOL_FAMILIES.has(toolName);
}

function normalizeComparableFieldValue(key: string, value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (key.toLowerCase().includes("url")) {
    return canonicalizeDuplicateUrl(trimmed) ?? normalizeText(trimmed);
  }
  return normalizeText(trimmed);
}

function readPrimaryText(comparableFields: Record<string, string>): string {
  for (const key of PRIMARY_TEXT_FIELD_PRIORITY) {
    const value = comparableFields[key];
    if (value !== undefined) {
      return normalizeRetrievalText(value);
    }
  }
  const firstField = Object.values(comparableFields)[0];
  return firstField !== undefined ? normalizeRetrievalText(firstField) : "";
}

function normalizeRetrievalText(value: string): string {
  const tokens = normalizeText(value)
    .replace(/[^\p{Letter}\p{Number}\s]+/gu, " ")
    .split(/\s+/u)
    .map((token) => normalizeRetrievalToken(token))
    .filter((token): token is string => token !== undefined)
    .sort((left, right) => left.localeCompare(right));
  return tokens.join(" ");
}

function normalizeRetrievalToken(token: string): string | undefined {
  if (token.length === 0) {
    return undefined;
  }
  if (TEXT_STOP_WORDS.has(token)) {
    return undefined;
  }
  return TEXT_TOKEN_ALIASES.get(token) ?? token;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function readOutputEntries(output: Record<string, unknown>): Record<string, unknown>[] {
  const resultArrays = [
    output.entries,
    output.results,
    output.highlights,
    output.items,
    output.files,
    output.chunks,
    output.lines,
  ]
    .filter((value): value is unknown[] => Array.isArray(value));

  for (const resultArray of resultArrays) {
    const entries = resultArray
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined);
    if (entries.length > 0) {
      return entries;
    }
  }

  return [output];
}

function readEntrySignal(entry: Record<string, unknown>): string | undefined {
  const parts = [
    readSignalValue(asString(entry.url) ?? asString(entry.link) ?? asString(entry.href) ?? asString(entry.canonicalUrl)),
    readSignalValue(asString(entry.path) ?? asString(entry.filePath) ?? asString(entry.sourcePath)),
    readSignalValue(asString(entry.title) ?? asString(entry.name) ?? asString(entry.summary)),
    readSignalValue(asString(entry.text) ?? asString(entry.content) ?? asString(entry.body) ?? asString(entry.message)),
    readSignalValue(asString(entry.command) ?? asString(entry.processId) ?? asString(entry.sessionId)),
    readSignalValue(asString(entry.cursor) ?? asString(entry.workspaceRoot) ?? asString(entry.cwd)),
    readSignalValue(asString(entry.status) ?? asString(entry.kind)),
  ].filter((part): part is string => part !== undefined);
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join(" | ");
}

function readSignalValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : undefined;
}

function readEntryUrl(entry: Record<string, unknown>): string | undefined {
  const candidate = asString(entry.url) ?? asString(entry.link) ?? asString(entry.href) ?? asString(entry.canonicalUrl);
  if (candidate === undefined) {
    return undefined;
  }
  return canonicalizeDuplicateUrl(candidate) ?? normalizeText(candidate);
}

function readEntryDomain(entry: Record<string, unknown>, url: string | undefined): string | undefined {
  if (url !== undefined) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
    } catch {
      // Fall through to source parsing.
    }
  }
  const source = asString(entry.source) ?? asString(entry.domain) ?? asString(entry.hostname);
  if (source === undefined) {
    return undefined;
  }
  return source.toLowerCase().replace(/^www\./u, "");
}

function hasSharedValue(prior: readonly string[], current: readonly string[]): boolean {
  if (prior.length === 0 || current.length === 0) {
    return false;
  }
  const seen = new Set(prior);
  return current.some((value) => seen.has(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
