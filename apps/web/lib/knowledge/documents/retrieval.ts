import {
  MEMORY_BACKEND_VERSION,
  MEMORY_QUERY_RESULT_VERSION,
  MEMORY_QUERY_VERSION,
  MEMORY_RECORD_PROVENANCE_VERSION,
  MemoryGateway,
  parseMemoryBackendV1,
  parseMemoryQueryResultV1,
  type MemoryBackendAdapterV1,
  type MemoryQueryResultItemV1,
  type MemoryQueryV1,
  type MemoryReadBindingV1,
  type MemoryReadContextV1,
  type MemoryScopeV1,
} from "@kestrel-agents/kestrel";
import { sql } from "drizzle-orm";
import { embedKnowledgeTexts, getKnowledgeEmbeddingRuntime } from "./embed";
import type { SemanticEmbeddingProvenance } from "./embedding-provenance";
import {
  groupKnowledgeRetrievalRows,
  type KnowledgeRetrievalHit,
  type RawKnowledgeRetrievalRow,
} from "./retrieval-grouping";

const DEFAULT_SCORE_THRESHOLD = 0.2;
const MAX_DOCUMENT_RESULTS = 12;
const MAX_EXCERPTS_PER_DOCUMENT = 3;
const RAW_RESULT_MULTIPLIER = 4;

type KnowledgeDocumentSearchInput = {
  binding: MemoryReadBindingV1;
  context: MemoryReadContextV1;
  scope: MemoryScopeV1;
  query: string;
  limit?: number;
  scoreThreshold?: number;
  documentIds?: string[];
};

type KnowledgeDocumentBackendSearchInput = {
  organizationId: string;
  query: string;
  limit?: number;
  scoreThreshold?: number;
  documentIds?: string[];
};

type KnowledgeLexicalSearchInput = {
  organizationId: string;
  query: string;
  limit: number;
  documentIds?: string[];
};

type KnowledgeVectorSearchInput = {
  organizationId: string;
  embedding: number[];
  rawLimit: number;
  documentIds?: string[];
  provenance: SemanticEmbeddingProvenance;
};

type KnowledgeSearchDependencies = {
  embeddingRuntime: ReturnType<typeof getKnowledgeEmbeddingRuntime>;
  embedQuery: (query: string) => Promise<number[]>;
  searchVector: (
    input: KnowledgeVectorSearchInput
  ) => Promise<RawKnowledgeRetrievalRow[]>;
  searchLexical: (
    input: KnowledgeLexicalSearchInput
  ) => Promise<KnowledgeRetrievalHit[]>;
  onQueryEmbeddingError?: (error: unknown) => void;
};

const HOSTED_KNOWLEDGE_BACKEND_ID = "kestrel-one:knowledge:drizzle-pgvector";

export function buildKnowledgeVectorSearchQuery(
  input: KnowledgeVectorSearchInput
) {
  const documentFilter = buildDocumentFilter(input.documentIds);
  const semanticProvenance = JSON.stringify({
    embedding: input.provenance,
  });

  return sql`
    select
      c.document_id as "documentId",
      d.filename as "filename",
      d.title as "title",
      d.media_type as "mediaType",
      c.content as "chunkText",
      c.chunk_index as "chunkIndex",
      c.page_number as "pageNumber",
      c.section_title as "sectionTitle",
      d.project_id as "projectId",
      d.uploader_user_id as "uploaderUserId",
      d.created_at as "createdAt",
      d.checksum_sha256 as "checksumSha256",
      greatest(0, 1 - (c.embedding <=> ${sql.raw(toVectorLiteral(input.embedding))}))::float as "score"
    from knowledge_document_chunks c
    inner join knowledge_documents d on d.id = c.document_id
    where
      c.organization_id = ${input.organizationId}
      and d.organization_id = ${input.organizationId}
      and d.status in ('ready', 'partial')
      and d.extraction_metadata @> ${semanticProvenance}::jsonb
      ${documentFilter}
    order by c.embedding <=> ${sql.raw(toVectorLiteral(input.embedding))}
    limit ${input.rawLimit};
  `;
}

function toVectorLiteral(values: number[]) {
  return `'[${values
    .map((value) => Number(value).toFixed(8))
    .join(",")}]'::vector`;
}

