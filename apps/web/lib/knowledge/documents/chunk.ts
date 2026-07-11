import { estimateTokenCount } from "./shared";

export type ExtractedDocumentBlock = {
  text: string;
  pageNumber?: number | null;
  sectionTitle?: string | null;
  metadata?: Record<string, unknown>;
};

export type ChunkedKnowledgeDocument = {
  chunkIndex: number;
  content: string;
  contentLength: number;
  tokenCount: number;
  pageNumber: number | null;
  sectionTitle: string | null;
  metadata: Record<string, unknown> | null;
};

const MAX_CHARS = 1200;
const OVERLAP_CHARS = 200;

function normalizeWhitespace(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitIntoWindows(text: string) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= MAX_CHARS) {
    return [normalized];
  }

  const parts: string[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    let end = Math.min(normalized.length, cursor + MAX_CHARS);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf("\n\n", end);
      if (boundary > cursor + Math.floor(MAX_CHARS * 0.5)) {
        end = boundary;
      }
    }

    const next = normalized.slice(cursor, end).trim();
    if (next) {
      parts.push(next);
    }

    if (end >= normalized.length) {
      break;
    }

    cursor = Math.max(end - OVERLAP_CHARS, cursor + 1);
  }

  return parts;
}

export function chunkKnowledgeDocument(
  blocks: ExtractedDocumentBlock[]
): ChunkedKnowledgeDocument[] {
  const chunks: ChunkedKnowledgeDocument[] = [];

  for (const block of blocks) {
    if (!block.text.trim()) {
      continue;
    }

    for (const content of splitIntoWindows(block.text)) {
      chunks.push({
        chunkIndex: chunks.length,
        content,
        contentLength: content.length,
        tokenCount: estimateTokenCount(content),
        pageNumber: block.pageNumber ?? null,
        sectionTitle: block.sectionTitle ?? null,
        metadata: block.metadata ?? null,
      });
    }
  }

  return chunks;
}
