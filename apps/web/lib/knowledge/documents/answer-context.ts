import type { KnowledgeRetrievalHit } from "./retrieval-grouping";

export type KnowledgeAnswerSource = {
  citationNumber: number;
  documentId: string;
  label: string;
  url: string;
  locations: string[];
  excerpts: Array<{
    text: string;
    pageNumber: number | null;
    sectionTitle: string | null;
  }>;
};

export function buildKnowledgeAnswerContext(results: KnowledgeRetrievalHit[]) {
  const sources: KnowledgeAnswerSource[] = results.map((result, index) => ({
    citationNumber: index + 1,
    documentId: result.documentId,
    label: result.title || result.filename,
    url: result.url,
    locations: result.citations.map((citation) => citation.label),
    excerpts: result.excerpts.map((excerpt) => ({
      text: excerpt.text,
      pageNumber: excerpt.pageNumber,
      sectionTitle: excerpt.sectionTitle,
    })),
  }));

  const context = sources
    .map((source) => {
      const excerpts = source.excerpts
        .map((excerpt, index) => {
          const location = [
            excerpt.pageNumber ? `page ${excerpt.pageNumber}` : null,
            excerpt.sectionTitle || null,
          ]
            .filter(Boolean)
            .join(" · ");
          return `Excerpt ${index + 1}${location ? ` (${location})` : ""}:\n${excerpt.text}`;
        })
        .join("\n\n");

      return `SOURCE ${source.citationNumber}: ${source.label}\n${excerpts}`;
    })
    .join("\n\n---\n\n");

  return { context, sources };
}