function tokenizeQuery(query: string) {
  const tokens = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
    )
  );

  return tokens.length > 0
    ? tokens
    : [query.trim().toLowerCase()].filter(Boolean);
}

async function searchKnowledgeDocumentsLexical(input: {
  organizationId: string;
  query: string;
  limit: number;
  documentIds?: string[];
}) {
  const { knowledgeDb } = await import("@/lib/knowledge/db");
  const tokens = tokenizeQuery(input.query);
  const scoreExpression =
    tokens.length === 0
      ? sql`0`
      : sql.join(
          tokens.map((token) => {
            const pattern = `%${token}%`;
            return sql`(
              case when lower(c.content) like ${pattern} then 3 else 0 end +
              case when lower(coalesce(c.section_title, '')) like ${pattern} then 2 else 0 end +
              case when lower(coalesce(d.title, '')) like ${pattern} then 4 else 0 end +
              case when lower(d.filename) like ${pattern} then 4 else 0 end
            )`;
          }),
          sql` + `
        );
  const normalizedScore = sql<number>`least(
    1.0,
    (${scoreExpression})::float / ${Math.max(tokens.length * 7, 1)}
  )`;
  const rawLimit = Math.min(
    input.limit * RAW_RESULT_MULTIPLIER,
    MAX_DOCUMENT_RESULTS * RAW_RESULT_MULTIPLIER
  );
  if (input.documentIds?.length === 0) {
    return [];
  }
  const documentFilter = buildDocumentFilter(input.documentIds);

  const result = await knowledgeDb.execute(sql`
    select
      c.document_id as "documentId",
      d.filename as "filename",
      d.title as "title",
      d.media_type as "mediaType",
      c.content as "chunkText",
      c.chunk_index as "chunkIndex",
      c.page_number as "pageNumber",
      c.section_title as "sectionTitle",
      d.project_id as "projectId",
      d.uploader_user_id as "uploaderUserId",
      d.created_at as "createdAt",
      d.checksum_sha256 as "checksumSha256",
      ${normalizedScore}::float as "score"
    from knowledge_document_chunks c
    inner join knowledge_documents d on d.id = c.document_id
    where
      c.organization_id = ${input.organizationId}
      and d.organization_id = ${input.organizationId}
      and d.status in ('ready', 'partial')
      ${documentFilter}
      and ${scoreExpression} > 0
    order by ${normalizedScore} desc, c.chunk_index asc
    limit ${rawLimit};
  `);

  return groupKnowledgeRetrievalRows(
    Array.from(result) as RawKnowledgeRetrievalRow[],
    {
      documentLimit: input.limit,
      excerptLimitPerDocument: MAX_EXCERPTS_PER_DOCUMENT,
      scoreThreshold: 0.1,
      retrievalStrategy: "lexical",
    }
  );
}

export async function searchKnowledgeDocumentsWithDependencies(
  input: KnowledgeDocumentBackendSearchInput,
  dependencies: KnowledgeSearchDependencies
) {
  const documentLimit = Math.min(
    Math.max(input.limit ?? 6, 1),
    MAX_DOCUMENT_RESULTS
  );
  if (input.documentIds?.length === 0) {
    return [];
  }

  const { embeddingRuntime } = dependencies;
  if (
    embeddingRuntime.retrievalStrategy === "lexical" ||
    !embeddingRuntime.provenance
  ) {
    return dependencies.searchLexical({
      organizationId: input.organizationId,
      query: input.query,
      limit: documentLimit,
      documentIds: input.documentIds,
    });
  }

  let embedding: number[];
  try {
    embedding = await dependencies.embedQuery(input.query);
  } catch (error) {
    dependencies.onQueryEmbeddingError?.(error);
    return dependencies.searchLexical({
      organizationId: input.organizationId,
      query: input.query,
      limit: documentLimit,
      documentIds: input.documentIds,
    });
  }

  const rawLimit = Math.min(
    documentLimit * RAW_RESULT_MULTIPLIER,
    MAX_DOCUMENT_RESULTS * RAW_RESULT_MULTIPLIER
  );
  const scoreThreshold = Math.max(
    0,
    Math.min(input.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD, 1)
  );
  const result = await dependencies.searchVector({
    organizationId: input.organizationId,
    embedding,
    rawLimit,
    documentIds: input.documentIds,
    provenance: embeddingRuntime.provenance,
  });

  const grouped = groupKnowledgeRetrievalRows(result, {
    documentLimit,
    excerptLimitPerDocument: MAX_EXCERPTS_PER_DOCUMENT,
    scoreThreshold,
    retrievalStrategy: "vector",
  });

  if (grouped.length > 0) {
    return grouped;
  }

  return dependencies.searchLexical({
    organizationId: input.organizationId,
    query: input.query,
    limit: documentLimit,
    documentIds: input.documentIds,
  });
}

