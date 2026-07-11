const DEFAULT_EXCERPT_LIMIT_PER_DOCUMENT = 3;

export type RawKnowledgeRetrievalRow = {
  documentId: string;
  filename: string;
  title: string | null;
  mediaType: string;
  chunkText: string;
  chunkIndex: number;
  pageNumber: number | null;
  sectionTitle: string | null;
  score: number;
};

export type KnowledgeRetrievalExcerpt = {
  chunkIndex: number;
  text: string;
  pageNumber: number | null;
  sectionTitle: string | null;
  score: number;
};

export type KnowledgeRetrievalCitation = {
  label: string;
  url: string;
  pageNumber: number | null;
  sectionTitle: string | null;
};

export type KnowledgeRetrievalHit = {
  documentId: string;
  filename: string;
  title: string | null;
  mediaType: string;
  url: string;
  maxScore: number;
  excerptCount: number;
  excerpts: KnowledgeRetrievalExcerpt[];
  citations: KnowledgeRetrievalCitation[];
};

function buildCitationLabel(input: {
  title: string | null;
  filename: string;
  pageNumber: number | null;
  sectionTitle: string | null;
}) {
  const title = input.title || input.filename;
  const location = [
    input.pageNumber ? `page ${input.pageNumber}` : null,
    input.sectionTitle || null,
  ]
    .filter(Boolean)
    .join(" · ");

  return location ? `${title} (${location})` : title;
}

export function groupKnowledgeRetrievalRows(
  rows: RawKnowledgeRetrievalRow[],
  input: {
    documentLimit: number;
    excerptLimitPerDocument?: number;
    scoreThreshold: number;
  }
) {
  const grouped = new Map<string, KnowledgeRetrievalHit>();
  const excerptLimitPerDocument =
    input.excerptLimitPerDocument ?? DEFAULT_EXCERPT_LIMIT_PER_DOCUMENT;

  for (const row of rows) {
    const score = Number(row.score ?? 0);
    if (score < input.scoreThreshold) {
      continue;
    }

    const existing = grouped.get(row.documentId);
    const url = `/api/knowledge/documents/${row.documentId}/download`;

    if (!existing) {
      grouped.set(row.documentId, {
        documentId: row.documentId,
        filename: row.filename,
        title: row.title,
        mediaType: row.mediaType,
        url,
        maxScore: score,
        excerptCount: 1,
        excerpts: [
          {
            chunkIndex: row.chunkIndex,
            text: row.chunkText,
            pageNumber: row.pageNumber,
            sectionTitle: row.sectionTitle,
            score,
          },
        ],
        citations: [
          {
            label: buildCitationLabel({
              title: row.title,
              filename: row.filename,
              pageNumber: row.pageNumber,
              sectionTitle: row.sectionTitle,
            }),
            url,
            pageNumber: row.pageNumber,
            sectionTitle: row.sectionTitle,
          },
        ],
      });
      continue;
    }

    existing.maxScore = Math.max(existing.maxScore, score);
    existing.excerptCount += 1;

    if (
      existing.excerpts.length < excerptLimitPerDocument &&
      !existing.excerpts.some(
        (excerpt) => excerpt.chunkIndex === row.chunkIndex
      )
    ) {
      existing.excerpts.push({
        chunkIndex: row.chunkIndex,
        text: row.chunkText,
        pageNumber: row.pageNumber,
        sectionTitle: row.sectionTitle,
        score,
      });
    }

    const citationKey = `${row.pageNumber ?? "none"}:${row.sectionTitle ?? "none"}`;
    const hasCitation = existing.citations.some(
      (citation) =>
        `${citation.pageNumber ?? "none"}:${citation.sectionTitle ?? "none"}` ===
        citationKey
    );

    if (!hasCitation && existing.citations.length < excerptLimitPerDocument) {
      existing.citations.push({
        label: buildCitationLabel({
          title: row.title,
          filename: row.filename,
          pageNumber: row.pageNumber,
          sectionTitle: row.sectionTitle,
        }),
        url,
        pageNumber: row.pageNumber,
        sectionTitle: row.sectionTitle,
      });
    }
  }

  return Array.from(grouped.values())
    .sort((left, right) => {
      if (right.maxScore !== left.maxScore) {
        return right.maxScore - left.maxScore;
      }

      return left.filename.localeCompare(right.filename);
    })
    .slice(0, input.documentLimit);
}
