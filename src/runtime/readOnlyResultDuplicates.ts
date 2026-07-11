import { createHash } from "node:crypto";

import { normalizeSourceCluster } from "./webExtraction.js";

const TRACKING_QUERY_KEYS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "utm_campaign",
  "utm_content",
  "utm_id",
  "utm_medium",
  "utm_source",
  "utm_term",
]);

export type ReadOnlyResultDuplicateKind =
  | "fresh_result"
  | "duplicate_cached_result"
  | "duplicate_executed_result";

export type ReadOnlyResultDuplicateFamily =
  | "web_search_results"
  | "web_page_content"
  | "source_search_results"
  | "source_page_content";

export interface ReadOnlyResultDuplicateLedgerEntry {
  fingerprint: string;
  family: ReadOnlyResultDuplicateFamily;
  toolName: string;
  canonicalSource?: string | undefined;
  canonicalUrl?: string | undefined;
  count: number;
  firstSeenStep: number;
  lastSeenStep: number;
  matchedPriorStep?: number | undefined;
  updatedAt: string;
}

export interface ReadOnlyResultDuplicateVerdict {
  kind: ReadOnlyResultDuplicateKind;
  fingerprint: string;
  family: ReadOnlyResultDuplicateFamily;
  toolName: string;
  duplicateCount: number;
  matchedPriorStep?: number | undefined;
  canonicalSource?: string | undefined;
  canonicalUrl?: string | undefined;
}

export function detectReadOnlyResultDuplicate(input: {
  toolName: string;
  output: unknown;
  ledger: ReadonlyArray<ReadOnlyResultDuplicateLedgerEntry>;
}): ReadOnlyResultDuplicateVerdict | undefined {
  const candidate = fingerprintReadOnlyResult({
    toolName: input.toolName,
    output: input.output,
  });
  if (candidate === undefined) {
    return undefined;
  }
  const prior = input.ledger.find((entry) => entry.fingerprint === candidate.fingerprint);
  return {
    kind: prior === undefined ? "fresh_result" : "duplicate_executed_result",
    ...candidate,
    duplicateCount: (prior?.count ?? 0) + 1,
    ...(prior?.lastSeenStep !== undefined ? { matchedPriorStep: prior.lastSeenStep } : {}),
  };
}

export function fingerprintReadOnlyResult(input: {
  toolName: string;
  output: unknown;
}): Omit<ReadOnlyResultDuplicateVerdict, "kind" | "duplicateCount" | "matchedPriorStep"> | undefined {
  if (
    input.toolName === "internet.search" ||
    input.toolName === "internet.search_advanced" ||
    input.toolName === "internet.news" ||
    input.toolName === "internet.map" ||
    input.toolName === "internet.research"
  ) {
    return fingerprintListResult(input.toolName, input.output);
  }
  if (input.toolName === "source.search" || input.toolName === "source.triage") {
    return fingerprintSourceListResult(input.toolName, input.output);
  }
  if (input.toolName === "internet.extract" || input.toolName === "internet.crawl") {
    return fingerprintPageResult(input.toolName, input.output);
  }
  if (input.toolName === "source.fetch") {
    return fingerprintSourcePageResult(input.toolName, input.output);
  }
  return undefined;
}