function createHostedSearchDependencies(): KnowledgeSearchDependencies {
  return {
    embeddingRuntime: getKnowledgeEmbeddingRuntime(),
    embedQuery: async (query) => {
      const [embedding] = await embedKnowledgeTexts([query]);
      return embedding;
    },
    searchVector: async (vectorInput) => {
      const { knowledgeDb } = await import("@/lib/knowledge/db");
      const result = await knowledgeDb.execute(
        buildKnowledgeVectorSearchQuery(vectorInput)
      );
      return Array.from(result) as RawKnowledgeRetrievalRow[];
    },
    searchLexical: searchKnowledgeDocumentsLexical,
    onQueryEmbeddingError: (error) => {
      console.warn(
        "Knowledge vector query embedding failed; using lexical retrieval.",
        {
          message:
            error instanceof Error ? error.message : "Unknown embedding error",
        }
      );
    },
  };
}

export class HostedKnowledgeMemoryBackend implements MemoryBackendAdapterV1 {
  readonly descriptor;
  readonly #dependencies: KnowledgeSearchDependencies;

  constructor(input: {
    policyRevision: string;
    dependencies?: KnowledgeSearchDependencies;
  }) {
    this.descriptor = parseMemoryBackendV1({
      version: MEMORY_BACKEND_VERSION,
      backendId: HOSTED_KNOWLEDGE_BACKEND_ID,
      policyRevision: input.policyRevision,
      namespace: "semantic_knowledge",
      sourceOfTruth: "hosted_knowledge_store",
      strategies: ["vector", "lexical"],
    });
    this.#dependencies = input.dependencies ?? createHostedSearchDependencies();
  }

  async query(input: {
    binding: MemoryReadBindingV1;
    query: MemoryQueryV1;
  }) {
    const hits = await searchKnowledgeDocumentsWithDependencies(
      {
        organizationId: input.query.scope.tenantId,
        query: input.query.text,
        limit: input.query.limit,
        scoreThreshold: input.query.minimumMatchScore,
        documentIds: input.query.documentIds,
      },
      this.#dependencies
    );
    return parseMemoryQueryResultV1({
      version: MEMORY_QUERY_RESULT_VERSION,
      queryId: input.query.queryId,
      bindingId: input.binding.bindingId,
      backendId: this.descriptor.backendId,
      policyRevision: this.descriptor.policyRevision,
      items: hits.map((hit) => toMemoryResultItem(hit, input.query.scope)),
    });
  }
}

export async function searchKnowledgeDocuments(
  input: KnowledgeDocumentSearchInput
) {
  const gateway = new MemoryGateway();
  const result = await gateway.query({
    context: input.context,
    binding: input.binding,
    query: {
      version: MEMORY_QUERY_VERSION,
      queryId: crypto.randomUUID(),
      namespace: "semantic_knowledge",
      scope: input.scope,
      text: input.query,
      limit: input.limit ?? 6,
      ...(input.documentIds === undefined
        ? {}
        : { documentIds: input.documentIds }),
      ...(input.scoreThreshold === undefined
        ? {}
        : { minimumMatchScore: input.scoreThreshold }),
    },
    backend: new HostedKnowledgeMemoryBackend({
      policyRevision: input.context.policyRevision,
    }),
  });
  return result.items.map(fromMemoryResultItem);
}

