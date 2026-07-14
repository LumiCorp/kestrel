import type { SharedToolContext } from "../contracts.js";
import {
  asNonEmptyRecord,
  createToolInputError,
  parseObjectInput,
  parseOptionalStringArray,
  readNumber,
  readString,
  requireStringField,
} from "../helpers.js";
import type {
  InternetAdvancedSearchInput,
  InternetCrawlInput,
  InternetExtractInput,
  InternetImagesInput,
  InternetMapInput,
  InternetNewsInput,
  InternetResearchInput,
  InternetResearchStatusInput,
  InternetSearchInput,
  TavilyInternetProvider,
} from "./contracts.js";
import { isTavilySearchCountry, type TavilySearchCountry } from "./countries.js";
import { isTavilyDateString } from "./dates.js";
import { createTavilyInternetProvider } from "./provider.js";

export function getInternetProvider(context: SharedToolContext): TavilyInternetProvider {
  if (context.internetProvider !== undefined) {
    return context.internetProvider;
  }

  return createTavilyInternetProvider({
    ...(context.internetEnv !== undefined ? { env: context.internetEnv } : {}),
  });
}

export function parseSearchInput(toolName: string, input: unknown): InternetSearchInput {
  const body = parseObjectInput(toolName, input);
  const query = requireQuery(toolName, body, ["query"]);
  const limit = clampLimit(readNumber(body, "limit"), 1, 20, 8);
  const freshness = optionalString(body, "freshness");

  return {
    query,
    limit,
    ...(freshness !== undefined ? { freshness } : {}),
  };
}

export function parseAdvancedSearchInput(toolName: string, input: unknown): InternetAdvancedSearchInput {
  const body = parseObjectInput(toolName, input);
  const base = parseSearchInput(toolName, body);
  const topic = readEnum(optionalString(body, "topic"), ["general", "news", "finance"]);
  const searchDepth = readEnum(optionalString(body, "searchDepth"), ["basic", "advanced", "fast", "ultra-fast"]);
  const includeAnswer = readIncludeAnswer(body.includeAnswer);
  const includeRawContent = readIncludeRawContent(body.includeRawContent);
  const domainAllow = parseOptionalStringArray(body, "domainAllow", 300);
  const domainDeny = parseOptionalStringArray(body, "domainDeny", 150);
  const country = readSearchCountry(toolName, body, topic, searchDepth);
  const startDate = optionalString(body, "startDate");
  const endDate = optionalString(body, "endDate");
  validateTavilyDateString(toolName, "startDate", startDate);
  validateTavilyDateString(toolName, "endDate", endDate);
  if (startDate !== undefined && endDate !== undefined && startDate === endDate) {
    throw createToolInputError(
      toolName,
      "startDate and endDate cannot be the same day; provide a wider range or omit the explicit dates.",
      {
        field: "startDate",
        expected: "endDate must be a different YYYY-MM-DD date than startDate",
        invalidValues: [startDate, endDate],
      },
    );
  }
  const hasExplicitDateRange = startDate !== undefined || endDate !== undefined;
  const allowSearchChunks = searchDepth === "advanced";
  const allowDays = topic === "news" && hasExplicitDateRange === false;
  const exactMatch = readBoolean(body, "exactMatch");
  if (exactMatch === true && containsDoubleQuotedPhrase(base.query) === false) {
    throw createToolInputError(
      toolName,
      'exactMatch=true requires at least one double-quoted phrase in the query (e.g. "\\"John Smith\\" CEO").',
      {
        field: "query",
        expected: "a query containing at least one double-quoted phrase when exactMatch is true",
        invalidValues: [base.query],
      },
    );
  }

  return {
    query: base.query,
    limit: base.limit,
    ...(base.freshness !== undefined && hasExplicitDateRange === false ? { freshness: base.freshness } : {}),
    ...(topic !== undefined ? { topic } : {}),
    ...(searchDepth !== undefined ? { searchDepth } : {}),
    ...(clampOptional(readNumber(body, "chunksPerSource"), 1, 3) !== undefined && allowSearchChunks
      ? { chunksPerSource: clampOptional(readNumber(body, "chunksPerSource"), 1, 3) }
      : {}),
    ...(clampOptional(readNumber(body, "days"), 1, 365) !== undefined && allowDays
      ? { days: clampOptional(readNumber(body, "days"), 1, 365) }
      : {}),
    ...(startDate !== undefined ? { startDate } : {}),
    ...(endDate !== undefined ? { endDate } : {}),
    ...(country !== undefined ? { country } : {}),
    ...(includeAnswer !== undefined ? { includeAnswer } : {}),
    ...(includeRawContent !== undefined ? { includeRawContent } : {}),
    ...(readBoolean(body, "includeFavicon") !== undefined ? { includeFavicon: readBoolean(body, "includeFavicon") } : {}),
    ...(readBoolean(body, "includeUsage") !== undefined ? { includeUsage: readBoolean(body, "includeUsage") } : {}),
    ...(exactMatch !== undefined ? { exactMatch } : {}),
    ...(domainAllow.length > 0 ? { domainAllow } : {}),
    ...(domainDeny.length > 0 ? { domainDeny } : {}),
  };
}

