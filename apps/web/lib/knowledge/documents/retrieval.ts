import { sql } from "drizzle-orm";
import { embedKnowledgeTexts, getKnowledgeEmbeddingRuntime } from "./embed";
import {
  groupKnowledgeRetrievalRows,
  type RawKnowledgeRetrievalRow,
} from "./retrieval-grouping";

const DEFAULT_SCORE_THRESHOLD = 0.2;
const MAX_DOCUMENT_RESULTS = 12;
const MAX_EXCERPTS_PER_DOCUMENT = 3;
const RAW_RESULT_MULTIPLIER = 4;

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
      ${normalizedScore}::float as "score"
    from knowledge_document_chunks c
    inner join knowledge_documents d on d.id = c.document_id
    where
      c.organization_id = ${input.organizationId}
      and d.organization_id = ${input.organizationId}
      and d.status in ('ready', 'partial')
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
    }
  );
}

export async function searchKnowledgeDocuments(input: {
  organizationId: string;
  query: string;
  limit?: number;
  scoreThreshold?: number;
}) {
  const { knowledgeDb } = await import("@/lib/knowledge/db");
  const [embedding] = await embedKnowledgeTexts([input.query]);
  const documentLimit = Math.min(
    Math.max(input.limit ?? 6, 1),
    MAX_DOCUMENT_RESULTS
  );
  const embeddingRuntime = getKnowledgeEmbeddingRuntime();
  if (embeddingRuntime.retrievalStrategy === "lexical") {
    return searchKnowledgeDocumentsLexical({
      organizationId: input.organizationId,
      query: input.query,
      limit: documentLimit,
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
      greatest(0, 1 - (c.embedding <=> ${sql.raw(toVectorLiteral(embedding))}))::float as "score"
    from knowledge_document_chunks c
    inner join knowledge_documents d on d.id = c.document_id
    where
      c.organization_id = ${input.organizationId}
      and d.organization_id = ${input.organizationId}
      and d.status in ('ready', 'partial')
    order by c.embedding <=> ${sql.raw(toVectorLiteral(embedding))}
    limit ${rawLimit};
  `);

  const grouped = groupKnowledgeRetrievalRows(
    Array.from(result) as RawKnowledgeRetrievalRow[],
    {
      documentLimit,
      excerptLimitPerDocument: MAX_EXCERPTS_PER_DOCUMENT,
      scoreThreshold,
    }
  );

  if (grouped.length > 0) {
    return grouped;
  }

  return searchKnowledgeDocumentsLexical({
    organizationId: input.organizationId,
    query: input.query,
    limit: documentLimit,
  });
}
