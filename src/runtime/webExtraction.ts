type ExtractionQuality = "high" | "medium" | "low";
type SelectorCoverage = "full" | "partial" | "none";
type ContentIssue =
  | "empty_content"
  | "truncated_content"
  | "selector_unresolved"
  | "boilerplate_heavy"
  | "low_text_density";

export interface WebExtractionDiagnostics {
  toolName: string;
  url?: string | undefined;
  sourceCluster?: string | undefined;
  quality: ExtractionQuality;
  truncated: boolean;
  selectorCoverage?: SelectorCoverage | undefined;
  contentIssues: ContentIssue[];
  lowYield: boolean;
}

export interface WebExtractionRetryClusterSummary {
  key: string;
  sourceCluster: string;
  attempts: number;
  lowYieldAttempts: number;
  consecutiveLowYield: number;
  lastToolName?: string | undefined;
  lastQuality: ExtractionQuality;
  lastIssues: ContentIssue[];
  lastUrl?: string | undefined;
  searchFallbackUsed: boolean;
}

export interface WebExtractionRetrySummary {
  objectiveKey: string;
  latest?: WebExtractionDiagnostics | undefined;
  searchFallbackUsed: boolean;
  clusters: WebExtractionRetryClusterSummary[];
}

export function readWebExtractionDiagnostics(
  toolName: string | undefined,
  output: unknown,
): WebExtractionDiagnostics | undefined {
  if (toolName !== "internet.extract") {
    return ;
  }
  const record = asRecord(output);
  if (record === undefined) {
    return ;
  }

  const firstResult = asRecord(asArray(record.results)[0]);
  const payload = firstResult ?? record;
  const url = asString(payload.url);
  const quality = readQuality(payload.quality);
  const truncated = payload.truncated === true;
  const selectorCoverage = readSelectorCoverage(payload.selectorCoverage);
  const contentIssues = readContentIssues(payload.contentIssues);
  const lowYield =
    quality === "low" ||
    truncated ||
    selectorCoverage === "none" ||
    contentIssues.includes("boilerplate_heavy") ||
    contentIssues.includes("low_text_density") ||
    contentIssues.includes("selector_unresolved") ||
    contentIssues.includes("empty_content");

  return {
    toolName,
    ...(url !== undefined ? { url } : {}),
    ...(normalizeSourceCluster(url) !== undefined
      ? { sourceCluster: normalizeSourceCluster(url) }
      : {}),
    quality,
    truncated,
    ...(selectorCoverage !== undefined ? { selectorCoverage } : {}),
    contentIssues,
    lowYield,
  };
}

export function normalizeWebExtractionRetrySummary(
  value: unknown,
): WebExtractionRetrySummary | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return ;
  }
  const objectiveKey = asString(record.objectiveKey);
  if (objectiveKey === undefined) {
    return ;
  }

  const clusters = Array.isArray(record.clusters)
    ? record.clusters
        .map((entry) => normalizeRetryCluster(entry))
        .filter((entry): entry is WebExtractionRetryClusterSummary => entry !== undefined)
    : [];
  return {
    objectiveKey,
    ...(normalizeDiagnostics(record.latest) !== undefined
      ? { latest: normalizeDiagnostics(record.latest) }
      : {}),
    searchFallbackUsed: record.searchFallbackUsed === true,
    clusters,
  };
}

export function updateWebExtractionRetrySummary(input: {
  prior: unknown;
  objective: string | undefined;
  toolName: string | undefined;
  output: unknown;
  action?: unknown;
}): WebExtractionRetrySummary | undefined {
  const objectiveKey = normalizeObjectiveKey(input.objective);
  if (objectiveKey === undefined) {
    return ;
  }
  const prior = normalizeWebExtractionRetrySummary(input.prior) ?? {
    objectiveKey,
    searchFallbackUsed: false,
    clusters: [],
  };

  if (input.toolName === "internet.search") {
    const fallbackSourceCluster = readFallbackSourceCluster(input.action);
    const clusters =
      fallbackSourceCluster === undefined
        ? prior.clusters
        : prior.clusters.map((cluster) =>
            cluster.sourceCluster === fallbackSourceCluster && cluster.consecutiveLowYield >= 2
              ? {
                  ...cluster,
                  searchFallbackUsed: true,
                }
              : cluster,
          );
    return {
      ...prior,
      objectiveKey,
      searchFallbackUsed: clusters.some((cluster) => cluster.searchFallbackUsed),
      clusters,
    };
  }

  const diagnostics = readWebExtractionDiagnostics(input.toolName, input.output);
  if (diagnostics === undefined || diagnostics.sourceCluster === undefined) {
    return prior.objectiveKey === objectiveKey ? prior : { ...prior, objectiveKey };
  }

  const key = `${objectiveKey}:${diagnostics.sourceCluster}`;
  const clusters = [...prior.clusters];
  const existingIndex = clusters.findIndex((entry) => entry.key === key);
  const existing = existingIndex === -1 ? undefined : clusters[existingIndex];
  const nextEntry: WebExtractionRetryClusterSummary = {
    key,
    sourceCluster: diagnostics.sourceCluster,
    attempts: (existing?.attempts ?? 0) + 1,
    lowYieldAttempts: (existing?.lowYieldAttempts ?? 0) + (diagnostics.lowYield ? 1 : 0),
    consecutiveLowYield: diagnostics.lowYield ? (existing?.consecutiveLowYield ?? 0) + 1 : 0,
    ...(diagnostics.toolName.length > 0 ? { lastToolName: diagnostics.toolName } : {}),
    lastQuality: diagnostics.quality,
    lastIssues: diagnostics.contentIssues,
    ...(diagnostics.url !== undefined ? { lastUrl: diagnostics.url } : {}),
    searchFallbackUsed: diagnostics.lowYield ? existing?.searchFallbackUsed === true : false,
  };
  if (existingIndex === -1) {
    clusters.unshift(nextEntry);
  } else {
    clusters.splice(existingIndex, 1, nextEntry);
  }

  return {
    objectiveKey,
    latest: diagnostics,
    searchFallbackUsed: clusters.some((cluster) => cluster.searchFallbackUsed),
    clusters: clusters.slice(0, 8),
  };
}

