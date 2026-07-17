import type {
  TavilyCrawlOptions,
  TavilyCrawlResponse,
  TavilyExtractOptions,
  TavilyExtractResponse,
  TavilyGetResearchResponse,
  TavilyGetResearchIncompleteStatusResponse,
  TavilyMapOptions,
  TavilyMapResponse,
  TavilyResearchOptions,
  TavilyResearchResponse,
  TavilySearchOptions,
  TavilySearchResponse,
} from "@tavily/core";

import { isLowValueInternetResultUrl } from "../../src/shared/internetResultHygiene.js";
import { createToolProviderError } from "../helpers.js";
import type {
  InternetAdvancedSearchInput,
  InternetCrawlInput,
  InternetDegradedState,
  InternetExtractionContentIssue,
  InternetExtractInput,
  InternetExtractOutput,
  InternetFetchResult,
  InternetImageResultItem,
  InternetImagesInput,
  InternetMapInput,
  InternetMapOutput,
  InternetNewsInput,
  InternetProviderCallResult,
  InternetResearchInput,
  InternetResearchOutput,
  InternetSearchInput,
  InternetSearchResultItem,
  InternetUsageOutput,
  TavilyInternetProvider,
} from "./contracts.js";
import { createTavilyClient, type TavilySdkClient } from "./client.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 12_000;
const TAVILY_MAX_QUERY_CHARS = 400;
const TAVILY_MAX_RESULTS = 20;
const TAVILY_OVERFETCH_EXTRA_RESULTS = 5;

interface CreateTavilyInternetProviderOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  projectId?: string | undefined;
  httpProxy?: string | undefined;
  httpsProxy?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  maxAttempts?: number | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  client?: TavilySdkClient | undefined;
  tavilyFactory?: ((options?: {
    apiKey?: string;
    proxies?: { http?: string; https?: string };
    apiBaseURL?: string;
    clientSource?: string;
    projectId?: string;
  }) => TavilySdkClient) | undefined;
}

interface RequestOptions {
  toolName: string;
  sdkMethod: "search" | "extract" | "crawl" | "map" | "research" | "getResearch" | "usage";
  queryHint?: string | undefined;
  projectId?: string | undefined;
}

interface RecoverableFailure {
  code: string;
  message: string;
  retryAfterSeconds?: number | undefined;
}

type RequestResult<T> =
  | {
      kind: "ok";
      response: T;
    }
  | {
      kind: "recoverable_failure";
      failure: RecoverableFailure;
    };

type QueryPlanResult =
  | {
      kind: "ready";
      queries: string[];
    }
  | {
      kind: "degraded";
      degraded: InternetDegradedState;
    };