export function parseNewsInput(toolName: string, input: unknown): InternetNewsInput {
  const body = parseObjectInput(toolName, input);
  const query = requireQuery(toolName, body, ["query"]);
  const limit = clampLimit(readNumber(body, "limit"), 1, 20, 8);
  const freshness = optionalString(body, "freshness");

  return {
    query,
    limit,
    ...(freshness !== undefined ? { freshness } : {}),
  };
}

export function parseImagesInput(toolName: string, input: unknown): InternetImagesInput {
  const body = parseObjectInput(toolName, input);
  const query = requireQuery(toolName, body, ["query"]);
  const limit = clampLimit(readNumber(body, "limit"), 1, 20, 8);

  return {
    query,
    limit,
  };
}

export function parseExtractInput(toolName: string, input: unknown): InternetExtractInput {
  const body = parseObjectInput(toolName, input);
  const urls = parseUrls(toolName, body);
  const maxChars = clampLimit(readNumber(body, "maxChars"), 500, 200_000, 12_000);
  const extractDepth = readEnum(optionalString(body, "extractDepth"), ["basic", "advanced"]);
  const format = readEnum(optionalString(body, "format"), ["markdown", "text"]);

  return {
    urls,
    maxChars,
    ...(optionalString(body, "query") !== undefined ? { query: optionalString(body, "query") } : {}),
    ...(clampOptional(readNumber(body, "chunksPerSource"), 1, 5) !== undefined && optionalString(body, "query") !== undefined
      ? { chunksPerSource: clampOptional(readNumber(body, "chunksPerSource"), 1, 5) }
      : {}),
    ...(extractDepth !== undefined ? { extractDepth } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(readBoolean(body, "includeImages") !== undefined ? { includeImages: readBoolean(body, "includeImages") } : {}),
    ...(readBoolean(body, "includeFavicon") !== undefined ? { includeFavicon: readBoolean(body, "includeFavicon") } : {}),
    ...(readBoolean(body, "includeUsage") !== undefined ? { includeUsage: readBoolean(body, "includeUsage") } : {}),
  };
}

export function parseCrawlInput(toolName: string, input: unknown): InternetCrawlInput {
  const body = parseObjectInput(toolName, input);
  const url = requireStringField(toolName, body, "url");
  const maxChars = clampLimit(readNumber(body, "maxChars"), 500, 200_000, 12_000);
  const extractDepth = readEnum(optionalString(body, "extractDepth"), ["basic", "advanced"]);
  const format = readEnum(optionalString(body, "format"), ["markdown", "text"]);

  return {
    url,
    maxChars,
    ...(optionalString(body, "instructions") !== undefined ? { instructions: optionalString(body, "instructions") } : {}),
    ...(clampOptional(readNumber(body, "maxDepth"), 1, 5) !== undefined ? { maxDepth: clampOptional(readNumber(body, "maxDepth"), 1, 5) } : {}),
    ...(clampOptional(readNumber(body, "maxBreadth"), 1, 500) !== undefined ? { maxBreadth: clampOptional(readNumber(body, "maxBreadth"), 1, 500) } : {}),
    ...(clampOptional(readNumber(body, "limit"), 1, 100) !== undefined ? { limit: clampOptional(readNumber(body, "limit"), 1, 100) } : {}),
    ...stringArrayProp(body, "selectPaths", 100),
    ...stringArrayProp(body, "selectDomains", 100),
    ...stringArrayProp(body, "excludePaths", 100),
    ...stringArrayProp(body, "excludeDomains", 100),
    ...(readBoolean(body, "allowExternal") !== undefined ? { allowExternal: readBoolean(body, "allowExternal") } : {}),
    ...(extractDepth !== undefined ? { extractDepth } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(readBoolean(body, "includeImages") !== undefined ? { includeImages: readBoolean(body, "includeImages") } : {}),
    ...(readBoolean(body, "includeFavicon") !== undefined ? { includeFavicon: readBoolean(body, "includeFavicon") } : {}),
    ...(readBoolean(body, "includeUsage") !== undefined ? { includeUsage: readBoolean(body, "includeUsage") } : {}),
    ...(clampOptional(readNumber(body, "chunksPerSource"), 1, 5) !== undefined && optionalString(body, "instructions") !== undefined
      ? { chunksPerSource: clampOptional(readNumber(body, "chunksPerSource"), 1, 5) }
      : {}),
  };
}

export function parseMapInput(toolName: string, input: unknown): InternetMapInput {
  const body = parseObjectInput(toolName, input);
  const url = requireStringField(toolName, body, "url");

  return {
    url,
    ...(optionalString(body, "instructions") !== undefined ? { instructions: optionalString(body, "instructions") } : {}),
    ...(clampOptional(readNumber(body, "maxDepth"), 1, 5) !== undefined ? { maxDepth: clampOptional(readNumber(body, "maxDepth"), 1, 5) } : {}),
    ...(clampOptional(readNumber(body, "maxBreadth"), 1, 500) !== undefined ? { maxBreadth: clampOptional(readNumber(body, "maxBreadth"), 1, 500) } : {}),
    ...(clampOptional(readNumber(body, "limit"), 1, 500) !== undefined ? { limit: clampOptional(readNumber(body, "limit"), 1, 500) } : {}),
    ...stringArrayProp(body, "selectPaths", 100),
    ...stringArrayProp(body, "selectDomains", 100),
    ...stringArrayProp(body, "excludePaths", 100),
    ...stringArrayProp(body, "excludeDomains", 100),
    ...(readBoolean(body, "allowExternal") !== undefined ? { allowExternal: readBoolean(body, "allowExternal") } : {}),
    ...(readBoolean(body, "includeUsage") !== undefined ? { includeUsage: readBoolean(body, "includeUsage") } : {}),
  };
}

export function parseResearchInput(toolName: string, input: unknown): InternetResearchInput {
  const body = parseObjectInput(toolName, input);
  const researchInput = requireQuery(toolName, body, ["input", "query", "topic"]);
  const model = readEnum(optionalString(body, "model"), ["mini", "pro", "auto"]);
  const citationFormat = readEnum(optionalString(body, "citationFormat"), ["numbered", "mla", "apa", "chicago"]);

  return {
    input: researchInput,
    ...(model !== undefined ? { model } : {}),
    ...(asNonEmptyRecord(body.outputSchema) !== undefined ? { outputSchema: asNonEmptyRecord(body.outputSchema) } : {}),
    ...(citationFormat !== undefined ? { citationFormat } : {}),
    waitForCompletion: readBoolean(body, "waitForCompletion") ?? true,
    maxWaitMs: clampLimit(readNumber(body, "maxWaitMs"), 1_000, 120_000, 30_000),
    pollIntervalMs: clampLimit(readNumber(body, "pollIntervalMs"), 250, 10_000, 2_000),
  };
}

export function parseResearchStatusInput(toolName: string, input: unknown): InternetResearchStatusInput {
  const body = parseObjectInput(toolName, input);
  return {
    requestId: requireStringField(toolName, body, "requestId").trim(),
  };
}

export function optionalString(body: Record<string, unknown> | undefined, key: string): string | undefined {
  const raw = readString(body, key);
  if (raw === undefined) {
    return undefined;
  }

  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function containsDoubleQuotedPhrase(query: string): boolean {
  return /"[^"]+"/u.test(query);
}

function requireQuery(toolName: string, body: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const query = optionalString(body, key);
    if (query !== undefined) {
      return query;
    }
  }

  return requireStringField(toolName, body, keys[0] ?? "query");
}

function clampLimit(value: number | undefined, min: number, max: number, fallback: number): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, candidate));
}

