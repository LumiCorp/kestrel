import {
  MEMORY_BACKEND_VERSION,
  MEMORY_QUERY_RESULT_VERSION,
  parseMemoryBackendV1,
  parseMemoryQueryResultV1,
  parseMemoryRecordProvenanceV1,
  memoryScopesEqualV1,
  type MemoryBackendV1,
  type MemoryQueryResultItemV1,
  type MemoryRecordProvenanceV1,
} from "./contracts.js";
import type { MemoryBackendAdapterV1 } from "./MemoryGateway.js";

export interface InMemoryMemoryRecordV1 {
  provenance: MemoryRecordProvenanceV1;
  filename: string;
  title?: string | undefined;
  mediaType: string;
  segments: Array<{
    segmentId: string;
    text: string;
    label: string;
    url: string;
    pageNumber?: number | undefined;
    sectionTitle?: string | undefined;
  }>;
  semanticMatches?: Readonly<Record<string, number>> | undefined;
}

export class InMemoryMemoryBackend implements MemoryBackendAdapterV1 {
  readonly descriptor: MemoryBackendV1;
  readonly #records: InMemoryMemoryRecordV1[];

  constructor(input: {
    backendId: string;
    policyRevision: string;
    records?: InMemoryMemoryRecordV1[];
  }) {
    this.descriptor = parseMemoryBackendV1({
      version: MEMORY_BACKEND_VERSION,
      backendId: input.backendId,
      policyRevision: input.policyRevision,
      namespace: "semantic_knowledge",
      sourceOfTruth: "hosted_knowledge_store",
      strategies: ["vector", "lexical"],
    });
    this.#records = (input.records ?? []).map((record) => ({
      ...structuredClone(record),
      provenance: parseMemoryRecordProvenanceV1(record.provenance),
    }));
  }

  async query(input: Parameters<MemoryBackendAdapterV1["query"]>[0]) {
    const requestedDocuments = input.query.documentIds === undefined
      ? undefined
      : new Set(input.query.documentIds);
    const minimumScore = input.query.minimumMatchScore ?? 0;
    const normalizedQuery = input.query.text.trim().toLowerCase();
    const items: Array<MemoryQueryResultItemV1 & { maxScore: number }> = [];

    for (const record of this.#records) {
      if (
        !memoryScopesEqualV1(record.provenance.scope, input.query.scope) ||
        record.provenance.namespace !== input.query.namespace ||
        (requestedDocuments !== undefined && !requestedDocuments.has(record.provenance.recordId))
      ) {
        continue;
      }
      const semanticScore = record.semanticMatches?.[normalizedQuery];
      const strategy = semanticScore === undefined ? "lexical" : "vector";
      const matchingSegments = record.segments
        .map((segment) => {
          const lexicalScore = segment.text.toLowerCase().includes(normalizedQuery) ? 1 : 0;
          const score = semanticScore ?? lexicalScore;
          return { segment, score };
        })
        .filter(({ score }) => score >= minimumScore && score > 0);
      if (matchingSegments.length === 0) continue;
      const maxScore = Math.max(...matchingSegments.map(({ score }) => score));
      items.push({
        recordId: record.provenance.recordId,
        provenance: record.provenance,
        segments: matchingSegments.map(({ segment, score }) => ({
          segmentId: segment.segmentId,
          text: segment.text,
          location: {
            label: segment.label,
            url: segment.url,
            ...(segment.pageNumber === undefined ? {} : { pageNumber: segment.pageNumber }),
            ...(segment.sectionTitle === undefined ? {} : { sectionTitle: segment.sectionTitle }),
          },
          matchEvidence: { strategy, score },
        })),
        sourceMetadata: {
          filename: record.filename,
          ...(record.title === undefined ? {} : { title: record.title }),
          mediaType: record.mediaType,
          excerptCount: matchingSegments.length,
        },
        maxScore,
      });
    }

    items.sort((left, right) => right.maxScore - left.maxScore || left.recordId.localeCompare(right.recordId));
    return parseMemoryQueryResultV1({
      version: MEMORY_QUERY_RESULT_VERSION,
      queryId: input.query.queryId,
      bindingId: input.binding.bindingId,
      backendId: this.descriptor.backendId,
      policyRevision: this.descriptor.policyRevision,
      items: items.slice(0, input.query.limit).map(({ maxScore: _maxScore, ...item }) => item),
    });
  }
}
