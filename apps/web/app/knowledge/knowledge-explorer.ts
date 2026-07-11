export type SourceRecord = {
  id: string;
  type: "github" | "youtube";
  label: string;
  repo?: string | null;
  branch?: string | null;
  channelId?: string | null;
  handle?: string | null;
  updatedAt?: string;
};

export type SourcesResponse = {
  total: number;
  lastSyncAt?: number | null;
  snapshotRepo?: string | null;
  snapshotBranch?: string | null;
  github: { count: number; sources: SourceRecord[] };
  youtube: { count: number; sources: SourceRecord[] };
};

export type DocumentRecord = {
  id: string;
  uploaderUserId: string;
  title?: string | null;
  filename: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number;
  status: "uploaded" | "processing" | "ready" | "partial" | "failed";
  pageCount?: number | null;
  chunkCount: number;
  error?: string | null;
  extractionMetadata?: unknown;
  createdAt: string;
  updatedAt: string;
  uploaderName?: string | null;
  latestRun?: {
    id: string;
    stage: "upload" | "extract" | "chunk" | "embed" | "complete";
    status: "queued" | "running" | "completed" | "failed";
    attemptCount: number;
    startedAt?: string | null;
    finishedAt?: string | null;
    updatedAt: string;
    error?: string | null;
    diagnostics?: unknown;
  } | null;
};

export type DocumentsResponse = {
  total: number;
  readyCount: number;
  partialCount: number;
  failedCount: number;
  processingCount: number;
  documents: DocumentRecord[];
  runtime: {
    storage: {
      provider: "local" | "local-s3" | "s3" | "r2";
      configured: boolean;
    };
    embeddingMode: "live" | "fallback";
    ocrMode: "live" | "fallback";
    queue: {
      configured: boolean;
      available: boolean;
      workerRegistered: boolean;
      error?: string | null;
    };
  };
};

export type SourceForm = {
  id: string;
  type: "github" | "youtube";
  label: string;
  repo: string;
  branch: string;
  channelId: string;
  handle: string;
};

export type ExtractedSource = {
  type: "github" | "youtube";
  label: string;
  repo?: string;
  branch?: string;
  channelId?: string;
  handle?: string;
  unsupportedReason?: string;
};

export type SourceExplorerItem = {
  kind: "source";
  item: SourceRecord;
  sortAt: number;
};

export type DocumentExplorerItem = {
  kind: "document";
  item: DocumentRecord;
  sortAt: number;
};

export type KnowledgeExplorerItem = SourceExplorerItem | DocumentExplorerItem;

export type KnowledgeExplorerFilters = {
  type: "all" | "source" | "document" | "github" | "youtube";
  name: string;
  details: string;
  status: "all" | "uploaded" | "processing" | "ready" | "partial" | "failed";
};

export const emptySourceForm: SourceForm = {
  id: "",
  type: "github",
  label: "",
  repo: "",
  branch: "main",
  channelId: "",
  handle: "",
};

export function getSourceForm(source?: SourceRecord | null): SourceForm {
  if (!source) {
    return emptySourceForm;
  }

  return {
    id: source.id,
    type: source.type,
    label: source.label,
    repo: source.repo || "",
    branch: source.branch || "main",
    channelId: source.channelId || "",
    handle: source.handle || "",
  };
}

export function buildKnowledgeExplorerItems(input: {
  sources: SourceRecord[];
  documents: DocumentRecord[];
}): KnowledgeExplorerItem[] {
  const sourceItems: SourceExplorerItem[] = input.sources.map((source) => ({
    kind: "source",
    item: source,
    sortAt: source.updatedAt ? new Date(source.updatedAt).getTime() : 0,
  }));

  const documentItems: DocumentExplorerItem[] = input.documents.map(
    (document) => ({
      kind: "document",
      item: document,
      sortAt: new Date(
        document.latestRun?.updatedAt || document.updatedAt
      ).getTime(),
    })
  );

  return [...sourceItems, ...documentItems].sort(
    (left, right) => right.sortAt - left.sortAt
  );
}

export function getKnowledgeExplorerItemName(item: KnowledgeExplorerItem) {
  if (item.kind === "source") {
    return item.item.label;
  }

  return item.item.title || item.item.filename;
}

export function getKnowledgeExplorerItemDetails(item: KnowledgeExplorerItem) {
  if (item.kind === "source") {
    if (item.item.type === "github") {
      return `${item.item.repo || "repo missing"} @ ${item.item.branch || "main"}`;
    }

    return item.item.channelId || item.item.handle || "channel missing";
  }

  return `${item.item.originalFilename} ${item.item.mediaType}`;
}

export function getKnowledgeExplorerItemTypeValue(item: KnowledgeExplorerItem) {
  if (item.kind === "source") {
    return item.item.type;
  }

  return "document";
}

export function filterKnowledgeExplorerItems(
  items: KnowledgeExplorerItem[],
  filters: KnowledgeExplorerFilters
) {
  const normalizedName = filters.name.trim().toLowerCase();
  const normalizedDetails = filters.details.trim().toLowerCase();

  return items.filter((item) => {
    const typeValue = getKnowledgeExplorerItemTypeValue(item);
    const name = getKnowledgeExplorerItemName(item).toLowerCase();
    const details = getKnowledgeExplorerItemDetails(item).toLowerCase();
    const status = item.kind === "document" ? item.item.status : null;

    const matchesType =
      filters.type === "all" ||
      (filters.type === "source" && item.kind === "source") ||
      (filters.type === "document" && item.kind === "document") ||
      filters.type === typeValue;

    const matchesName = !normalizedName || name.includes(normalizedName);
    const matchesDetails =
      !normalizedDetails || details.includes(normalizedDetails);
    const matchesStatus = filters.status === "all" || status === filters.status;

    return matchesType && matchesName && matchesDetails && matchesStatus;
  });
}