function clampOptional(value: number | undefined, min: number, max: number): number | undefined {
  if (typeof value !== "number" || Number.isFinite(value) === false) {
    return undefined;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function readBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  return typeof body[key] === "boolean" ? body[key] : undefined;
}

function readEnum<const T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  return allowed.includes(value as T) ? value as T : undefined;
}

function readSearchCountry(
  toolName: string,
  body: Record<string, unknown>,
  topic: InternetAdvancedSearchInput["topic"],
  searchDepth: InternetAdvancedSearchInput["searchDepth"],
): TavilySearchCountry | undefined {
  const country = optionalString(body, "country");
  if (country === undefined) {
    return undefined;
  }
  if (topic !== undefined && topic !== "general") {
    return undefined;
  }
  if (searchDepth === "fast" || searchDepth === "ultra-fast") {
    return undefined;
  }
  if (isTavilySearchCountry(country) === false) {
    throw createToolInputError(
      toolName,
      "Invalid internet.search_advanced input.country. Expected one of Tavily's supported lowercase country names.",
      {
        field: "country",
        expected: "one of Tavily's supported lowercase country names",
        invalidValues: [country],
      },
    );
  }
  return country;
}

function validateTavilyDateString(
  toolName: string,
  field: "startDate" | "endDate",
  value: string | undefined,
): void {
  if (value === undefined || isTavilyDateString(value)) {
    return;
  }

  throw createToolInputError(
    toolName,
    `Invalid ${toolName} input.${field}. Expected a YYYY-MM-DD date.`,
    {
      field,
      expected: "a YYYY-MM-DD date",
      invalidValues: [value],
    },
  );
}

function readIncludeAnswer(value: unknown): boolean | "basic" | "advanced" | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "basic" || value === "advanced") {
    return value;
  }
  return undefined;
}

function readIncludeRawContent(value: unknown): false | "markdown" | "text" | undefined {
  if (value === true) {
    return "markdown";
  }
  if (value === false || value === "markdown" || value === "text") {
    return value;
  }
  return undefined;
}

function stringArrayProp(
  body: Record<string, unknown>,
  key: "selectPaths" | "selectDomains" | "excludePaths" | "excludeDomains",
  maxItems: number,
): Partial<Record<typeof key, string[]>> {
  const values = parseOptionalStringArray(body, key, maxItems);
  return values.length > 0 ? { [key]: values } as Partial<Record<typeof key, string[]>> : {};
}

function parseUrls(toolName: string, body: Record<string, unknown>): string[] {
  const fromArray = parseOptionalStringArray(body, "urls", 20);
  if (fromArray.length > 0) {
    return fromArray;
  }
  const single = readString(body, "url")?.trim();
  if (single !== undefined && single.length > 0) {
    return [single];
  }
  return [requireStringField(toolName, body, "urls").trim()];
}