export function createTavilyInternetProvider(
  options: CreateTavilyInternetProviderOptions = {},
): TavilyInternetProvider {
  const env = options.env ?? process.env;
  const timeoutSeconds = millisecondsToSeconds(
    clampInteger(options.timeoutMs, 1000, 60_000, DEFAULT_TIMEOUT_MS),
  );
  const maxAttempts = clampInteger(options.maxAttempts, 1, 5, DEFAULT_MAX_ATTEMPTS);
  const apiKey = coalesceNonEmpty(options.apiKey, env.TAVILY_API_KEY);
  const baseUrl = coalesceNonEmpty(options.baseUrl, env.TAVILY_BASE_URL) ?? "https://api.tavily.com";
  const projectId = coalesceNonEmpty(options.projectId, env.TAVILY_PROJECT);
  const fetchImpl = options.fetchImpl ?? fetch;
  const client =
    options.client ??
    createTavilyClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      projectId,
      httpProxy: options.httpProxy,
      httpsProxy: options.httpsProxy,
      env,
      tavilyFactory: options.tavilyFactory,
    });

  const requestWithRetries = async <TResponse, TData>(
    request: () => Promise<TResponse>,
    buildFallbackValue: () => TData,
    normalize: (response: TResponse) => TData,
    requestOptions: RequestOptions,
  ): Promise<InternetProviderCallResult<TData>> => {
    let lastRecoverableFailure: RecoverableFailure | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await invokeSdkRequest(request, requestOptions);
      if (result.kind === "recoverable_failure") {
        lastRecoverableFailure = result.failure;
        if (attempt < maxAttempts) {
          await sleep(jitteredBackoffMs(attempt));
          continue;
        }

        return {
          status: "degraded",
          provider: "tavily",
          attempts: attempt,
          data: buildFallbackValue(),
          degraded: {
            code: result.failure.code,
            message: result.failure.message,
            ...(result.failure.retryAfterSeconds !== undefined
              ? { retryAfterSeconds: result.failure.retryAfterSeconds }
              : {}),
            recoverable: true,
          },
        };
      }

      return {
        status: "ok",
        provider: "tavily",
        attempts: attempt,
        ...readResponseMetadata(result.response),
        data: normalize(result.response),
      };
    }

    return {
      status: "degraded",
      provider: "tavily",
      attempts: maxAttempts,
      data: buildFallbackValue(),
      degraded: {
        code: "provider_retry_exhausted",
        message: lastRecoverableFailure?.message ?? "Provider retries exhausted.",
        ...(lastRecoverableFailure?.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: lastRecoverableFailure.retryAfterSeconds }
          : {}),
        recoverable: true,
      },
    };
  };

  const search = async (
    input: InternetSearchInput,
  ): Promise<InternetProviderCallResult<{ query: string; results: InternetSearchResultItem[] }>> => runSearchFanout({
      input: {
        ...input,
        topic: "general",
        searchDepth: "basic",
      },
      toolName: "internet.search",
    });

  const searchAdvanced = async (
    input: InternetAdvancedSearchInput,
  ): Promise<InternetProviderCallResult<{ query: string; answer?: string; results: InternetSearchResultItem[] }>> =>
    runSearchFanout({
      input: {
        ...input,
        topic: input.topic ?? "general",
        searchDepth: input.searchDepth ?? "basic",
      },
      toolName: "internet.search_advanced",
      includeAnswer: true,
    });

  const news = async (
  input: InternetNewsInput,
  ): Promise<InternetProviderCallResult<{ query: string; results: InternetSearchResultItem[] }>> => {
    const result = await runSearchFanout({
      input: {
        ...input,
        topic: "news",
        searchDepth: "basic",
      },
      toolName: "internet.news",
    });
    return {
      ...result,
      data: {
        query: result.data.query,
        results: result.data.results,
      },
    };
  };

  const images = async (
    input: InternetImagesInput,
  ): Promise<InternetProviderCallResult<{ query: string; results: InternetImageResultItem[] }>> => {
    const normalizedQuery = normalizeProviderQuery(input.query);
    return requestWithRetries(
      () =>
        client.search(normalizedQuery, {
          searchDepth: "basic",
          topic: "general",
          maxResults: input.limit,
          includeImages: true,
          includeImageDescriptions: true,
          timeout: timeoutSeconds,
        }),
      () => ({ query: normalizedQuery, results: [] }),
      (response) => ({
        query: response.query,
        results: normalizeImageResults(response.images ?? [], input.limit),
      }),
      {
        toolName: "internet.images",
        sdkMethod: "search",
        queryHint: normalizedQuery,
        projectId,
      },
    );
  };

  const getUrl = async (
    input: InternetExtractInput,
  ): Promise<InternetProviderCallResult<InternetExtractOutput>> => requestWithRetries(
      () =>
        client.extract(input.urls, {
          extractDepth: input.extractDepth ?? "advanced",
          format: input.format ?? "markdown",
          timeout: timeoutSeconds,
          ...(input.includeImages !== undefined ? { includeImages: input.includeImages } : {}),
          ...(input.includeFavicon !== undefined ? { includeFavicon: input.includeFavicon } : {}),
          ...(input.includeUsage !== undefined ? { includeUsage: input.includeUsage } : {}),
          ...(input.query !== undefined ? { query: input.query } : {}),
          ...(input.chunksPerSource !== undefined && input.query !== undefined
            ? { chunksPerSource: input.chunksPerSource }
            : {}),
        }),
      () => ({
        results: [],
        failedResults: input.urls.map((url) => ({ url, error: "provider_unavailable" })),
      }),
      (response) => normalizeExtractResponse(response, input.maxChars, input.format ?? "markdown"),
      {
        toolName: "internet.extract",
        sdkMethod: "extract",
        queryHint: input.urls.join(", "),
        projectId,
      },
    );

  const crawl = async (
    input: InternetCrawlInput,
  ): Promise<InternetProviderCallResult<{ baseUrl: string; results: InternetFetchResult[] }>> => requestWithRetries(
      () =>
        client.crawl(input.url, {
          extractDepth: input.extractDepth ?? "advanced",
          format: input.format ?? "markdown",
          timeout: timeoutSeconds,
          ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
          ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
          ...(input.maxBreadth !== undefined ? { maxBreadth: input.maxBreadth } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.selectPaths !== undefined ? { selectPaths: input.selectPaths } : {}),
          ...(input.selectDomains !== undefined ? { selectDomains: input.selectDomains } : {}),
          ...(input.excludePaths !== undefined ? { excludePaths: input.excludePaths } : {}),
          ...(input.excludeDomains !== undefined ? { excludeDomains: input.excludeDomains } : {}),
          ...(input.allowExternal !== undefined ? { allowExternal: input.allowExternal } : {}),
          ...(input.includeImages !== undefined ? { includeImages: input.includeImages } : {}),
          ...(input.includeFavicon !== undefined ? { includeFavicon: input.includeFavicon } : {}),
          ...(input.includeUsage !== undefined ? { includeUsage: input.includeUsage } : {}),
          ...(input.chunksPerSource !== undefined && input.instructions !== undefined
            ? { chunksPerSource: input.chunksPerSource }
            : {}),
        }),
      () => ({ baseUrl: input.url, results: [] }),
      (response) => normalizeCrawlResponse(response, input.maxChars, input.format ?? "markdown"),
      {
        toolName: "internet.crawl",
        sdkMethod: "crawl",
        queryHint: input.url,
        projectId,
      },
    );

  const map = async (
    input: InternetMapInput,
  ): Promise<InternetProviderCallResult<InternetMapOutput>> =>
    requestWithRetries(
      () =>
        client.map(input.url, {
          timeout: timeoutSeconds,
          ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
          ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
          ...(input.maxBreadth !== undefined ? { maxBreadth: input.maxBreadth } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.selectPaths !== undefined ? { selectPaths: input.selectPaths } : {}),
          ...(input.selectDomains !== undefined ? { selectDomains: input.selectDomains } : {}),
          ...(input.excludePaths !== undefined ? { excludePaths: input.excludePaths } : {}),
          ...(input.excludeDomains !== undefined ? { excludeDomains: input.excludeDomains } : {}),
          ...(input.allowExternal !== undefined ? { allowExternal: input.allowExternal } : {}),
          ...(input.includeUsage !== undefined ? { includeUsage: input.includeUsage } : {}),
        }),
      () => ({ baseUrl: input.url, results: [] }),
      (response) => ({ baseUrl: response.baseUrl, results: response.results }),
      {
        toolName: "internet.map",
        sdkMethod: "map",
        queryHint: input.url,
        projectId,
      },
    );

  const researchStatus = async (
    input: { requestId: string },
  ): Promise<InternetProviderCallResult<InternetResearchOutput>> =>
    requestWithRetries(
      () => client.getResearch(input.requestId),
      () => ({ requestId: input.requestId, status: "unavailable" }),
      normalizeResearchStatusResponse,
      {
        toolName: "internet.research_status",
        sdkMethod: "getResearch",
        queryHint: input.requestId,
        projectId,
      },
    );

  const research = async (
    input: InternetResearchInput,
  ): Promise<InternetProviderCallResult<InternetResearchOutput>> => {
    const submitted = await requestWithRetries(
      () =>
        client.research(input.input, {
          stream: false,
          timeout: timeoutSeconds,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.outputSchema !== undefined ? { outputSchema: input.outputSchema } : {}),
          ...(input.citationFormat !== undefined ? { citationFormat: input.citationFormat } : {}),
        }),
      () => ({ requestId: "", status: "unavailable" }),
      normalizeResearchSubmitResponse,
      {
        toolName: "internet.research",
        sdkMethod: "research",
        queryHint: input.input,
        projectId,
      },
    );
    if (submitted.status === "degraded" || input.waitForCompletion === false || isResearchComplete(submitted.data.status)) {
      return submitted;
    }

    const startedAt = Date.now();
    let latest: InternetProviderCallResult<InternetResearchOutput> = submitted;
    while (Date.now() - startedAt < input.maxWaitMs) {
      await sleep(input.pollIntervalMs);
      latest = await researchStatus({ requestId: submitted.data.requestId });
      if (isResearchComplete(latest.data.status)) {
        return {
          ...latest,
          attempts: submitted.attempts + latest.attempts,
        };
      }
    }

    return {
      ...latest,
      status: "degraded",
      attempts: submitted.attempts + latest.attempts,
      degraded: {
        code: "research_pending",
        message: "Tavily research task is still pending.",
        recoverable: true,
      },
    };
  };

  const usage = async (): Promise<InternetProviderCallResult<InternetUsageOutput>> =>
    requestWithRetries(
      async () => fetchUsage(fetchImpl, { apiKey, baseUrl, projectId }),
      () => ({}),
      (response) => response,
      {
        toolName: "internet.usage",
        sdkMethod: "usage",
        projectId,
      },
    );

  return {
    search,
    searchAdvanced,
    news,
    images,
    extract: getUrl,
    crawl,
    map,
    research,
    researchStatus,
    usage,
  };

  async function runSearchFanout<T extends { query: string; limit: number; topic?: TavilySearchOptions["topic"]; searchDepth?: TavilySearchOptions["searchDepth"]; freshness?: string | undefined }>(
    options: {
      input: T & Partial<InternetAdvancedSearchInput>;
      toolName: string;
      includeAnswer?: boolean | undefined;
    },
  ): Promise<InternetProviderCallResult<{ query: string; answer?: string; results: InternetSearchResultItem[] }>> {
    const timeRange = normalizeTimeRange(options.input.freshness);
    const includeTimeRange = timeRange !== undefined && options.input.startDate === undefined && options.input.endDate === undefined;
    const queryPlan = buildProviderQueryPlan(options.input.query);
    if (queryPlan.kind === "degraded") {
      return {
        status: "degraded",
        provider: "tavily",
        attempts: 0,
        data: { query: options.input.query, results: [] },
        degraded: queryPlan.degraded,
      };
    }

    const results = await Promise.all(
      queryPlan.queries.map((query) =>
        requestWithRetries(
          () =>
            client.search(query, {
              searchDepth: options.input.searchDepth ?? "basic",
              topic: options.input.topic ?? "general",
              maxResults: computeProviderResultLimit(options.input.limit),
              timeout: timeoutSeconds,
              ...(includeTimeRange ? { timeRange } : {}),
              ...(options.input.chunksPerSource !== undefined && options.input.searchDepth === "advanced"
                ? { chunksPerSource: options.input.chunksPerSource }
                : {}),
              ...(options.input.days !== undefined
              && options.input.topic === "news"
              && options.input.startDate === undefined
              && options.input.endDate === undefined
                ? { days: options.input.days }
                : {}),
              ...(options.input.startDate !== undefined ? { startDate: options.input.startDate } : {}),
              ...(options.input.endDate !== undefined ? { endDate: options.input.endDate } : {}),
              ...(options.input.country !== undefined ? { country: options.input.country } : {}),
              ...(options.input.includeAnswer !== undefined ? { includeAnswer: options.input.includeAnswer } : {}),
              ...(options.input.includeRawContent !== undefined ? { includeRawContent: options.input.includeRawContent } : {}),
              ...(options.input.includeFavicon !== undefined ? { includeFavicon: options.input.includeFavicon } : {}),
              ...(options.input.includeUsage !== undefined ? { includeUsage: options.input.includeUsage } : {}),
              ...(options.input.exactMatch !== undefined ? { exactMatch: options.input.exactMatch } : {}),
              ...(options.input.domainAllow !== undefined && options.input.domainAllow.length > 0
                ? { includeDomains: options.input.domainAllow }
                : {}),
              ...(options.input.domainDeny !== undefined && options.input.domainDeny.length > 0
                ? { excludeDomains: options.input.domainDeny }
                : {}),
            }),
          () => ({ query, results: [] as InternetSearchResultItem[] }),
          (response) => ({
            query: response.query,
            ...(typeof response.answer === "string" && response.answer.trim().length > 0 ? { answer: response.answer } : {}),
            results: normalizeSearchResults(response, options.input.limit),
          }),
          {
            toolName: options.toolName,
            sdkMethod: "search",
            queryHint: query,
            projectId,
          },
        ),
      ),
    );

    const answer = results
      .map((result) => (result.data as { answer?: unknown }).answer)
      .find((value): value is string => typeof value === "string");
    return mergeQueryFanoutResults(results, options.input.limit, (data) => data.results, (merged) => ({
      query: options.input.query,
      ...(options.includeAnswer === true && answer !== undefined ? { answer } : {}),
      results: merged,
    }));
  }
}

