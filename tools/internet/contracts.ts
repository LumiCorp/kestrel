import type { TavilySearchCountry } from "./countries.js";

export type InternetToolStatus = "ok" | "degraded";

export interface InternetDegradedState {
  code: string;
  message: string;
  retryAfterSeconds?: number | undefined;
  recoverable: true;
}

export interface InternetEnvelope {
  status: InternetToolStatus;
  provider: "tavily";
  attempts: number;
  requestId?: string | undefined;
  responseTime?: number | undefined;
  usage?: InternetUsageCredits | undefined;
  degraded?: InternetDegradedState | undefined;
}

export interface InternetSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  score?: number | undefined;
  publishedAt?: string | undefined;
  favicon?: string | undefined;
  rawContent?: string | undefined;
  source?: string | undefined;
}

export interface InternetImageResultItem {
  title: string;
  url: string;
  thumbnailUrl?: string | undefined;
  source?: string | undefined;
}

export interface InternetFetchResult {
  url: string;
  title?: string | undefined;
  content: string;
  contentType: string;
  charCount: number;
  truncated?: boolean | undefined;
  quality?: InternetExtractionQuality | undefined;
  contentIssues?: InternetExtractionContentIssue[] | undefined;
  images?: string[] | undefined;
  favicon?: string | undefined;
}

export type InternetExtractionQuality = "high" | "medium" | "low";

export type InternetExtractionContentIssue =
  | "empty_content"
  | "truncated_content"
  | "selector_unresolved"
  | "boilerplate_heavy"
  | "low_text_density";

export interface InternetProviderCallResult<T> extends InternetEnvelope {
  data: T;
}

export interface InternetUsageCredits {
  credits?: number | undefined;
  [key: string]: unknown;
}

export interface InternetSearchInput {
  query: string;
  limit: number;
  freshness?: string | undefined;
}

export interface InternetAdvancedSearchInput extends InternetSearchInput {
  topic?: "general" | "news" | "finance" | undefined;
  searchDepth?: "basic" | "advanced" | "fast" | "ultra-fast" | undefined;
  chunksPerSource?: number | undefined;
  days?: number | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  country?: TavilySearchCountry | undefined;
  includeAnswer?: boolean | "basic" | "advanced" | undefined;
  includeRawContent?: false | "markdown" | "text" | undefined;
  includeFavicon?: boolean | undefined;
  includeUsage?: boolean | undefined;
  exactMatch?: boolean | undefined;
  domainAllow?: string[] | undefined;
  domainDeny?: string[] | undefined;
}

export interface InternetNewsInput {
  query: string;
  limit: number;
  freshness?: string | undefined;
}

export interface InternetImagesInput {
  query: string;
  limit: number;
}

export interface InternetExtractInput {
  urls: string[];
  maxChars: number;
  query?: string | undefined;
  chunksPerSource?: number | undefined;
  extractDepth?: "basic" | "advanced" | undefined;
  format?: "markdown" | "text" | undefined;
  includeImages?: boolean | undefined;
  includeFavicon?: boolean | undefined;
  includeUsage?: boolean | undefined;
}

export interface InternetExtractFailedResult {
  url: string;
  error: string;
}

export interface InternetExtractOutput {
  results: InternetFetchResult[];
  failedResults: InternetExtractFailedResult[];
}

export interface InternetCrawlInput {
  url: string;
  instructions?: string | undefined;
  maxDepth?: number | undefined;
  maxBreadth?: number | undefined;
  limit?: number | undefined;
  selectPaths?: string[] | undefined;
  selectDomains?: string[] | undefined;
  excludePaths?: string[] | undefined;
  excludeDomains?: string[] | undefined;
  allowExternal?: boolean | undefined;
  extractDepth?: "basic" | "advanced" | undefined;
  format?: "markdown" | "text" | undefined;
  includeImages?: boolean | undefined;
  includeFavicon?: boolean | undefined;
  includeUsage?: boolean | undefined;
  chunksPerSource?: number | undefined;
  maxChars: number;
}

export interface InternetCrawlOutput {
  baseUrl: string;
  results: InternetFetchResult[];
}

export interface InternetMapInput {
  url: string;
  instructions?: string | undefined;
  maxDepth?: number | undefined;
  maxBreadth?: number | undefined;
  limit?: number | undefined;
  selectPaths?: string[] | undefined;
  selectDomains?: string[] | undefined;
  excludePaths?: string[] | undefined;
  excludeDomains?: string[] | undefined;
  allowExternal?: boolean | undefined;
  includeUsage?: boolean | undefined;
}

export interface InternetMapOutput {
  baseUrl: string;
  results: string[];
}

export interface InternetResearchInput {
  input: string;
  model?: "mini" | "pro" | "auto" | undefined;
  outputSchema?: Record<string, unknown> | undefined;
  citationFormat?: "numbered" | "mla" | "apa" | "chicago" | undefined;
  waitForCompletion: boolean;
  maxWaitMs: number;
  pollIntervalMs: number;
}

export interface InternetResearchStatusInput {
  requestId: string;
}

export interface InternetResearchOutput {
  requestId: string;
  createdAt?: string | undefined;
  status: string;
  input?: string | undefined;
  model?: string | undefined;
  content?: string | Record<string, unknown> | undefined;
  sources?: Array<{ title: string; url: string }> | undefined;
}

export interface InternetUsageOutput {
  key?: Record<string, unknown> | undefined;
  account?: Record<string, unknown> | undefined;
}

export interface TavilyInternetProvider {
  search(input: InternetSearchInput): Promise<InternetProviderCallResult<{ query: string; results: InternetSearchResultItem[] }>>;
  searchAdvanced(input: InternetAdvancedSearchInput): Promise<InternetProviderCallResult<{ query: string; answer?: string; results: InternetSearchResultItem[] }>>;
  news(input: InternetNewsInput): Promise<InternetProviderCallResult<{ query: string; results: InternetSearchResultItem[] }>>;
  images(input: InternetImagesInput): Promise<InternetProviderCallResult<{ query: string; results: InternetImageResultItem[] }>>;
  extract(input: InternetExtractInput): Promise<InternetProviderCallResult<InternetExtractOutput>>;
  crawl(input: InternetCrawlInput): Promise<InternetProviderCallResult<InternetCrawlOutput>>;
  map(input: InternetMapInput): Promise<InternetProviderCallResult<InternetMapOutput>>;
  research(input: InternetResearchInput): Promise<InternetProviderCallResult<InternetResearchOutput>>;
  researchStatus(input: InternetResearchStatusInput): Promise<InternetProviderCallResult<InternetResearchOutput>>;
  usage(): Promise<InternetProviderCallResult<InternetUsageOutput>>;
}