export function normalizeSourceCluster(url: string | undefined): string | undefined {
  if (typeof url !== "string" || url.trim().length === 0) {
    return ;
  }
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./u, "");
    const firstPath = parsed.pathname
      .split("/")
      .map((segment) => segment.trim().toLowerCase())
      .filter((segment) => segment.length > 0)[0];
    return `${hostname}${firstPath !== undefined ? `/${firstPath}` : ""}`;
  } catch {
    return ;
  }
}

function normalizeObjectiveKey(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/\s+/gu, " ");
  if (normalized === undefined || normalized.length === 0) {
    return ;
  }
  return normalized.slice(0, 160);
}

function normalizeRetryCluster(value: unknown): WebExtractionRetryClusterSummary | undefined {
  const record = asRecord(value);
  const key = asString(record?.key);
  const sourceCluster = asString(record?.sourceCluster);
  const lastQuality = readQuality(record?.lastQuality);
  if (key === undefined || sourceCluster === undefined) {
    return ;
  }
  return {
    key,
    sourceCluster,
    attempts: readNonNegativeNumber(record?.attempts),
    lowYieldAttempts: readNonNegativeNumber(record?.lowYieldAttempts),
    consecutiveLowYield: readNonNegativeNumber(record?.consecutiveLowYield),
    ...(asString(record?.lastToolName) !== undefined
      ? { lastToolName: asString(record?.lastToolName) }
      : asString(record?.toolName) !== undefined
        ? { lastToolName: asString(record?.toolName) }
        : {}),
    lastQuality,
    lastIssues: readContentIssues(record?.lastIssues),
    ...(asString(record?.lastUrl) !== undefined ? { lastUrl: asString(record?.lastUrl) } : {}),
    searchFallbackUsed: record?.searchFallbackUsed === true,
  };
}

function readFallbackSourceCluster(value: unknown): string | undefined {
  const record = asRecord(value);
  const policyContext = asRecord(record?.policyContext);
  const sourceCluster = asString(policyContext?.webExtractionSourceCluster);
  return sourceCluster !== undefined ? sourceCluster : undefined;
}

function normalizeDiagnostics(value: unknown): WebExtractionDiagnostics | undefined {
  const record = asRecord(value);
  const toolName = asString(record?.toolName);
  if (toolName === undefined) {
    return ;
  }
  const quality = readQuality(record?.quality);
  return {
    toolName,
    ...(asString(record?.url) !== undefined ? { url: asString(record?.url) } : {}),
    ...(asString(record?.sourceCluster) !== undefined
      ? { sourceCluster: asString(record?.sourceCluster) }
      : {}),
    quality,
    truncated: record?.truncated === true,
    ...(readSelectorCoverage(record?.selectorCoverage) !== undefined
      ? { selectorCoverage: readSelectorCoverage(record?.selectorCoverage) }
      : {}),
    contentIssues: readContentIssues(record?.contentIssues),
    lowYield: record?.lowYield === true,
  };
}

function readQuality(value: unknown): ExtractionQuality {
  return value === "low" || value === "medium" || value === "high" ? value : "low";
}

function readSelectorCoverage(value: unknown): SelectorCoverage | undefined {
  return value === "full" || value === "partial" || value === "none" ? value : undefined;
}

function readContentIssues(value: unknown): ContentIssue[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value.filter(
    (item): item is ContentIssue =>
      item === "empty_content" ||
      item === "truncated_content" ||
      item === "selector_unresolved" ||
      item === "boilerplate_heavy" ||
      item === "low_text_density",
  );
}

function readNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