async function invokeSdkRequest<TResponse>(
  request: () => Promise<TResponse>,
  requestOptions: RequestOptions,
): Promise<RequestResult<TResponse>> {
  try {
    return {
      kind: "ok",
      response: await request(),
    };
  } catch (error) {
    const recoverable = classifyRecoverableSdkFailure(error);
    if (recoverable !== undefined) {
      return {
        kind: "recoverable_failure",
        failure: recoverable,
      };
    }

    throw createToolProviderError(
      requestOptions.toolName,
      "tavily",
      extractSdkErrorMessage(error) ?? "Provider request failed.",
      {
        sdkMethod: requestOptions.sdkMethod,
        query: requestOptions.queryHint,
        ...(requestOptions.projectId !== undefined ? { projectId: requestOptions.projectId } : {}),
        ...(extractStatusCode(error) !== undefined ? { status: extractStatusCode(error) } : {}),
        ...(extractRequestId(error) !== undefined ? { requestId: extractRequestId(error) } : {}),
        ...(extractRetryAfterSeconds(error) !== undefined
          ? { retryAfterSeconds: extractRetryAfterSeconds(error) }
          : {}),
        recoverable: false,
      },
    );
  }
}

function readResponseMetadata(response: unknown): {
  requestId?: string | undefined;
  responseTime?: number | undefined;
  usage?: Record<string, unknown> | undefined;
} {
  const record = asPlainObject(response);
  const requestId = typeof record?.requestId === "string" && record.requestId.trim().length > 0
    ? record.requestId.trim()
    : undefined;
  const responseTime = typeof record?.responseTime === "number" && Number.isFinite(record.responseTime)
    ? record.responseTime
    : undefined;
  const usage = asPlainObject(record?.usage);
  return {
    ...(requestId !== undefined ? { requestId } : {}),
    ...(responseTime !== undefined ? { responseTime } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

function normalizeResearchSubmitResponse(
  response: TavilyResearchResponse | AsyncGenerator<Buffer, void, unknown>,
): InternetResearchOutput {
  if (isAsyncGenerator(response)) {
    return {
      requestId: "",
      status: "streaming_unavailable",
    };
  }
  return {
    requestId: response.requestId,
    ...(typeof response.createdAt === "string" ? { createdAt: response.createdAt } : {}),
    status: response.status,
    ...(typeof response.input === "string" ? { input: response.input } : {}),
    ...(typeof response.model === "string" ? { model: response.model } : {}),
  };
}

function normalizeResearchStatusResponse(
  response: TavilyGetResearchResponse | TavilyGetResearchIncompleteStatusResponse,
): InternetResearchOutput {
  const complete = response as TavilyGetResearchResponse;
  const createdAt = "createdAt" in response && typeof response.createdAt === "string" ? response.createdAt : undefined;
  return {
    requestId: response.requestId,
    ...(createdAt !== undefined ? { createdAt } : {}),
    status: response.status,
    ...(typeof complete.content === "string" || asPlainObject(complete.content) !== undefined
      ? { content: complete.content as string | Record<string, unknown> }
      : {}),
    ...(Array.isArray(complete.sources)
      ? {
          sources: complete.sources
            .filter((source) => typeof source.title === "string" && typeof source.url === "string")
            .map((source) => ({ title: source.title, url: source.url })),
        }
      : {}),
  };
}

function isResearchComplete(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "completed" || normalized === "complete" || normalized === "failed" || normalized === "error";
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<Buffer, void, unknown> {
  return typeof (value as { [Symbol.asyncIterator]?: unknown } | undefined)?.[Symbol.asyncIterator] === "function";
}

async function fetchUsage(
  fetchImpl: typeof fetch,
  input: { apiKey?: string | undefined; baseUrl: string; projectId?: string | undefined },
): Promise<InternetUsageOutput> {
  if (input.apiKey === undefined) {
    throw createToolProviderError("internet.usage", "tavily", "Missing Tavily API key.", {
      classification: "configuration",
      recoverable: false,
      envVar: "TAVILY_API_KEY",
    });
  }
  const url = `${input.baseUrl.replace(/\/+$/u, "")}/usage`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      ...(input.projectId !== undefined ? { "X-Project-ID": input.projectId } : {}),
    },
  });
  if (response.ok === false) {
    throw createToolProviderError("internet.usage", "tavily", `Provider request failed with status ${response.status}.`, {
      sdkMethod: "usage",
      status: response.status,
      statusText: response.statusText,
      recoverable: response.status === 429 || response.status >= 500,
    });
  }
  const payload = await response.json() as unknown;
  const record = asPlainObject(payload);
  if (record === undefined) {
    return {};
  }
  return {
    ...(asPlainObject(record.key) !== undefined ? { key: asPlainObject(record.key) } : {}),
    ...(asPlainObject(record.account) !== undefined ? { account: asPlainObject(record.account) } : {}),
  };
}

function normalizeSearchResults(
  response: TavilySearchResponse,
  limit: number,
): InternetSearchResultItem[] {
  return response.results
    .map((result) => ({
      title: result.title.trim(),
      url: result.url.trim(),
      snippet: result.content.trim(),
      ...(typeof result.score === "number" && Number.isFinite(result.score) ? { score: result.score } : {}),
      ...(typeof result.publishedDate === "string" && result.publishedDate.trim().length > 0
        ? { publishedAt: result.publishedDate }
        : {}),
      ...(typeof result.favicon === "string" && result.favicon.trim().length > 0
        ? { favicon: result.favicon.trim() }
        : {}),
      ...(typeof result.rawContent === "string" && result.rawContent.trim().length > 0
        ? { rawContent: result.rawContent.trim() }
        : {}),
      ...(deriveSource(result.url) !== undefined ? { source: deriveSource(result.url) } : {}),
    }))
    .filter((result) => result.url.length > 0 && isLowValueInternetResultUrl(result.url) === false)
    .slice(0, limit);
}

function computeProviderResultLimit(limit: number): number {
  return Math.min(TAVILY_MAX_RESULTS, Math.max(limit, limit + TAVILY_OVERFETCH_EXTRA_RESULTS));
}

function normalizeProviderQuery(query: string): string {
  return trimDanglingQuerySuffix(query.replace(/\s+/gu, " ").trim());
}

function buildProviderQueryPlan(query: string): QueryPlanResult {
  const normalized = normalizeProviderQuery(query);
  if (normalized.length <= TAVILY_MAX_QUERY_CHARS) {
    return {
      kind: "ready",
      queries: [normalized],
    };
  }

  const planned = buildProviderQueryPlanRecursive(normalized, 0);
  if (planned.kind === "degraded") {
    return planned;
  }

  const queries = dedupeStrings(
    planned.queries
      .map((entry) => normalizeProviderQuery(entry))
      .filter((entry) => entry.length > 0),
  );
  if (queries.length === 0) {
    return buildQueryPlanDegradedResult();
  }

  return {
    kind: "ready",
    queries,
  };
}

function buildProviderQueryPlanRecursive(query: string, depth: number): QueryPlanResult {
  const normalized = normalizeProviderQuery(query);
  if (normalized.length <= TAVILY_MAX_QUERY_CHARS) {
    return {
      kind: "ready",
      queries: [normalized],
    };
  }
  if (depth >= 3) {
    return buildQueryPlanDegradedResult();
  }

  const atoms = splitTopLevelAtoms(normalized);
  if (atoms.length === 0) {
    return buildQueryPlanDegradedResult();
  }

  const splitOnOrGroup = trySplitLargestOrGroup(atoms, depth);
  if (splitOnOrGroup !== undefined) {
    return splitOnOrGroup;
  }

  const fallback = splitAtomsIntoQueries(atoms, depth);
  if (fallback.kind === "degraded") {
    return fallback;
  }
  if (fallback.queries.length > 1) {
    return fallback;
  }

  return buildQueryPlanDegradedResult();
}

function trimDanglingQuerySuffix(query: string): string {
  let next = query.trim().replace(/\s+(?:AND|OR|NOT)$/iu, "").trim();
  next = next.replace(/[-(|]+$/u, "").trim();

  const quoteMatches = next.match(/"/gu);
  if ((quoteMatches?.length ?? 0) % 2 === 1) {
    const lastQuote = next.lastIndexOf("\"");
    if (lastQuote >= 0) {
      next = next.slice(0, lastQuote).trim();
    }
  }

  return next;
}

function splitTopLevelAtoms(query: string): string[] {
  const rawAtoms: string[] = [];
  let current = "";
  let depth = 0;
  let inQuote = false;

  for (let index = 0; index < query.length; index += 1) {
    const char = query[index] ?? "";
    if (char === "\"") {
      inQuote = !inQuote;
      current += char;
      continue;
    }
    if (inQuote === false) {
      if (char === "(") {
        depth += 1;
        current += char;
        continue;
      }
      if (char === ")" && depth > 0) {
        depth -= 1;
        current += char;
        continue;
      }
      if (/\s/u.test(char) && depth === 0) {
        const trimmed = current.trim();
        if (trimmed.length > 0) {
          rawAtoms.push(trimmed);
          current = "";
        }
        continue;
      }
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    rawAtoms.push(trimmed);
  }

  const atoms: string[] = [];
  for (let index = 0; index < rawAtoms.length; index += 1) {
    const atom = rawAtoms[index] ?? "";
    if (/^NOT$/iu.test(atom)) {
      const nextAtom = rawAtoms[index + 1];
      if (typeof nextAtom === "string" && nextAtom.trim().length > 0) {
        atoms.push(`NOT ${nextAtom.trim()}`);
        index += 1;
        continue;
      }
    }
    atoms.push(atom);
  }

  return atoms;
}

function trySplitLargestOrGroup(atoms: string[], depth: number): QueryPlanResult | undefined {
  const candidateIndexes = atoms
    .map((atom, index) => ({ atom, index }))
    .filter(({ atom }) => splitTopLevelOrClauses(atom) !== undefined)
    .sort((left, right) => right.atom.length - left.atom.length);

  for (const candidate of candidateIndexes) {
    const clauses = splitTopLevelOrClauses(candidate.atom);
    if (clauses === undefined || clauses.length <= 1) {
      continue;
    }

    const groups: string[][] = [];
    let currentGroup: string[] = [];
    for (const clause of clauses) {
      const nextGroup = [...currentGroup, clause];
      const candidateAtom = wrapOrGroup(nextGroup);
      const candidateAtoms = replaceAtom(atoms, candidate.index, candidateAtom);
      const candidateQuery = joinAtoms(candidateAtoms);

      if (currentGroup.length > 0 && candidateQuery.length > TAVILY_MAX_QUERY_CHARS) {
        groups.push(currentGroup);
        currentGroup = [clause];
        continue;
      }

      currentGroup = nextGroup;
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    if (groups.length <= 1) {
      continue;
    }

    const planned = mergeQueryPlanResults(
      groups.map((group) =>
        buildProviderQueryPlanRecursive(joinAtoms(replaceAtom(atoms, candidate.index, wrapOrGroup(group))), depth + 1),
      ),
    );
    if (planned.kind === "degraded") {
      return planned;
    }
    if (planned.queries.length > 1) {
      return planned;
    }
  }

  return ;
}

function splitTopLevelOrClauses(atom: string): string[] | undefined {
  if (atom.startsWith("(") === false || atom.endsWith(")") === false) {
    return ;
  }

  const inner = atom.slice(1, -1).trim();
  if (inner.length === 0) {
    return ;
  }

  const clauses: string[] = [];
  let current = "";
  let depth = 0;
  let inQuote = false;

  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? "";
    if (char === "\"") {
      inQuote = !inQuote;
      current += char;
      continue;
    }
    if (inQuote === false) {
      if (char === "(") {
        depth += 1;
        current += char;
        continue;
      }
      if (char === ")" && depth > 0) {
        depth -= 1;
        current += char;
        continue;
      }
      if (depth === 0 && inner.slice(index, index + 4) === " OR ") {
        const trimmed = current.trim();
        if (trimmed.length > 0) {
          clauses.push(trimmed);
        }
        current = "";
        index += 3;
        continue;
      }
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    clauses.push(trimmed);
  }

  return clauses.length > 1 ? clauses : undefined;
}

function splitAtomsIntoQueries(atoms: string[], depth: number): QueryPlanResult {
  const negativeAtoms = atoms.filter((atom) => isNegativeAtom(atom));
  const positiveAtoms = atoms.filter((atom) => isNegativeAtom(atom) === false);
  if (positiveAtoms.length <= 1) {
    return {
      kind: "ready",
      queries: [joinAtoms(atoms)],
    };
  }

  const queries: string[] = [];
  let currentPositive: string[] = [];
  for (const atom of positiveAtoms) {
    const candidateQuery = joinAtoms([...currentPositive, atom, ...negativeAtoms]);
    if (currentPositive.length > 0 && candidateQuery.length > TAVILY_MAX_QUERY_CHARS) {
      queries.push(joinAtoms([...currentPositive, ...negativeAtoms]));
      currentPositive = [atom];
      continue;
    }
    currentPositive = [...currentPositive, atom];
  }

  if (currentPositive.length > 0) {
    queries.push(joinAtoms([...currentPositive, ...negativeAtoms]));
  }

  return mergeQueryPlanResults(queries.map((entry) => buildProviderQueryPlanRecursive(entry, depth + 1)));
}

function isNegativeAtom(atom: string): boolean {
  return atom.startsWith("-") || /^NOT\b/iu.test(atom);
}

function wrapOrGroup(clauses: string[]): string {
  if (clauses.length === 1) {
    return clauses[0] ?? "";
  }
  return `(${clauses.join(" OR ")})`;
}

function replaceAtom(atoms: string[], index: number, replacement: string): string[] {
  return atoms.map((atom, atomIndex) => (atomIndex === index ? replacement : atom));
}

function joinAtoms(atoms: string[]): string {
  return atoms
    .map((atom) => atom.trim())
    .filter((atom) => atom.length > 0)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

function mergeQueryPlanResults(results: QueryPlanResult[]): QueryPlanResult {
  for (const result of results) {
    if (result.kind === "degraded") {
      return result;
    }
  }

  return {
    kind: "ready",
    queries: results.flatMap((result) => (result.kind === "ready" ? result.queries : [])),
  };
}

function buildQueryPlanDegradedResult(): QueryPlanResult {
  return {
    kind: "degraded",
    degraded: {
      code: "query_too_complex",
      message: `Query exceeds Tavily's ${TAVILY_MAX_QUERY_CHARS}-character limit and could not be split without truncation. Narrow the query and retry.`,
      recoverable: true,
    },
  };
}

function mergeQueryFanoutResults<TData extends { query: string }, TResult extends { url: string }>(
  responses: InternetProviderCallResult<TData>[],
  limit: number,
  readResults: (data: TData) => TResult[],
  buildData: (merged: TResult[]) => TData,
): InternetProviderCallResult<TData> {
  const deduped = dedupeByUrl(responses.flatMap((response) => readResults(response.data))).slice(0, limit);
  const degraded = responses.find((response) => response.degraded !== undefined)?.degraded;
  return {
    status: degraded === undefined ? "ok" : "degraded",
    provider: "tavily",
    attempts: responses.reduce((sum, response) => sum + response.attempts, 0),
    ...(responses.find((response) => response.requestId !== undefined)?.requestId !== undefined
      ? { requestId: responses.find((response) => response.requestId !== undefined)?.requestId }
      : {}),
    ...(responses.some((response) => typeof response.responseTime === "number")
      ? {
          responseTime: responses.reduce((sum, response) => sum + (response.responseTime ?? 0), 0),
        }
      : {}),
    ...(mergeUsage(responses.map((response) => response.usage)) !== undefined
      ? { usage: mergeUsage(responses.map((response) => response.usage)) }
      : {}),
    data: buildData(deduped),
    ...(degraded !== undefined ? { degraded } : {}),
  };
}

function mergeUsage(values: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
  const present = values.filter((value): value is Record<string, unknown> => value !== undefined);
  if (present.length === 0) {
    return ;
  }
  const credits = present
    .map((value) => (typeof value.credits === "number" ? value.credits : 0))
    .reduce((sum, value) => sum + value, 0);
  return credits > 0 ? { credits } : present[0];
}

function dedupeByUrl<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    const key = item.url.trim();
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function normalizeImageResults(
  images: Array<{ url: string; description?: string | undefined }>,
  limit: number,
): InternetImageResultItem[] {
  return images
    .map((image) => ({
      title:
        typeof image.description === "string" && image.description.trim().length > 0
          ? image.description.trim()
          : "Image",
      url: image.url.trim(),
      ...(deriveSource(image.url) !== undefined ? { source: deriveSource(image.url) } : {}),
    }))
    .filter((image) => image.url.length > 0)
    .slice(0, limit);
}

function normalizeExtractResponse(
  response: TavilyExtractResponse,
  maxChars: number,
  format: "markdown" | "text",
): InternetExtractOutput {
  return {
    results: response.results.map((result) => normalizeExtractResult(result, maxChars, format)),
    failedResults: response.failedResults.map((result) => ({
      url: result.url,
      error: result.error,
    })),
  };
}

function normalizeCrawlResponse(
  response: TavilyCrawlResponse,
  maxChars: number,
  format: "markdown" | "text",
): { baseUrl: string; results: InternetFetchResult[] } {
  return {
    baseUrl: response.baseUrl,
    results: response.results.map((result) => normalizeExtractResult(result, maxChars, format)),
  };
}

function normalizeExtractResult(
  firstResult: { url: string; title?: string | null | undefined; rawContent: string; images?: string[] | undefined; favicon?: string | undefined },
  maxChars: number,
  format: "markdown" | "text",
): InternetFetchResult {
  const rawContent =
    typeof firstResult.rawContent === "string" ? firstResult.rawContent.trim() : "";
  const truncated = rawContent.length > maxChars;
  const clipped = rawContent.slice(0, maxChars);
  const cleaned = stripBoilerplateBlocks(clipped.trim());
  const content = cleaned.length > 0 ? cleaned : clipped.trim();
  const contentIssues = assessExtractedContentIssues(content, truncated);
  return {
    url: firstResult.url,
    ...(typeof firstResult.title === "string" && firstResult.title.trim().length > 0
      ? { title: firstResult.title.trim() }
      : {}),
    content,
    contentType: format === "markdown" ? "text/markdown" : "text/plain",
    charCount: content.length,
    truncated,
    quality: classifyExtractionQuality(content, contentIssues),
    ...(Array.isArray(firstResult.images) && firstResult.images.length > 0 ? { images: firstResult.images } : {}),
    ...(typeof firstResult.favicon === "string" && firstResult.favicon.trim().length > 0
      ? { favicon: firstResult.favicon.trim() }
      : {}),
    ...(contentIssues.length > 0 ? { contentIssues } : {}),
  };
}

function classifyRecoverableSdkFailure(error: unknown): RecoverableFailure | undefined {
  const message = (extractSdkErrorMessage(error) ?? "").toLowerCase();
  const status = extractStatusCode(error);
  const retryAfterSeconds = extractRetryAfterSeconds(error);

  if (status === 429 || message.includes("429")) {
    return {
      code: "provider_rate_limited",
      message: extractSdkErrorMessage(error) ?? "Provider request was rate limited.",
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }

  if ((status !== undefined && status >= 500 && status <= 599) || /\b5\d{2}\b/u.test(message)) {
    return {
      code: "provider_unavailable",
      message: extractSdkErrorMessage(error) ?? "Provider request failed due to service unavailability.",
    };
  }

  if (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("enotfound")
  ) {
    return {
      code: message.includes("timed out") || message.includes("timeout")
        ? "provider_timeout"
        : "provider_network_error",
      message: extractSdkErrorMessage(error) ?? "Provider request failed due to a transient network issue.",
    };
  }

  return ;
}

function extractStatusCode(error: unknown): number | undefined {
  const response = readResponseRecord(error);
  if (typeof response?.status === "number" && Number.isFinite(response.status)) {
    return response.status;
  }

  const message = extractSdkErrorMessage(error);
  if (message === undefined) {
    return ;
  }

  const match = message.match(/^(\d{3})\s+error:/iu);
  if (match === null) {
    return ;
  }

  const status = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(status) ? status : undefined;
}

function extractSdkErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }

  const response = readResponseRecord(error);
  const detail = asPlainObject(response?.data)?.detail;
  const detailError = asPlainObject(detail)?.error;
  if (typeof detailError === "string" && detailError.trim().length > 0) {
    return detailError;
  }

  const message = asPlainObject(error)?.message;
  return typeof message === "string" ? message : undefined;
}

function extractRetryAfterSeconds(error: unknown): number | undefined {
  const headers = readHeadersRecord(error);
  const value = readHeaderValue(headers, "retry-after");
  if (value === undefined) {
    return ;
  }

  const asInt = Number.parseInt(value, 10);
  if (Number.isFinite(asInt) && asInt >= 0) {
    return asInt;
  }

  const asDate = Date.parse(value);
  if (Number.isNaN(asDate)) {
    return ;
  }

  const deltaSeconds = Math.ceil((asDate - Date.now()) / 1000);
  return deltaSeconds > 0 ? deltaSeconds : 0;
}

function extractRequestId(error: unknown): string | undefined {
  const headers = readHeadersRecord(error);
  return (
    readHeaderValue(headers, "x-request-id") ??
    readHeaderValue(headers, "x-tavily-request-id") ??
    readHeaderValue(headers, "request-id")
  );
}

function readResponseRecord(error: unknown): Record<string, unknown> | undefined {
  return asPlainObject(asPlainObject(error)?.response);
}

function readHeadersRecord(error: unknown): Record<string, unknown> | undefined {
  return asPlainObject(readResponseRecord(error)?.headers);
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }

  return value as Record<string, unknown>;
}

function readHeaderValue(
  headers: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (headers === undefined) {
    return ;
  }

  for (const [candidate, value] of Object.entries(headers)) {
    if (candidate.toLowerCase() !== key.toLowerCase()) {
      continue;
    }
    return typeof value === "string" ? value : undefined;
  }

  return ;
}

function normalizeTimeRange(
  freshness: string | undefined,
): TavilySearchOptions["timeRange"] | undefined {
  if (freshness === undefined) {
    return ;
  }

  const normalized = freshness.trim().toLowerCase();
  if (
    normalized === "day" ||
    normalized === "week" ||
    normalized === "month" ||
    normalized === "year" ||
    normalized === "d" ||
    normalized === "w" ||
    normalized === "m" ||
    normalized === "y"
  ) {
    return normalized;
  }

  return ;
}

function deriveSource(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return ;
  }
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, candidate));
}

function millisecondsToSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function jitteredBackoffMs(attempt: number): number {
  const base = Math.min(2000, 250 * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 120);
  return base + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function stripBoilerplateBlocks(content: string): string {
  if (content.length === 0) {
    return "";
  }

  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "";
  }

  const startIndex = lines.findIndex((line) => isLikelyContentLine(line));
  const candidates = startIndex === -1 ? lines : lines.slice(startIndex);
  const filtered = candidates.filter((line) => !isBoilerplateOnlyLine(line));
  const result = filtered.length === 0 ? candidates : filtered;

  return result.join("\n").trim();
}

const BOILERPLATE_LINE_TERMS = [
  "privacy policy",
  "terms of service",
  "cookie",
  "sign in",
  "log in",
  "subscribe",
  "share this",
  "follow us",
  "contact us",
  "skip to content",
  "menu",
  "navigation",
  "search this site",
  "latest headlines",
  "breaking news",
];

function isLikelyContentLine(line: string): boolean {
  if (line.length >= 60) {
    return true;
  }
  if (/[.!?]/u.test(line)) {
    return true;
  }
  const words = line.split(/\s+/u).filter((word) => word.length > 0);
  if (words.length >= 4 && words.some((word) => /[a-z]/iu.test(word))) {
    return true;
  }
  return false;
}

function isBoilerplateOnlyLine(line: string): boolean {
  const lower = line.toLowerCase();
  if (BOILERPLATE_LINE_TERMS.some((term) => lower.includes(term))) {
    return true;
  }
  if (/^[\p{P}\s]+$/u.test(line)) {
    return true;
  }
  if (line.length <= 3 && /^[A-Z]+$/u.test(line)) {
    return true;
  }
  if (line.length <= 20 && /^[A-Z0-9\-\s]+$/u.test(line) && /menu|nav/.test(lower)) {
    return true;
  }
  return false;
}

function assessExtractedContentIssues(
  content: string,
  truncated: boolean,
): InternetExtractionContentIssue[] {
  const issues = new Set<InternetExtractionContentIssue>();
  if (content.length === 0) {
    issues.add("empty_content");
  }
  if (truncated) {
    issues.add("truncated_content");
  }
  if (content.length > 0 && hasLowTextDensity(content)) {
    issues.add("low_text_density");
  }
  if (content.length > 0 && isBoilerplateHeavy(content)) {
    issues.add("boilerplate_heavy");
  }
  return [...issues];
}

function classifyExtractionQuality(
  content: string,
  issues: InternetExtractionContentIssue[],
): "high" | "medium" | "low" {
  if (issues.includes("empty_content")) {
    return "low";
  }
  if (issues.includes("boilerplate_heavy") || issues.includes("low_text_density")) {
    return "low";
  }
  const truncated = issues.includes("truncated_content");
  if (truncated && content.length === 0) {
    return "low";
  }
  if (content.length < 600) {
    return "medium";
  }
  return "high";
}

function hasLowTextDensity(content: string): boolean {
  const compact = content.replace(/\s+/gu, " ").trim();
  if (compact.length === 0) {
    return true;
  }
  const alphaChars = [...compact].filter((char) => /\p{L}/u.test(char)).length;
  const density = alphaChars / compact.length;
  return density < 0.55;
}

function isBoilerplateHeavy(content: string): boolean {
  const lower = content.toLowerCase();
  const boilerplateTerms = [
    "privacy policy",
    "terms of service",
    "cookie",
    "sign in",
    "log in",
    "subscribe",
    "all rights reserved",
    "share this",
    "follow us",
    "contact us",
    "skip to content",
    "menu",
    "navigation",
  ];
  const hits = boilerplateTerms.filter((term) => lower.includes(term)).length;
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const shortLines = lines.filter((line) => line.length <= 24).length;
  return hits >= 2 || (lines.length >= 10 && shortLines / lines.length >= 0.45);
}

function coalesceNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return ;
}

export type {
  TavilyCrawlOptions,
  TavilyCrawlResponse,
  TavilyExtractOptions,
  TavilyExtractResponse,
  TavilyMapOptions,
  TavilyMapResponse,
  TavilyResearchOptions,
  TavilyResearchResponse,
  TavilySearchOptions,
  TavilySearchResponse,
};