export function canonicalizeDuplicateUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string" || url.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.hostname.startsWith("www.")) {
      parsed.hostname = parsed.hostname.slice(4);
    }
    parsed.protocol = parsed.protocol.toLowerCase();
    const retained = [...parsed.searchParams.entries()]
      .filter(([key]) => TRACKING_QUERY_KEYS.has(key.toLowerCase()) === false)
      .sort(([left], [right]) => left.localeCompare(right));
    parsed.search = "";
    for (const [key, value] of retained) {
      parsed.searchParams.append(key, value);
    }
    if (parsed.pathname.endsWith("/") && parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function fingerprintListResult(
  toolName: string,
  output: unknown,
): Omit<ReadOnlyResultDuplicateVerdict, "kind" | "duplicateCount" | "matchedPriorStep"> | undefined {
  const record = asRecord(output);
  if (record === undefined) {
    return undefined;
  }
  const rawResults = asArray(record.results);
  const fallbackResults = asArray(record.sources);
  const results = (rawResults.length > 0 ? rawResults : fallbackResults.length > 0 ? fallbackResults : asArray(record.highlights))
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .slice(0, 8)
    .map((entry) => {
      const canonicalUrl = canonicalizeDuplicateUrl(asString(entry.url));
      return {
        title: normalizeText(asString(entry.title)),
        source: normalizeText(asString(entry.source))
          ?? normalizeText(asString(entry.sourceType))
          ?? normalizeText(readHostname(canonicalUrl)),
        url: canonicalUrl ?? normalizeText(asString(entry.url)),
      };
    })
    .filter((entry) => entry.title !== undefined || entry.source !== undefined || entry.url !== undefined);
  if (results.length === 0) {
    return undefined;
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(results))
    .digest("hex")
    .slice(0, 16);
  const canonicalSource = results[0]?.source;
  const canonicalUrl = results[0]?.url;
  return {
    fingerprint,
    family: "web_search_results",
    toolName,
    ...(canonicalSource !== undefined ? { canonicalSource } : {}),
    ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
  };
}

function fingerprintSourceListResult(
  toolName: string,
  output: unknown,
): Omit<ReadOnlyResultDuplicateVerdict, "kind" | "duplicateCount" | "matchedPriorStep"> | undefined {
  const fingerprint = fingerprintListResult(toolName, output);
  if (fingerprint === undefined) {
    return undefined;
  }
  return {
    ...fingerprint,
    family: "source_search_results",
    ...(fingerprint.canonicalSource !== undefined ? { canonicalSource: fingerprint.canonicalSource } : {}),
    ...(fingerprint.canonicalUrl !== undefined ? { canonicalUrl: fingerprint.canonicalUrl } : {}),
  };
}

function fingerprintPageResult(
  toolName: string,
  output: unknown,
): Omit<ReadOnlyResultDuplicateVerdict, "kind" | "duplicateCount" | "matchedPriorStep"> | undefined {
  const record = asRecord(output);
  if (record === undefined) {
    return undefined;
  }
  const canonicalUrl = canonicalizeDuplicateUrl(asString(record.url));
  const canonicalSource = normalizeSourceCluster(canonicalUrl ?? asString(record.url));
  const contentSeed = [
    normalizeText(asString(record.title)),
    normalizeText(asString(record.summary)),
    normalizeText(asString(record.content)),
    normalizeText(asString(record.body)),
  ]
    .filter((item): item is string => item !== undefined)
    .join("\n")
    .slice(0, 2_000);
  if ((canonicalUrl ?? canonicalSource) === undefined || contentSeed.length === 0) {
    return undefined;
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        canonicalUrl,
        contentSeed,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return {
    fingerprint,
    family: "web_page_content",
    toolName,
    ...(canonicalSource !== undefined ? { canonicalSource } : {}),
    ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
  };
}

function fingerprintSourcePageResult(
  toolName: string,
  output: unknown,
): Omit<ReadOnlyResultDuplicateVerdict, "kind" | "duplicateCount" | "matchedPriorStep"> | undefined {
  const fingerprint = fingerprintPageResult(toolName, output);
  if (fingerprint === undefined) {
    return undefined;
  }
  return {
    ...fingerprint,
    family: "source_page_content",
    ...(fingerprint.canonicalSource !== undefined ? { canonicalSource: fingerprint.canonicalSource } : {}),
    ...(fingerprint.canonicalUrl !== undefined ? { canonicalUrl: fingerprint.canonicalUrl } : {}),
  };
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/\s+/gu, " ");
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function readHostname(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return undefined;
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