function toMemoryResultItem(
  hit: KnowledgeRetrievalHit,
  scope: MemoryScopeV1
): MemoryQueryResultItemV1 {
  if (!hit.uploaderUserId) {
    throw new Error("Hosted knowledge retrieval row is missing provenance.");
  }
  if (!hit.createdAt) {
    throw new Error("Hosted knowledge retrieval row is missing provenance.");
  }
  if (!hit.checksumSha256) {
    throw new Error("Hosted knowledge retrieval row is missing provenance.");
  }
  if (!hit.retrievalStrategy) {
    throw new Error("Hosted knowledge retrieval row is missing provenance.");
  }
  const retrievalStrategy = hit.retrievalStrategy;
  const createdAt =
    hit.createdAt instanceof Date
      ? hit.createdAt.toISOString()
      : new Date(hit.createdAt).toISOString();
  return {
    recordId: hit.documentId,
    provenance: {
      version: MEMORY_RECORD_PROVENANCE_VERSION,
      recordId: hit.documentId,
      namespace: "semantic_knowledge",
      source: {
        kind: "document",
        referenceId: hit.documentId,
        revision: hit.checksumSha256,
      },
      creator: { kind: "user", id: hit.uploaderUserId },
      createdAt,
      scope,
      confidence: {
        kind: "asserted_source",
        sourceReferenceId: hit.documentId,
      },
    },
    segments: hit.excerpts.map((excerpt) => {
      const citation = hit.citations.find(
        (candidate) =>
          candidate.pageNumber === excerpt.pageNumber &&
          candidate.sectionTitle === excerpt.sectionTitle
      );
      return {
        segmentId: `${hit.documentId}:${excerpt.chunkIndex}`,
        text: excerpt.text,
        location: {
          label: citation?.label ?? hit.title ?? hit.filename,
          url: citation?.url ?? hit.url,
          ...(excerpt.pageNumber === null
            ? {}
            : { pageNumber: excerpt.pageNumber }),
          ...(excerpt.sectionTitle === null
            ? {}
            : { sectionTitle: excerpt.sectionTitle }),
        },
        matchEvidence: {
          strategy: retrievalStrategy,
          score: excerpt.score,
        },
      };
    }),
    sourceMetadata: {
      filename: hit.filename,
      ...(hit.title === null ? {} : { title: hit.title }),
      mediaType: hit.mediaType,
      excerptCount: hit.excerptCount,
    },
  };
}

function fromMemoryResultItem(item: MemoryQueryResultItemV1): KnowledgeRetrievalHit {
  const firstStrategy = item.segments[0]!.matchEvidence.strategy;
  return {
    documentId: item.recordId,
    filename: item.sourceMetadata.filename,
    title: item.sourceMetadata.title ?? null,
    mediaType: item.sourceMetadata.mediaType,
    url: item.segments[0]!.location.url,
    maxScore: Math.max(...item.segments.map((segment) => segment.matchEvidence.score)),
    excerptCount: item.sourceMetadata.excerptCount,
    excerpts: item.segments.map((segment) => ({
      chunkIndex: Number.parseInt(segment.segmentId.slice(segment.segmentId.lastIndexOf(":") + 1), 10),
      text: segment.text,
      pageNumber: segment.location.pageNumber ?? null,
      sectionTitle: segment.location.sectionTitle ?? null,
      score: segment.matchEvidence.score,
    })),
    citations: item.segments.map((segment) => ({
      label: segment.location.label,
      url: segment.location.url,
      pageNumber: segment.location.pageNumber ?? null,
      sectionTitle: segment.location.sectionTitle ?? null,
    })),
    retrievalStrategy: firstStrategy,
    uploaderUserId: item.provenance.creator.id,
    createdAt: item.provenance.createdAt,
    checksumSha256: item.provenance.source.revision,
    projectId:
      item.provenance.scope.kind === "project"
        ? item.provenance.scope.projectId
        : null,
  };
}

function buildDocumentFilter(documentIds: string[] | undefined) {
  if (!documentIds) {
    return sql`and d.scope = 'organization' and d.project_id is null and d.archived_at is null`;
  }
  return sql`and d.archived_at is null and d.id in (${sql.join(
    documentIds.map((documentId) => sql`${documentId}`),
    sql`, `
  )})`;
}
