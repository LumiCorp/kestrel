import { getStorageAdapter } from "@/lib/storage";
import { chunkKnowledgeDocument } from "./chunk";
import { embedKnowledgeTexts, getKnowledgeEmbeddingRuntime } from "./embed";
import { extractKnowledgeDocument } from "./extract";
import { getKnowledgeOcrMode } from "./ocr-config";
import {
  buildKnowledgeExtractionMetadata,
  buildKnowledgeIngestionFailureState,
} from "./process-state";
import {
  getKnowledgeDocumentById,
  getKnowledgeIngestionRun,
  replaceKnowledgeDocumentChunks,
  updateKnowledgeDocument,
  updateKnowledgeIngestionRun,
} from "./store";

export async function processKnowledgeDocumentRun(runId: string) {
  const run = await getKnowledgeIngestionRun(runId);
  if (!run) {
    throw new Error("Knowledge document run not found");
  }

  const document = await getKnowledgeDocumentById(
    run.organizationId,
    run.documentId
  );
  if (!document) {
    throw new Error("Knowledge document not found");
  }

  await updateKnowledgeIngestionRun(run.id, {
    status: "running",
    stage: "extract",
    attemptCount: (run.attemptCount ?? 0) + 1,
    startedAt: new Date(),
    error: null,
  });
  await updateKnowledgeDocument(document.id, {
    status: "processing",
    error: null,
  });

  const embeddingRuntime = getKnowledgeEmbeddingRuntime();
  const embeddingProvenance = embeddingRuntime.provenance ?? {
    mode: "lexical" as const,
  };

  try {
    const ocrMode = getKnowledgeOcrMode();
    const diagnostics: Record<string, unknown> = {
      modes: {
        ocr: ocrMode,
        embedding: embeddingRuntime.mode,
      },
      embedding: embeddingProvenance,
      stageTimingsMs: {},
    };
    const storage = getStorageAdapter();
    const buffer = await storage.getObjectBuffer(document.storageKey);
    const extractStartedAt = Date.now();
    const extracted = await extractKnowledgeDocument({
      buffer,
      filename: document.originalFilename,
      mediaType: document.mediaType,
    });
    const extractDurationMs = Date.now() - extractStartedAt;
    diagnostics.warnings = extracted.warnings;
    diagnostics.metadata = extracted.metadata;
    diagnostics.stageTimingsMs = {
      ...(diagnostics.stageTimingsMs as Record<string, number>),
      extract: extractDurationMs,
    };

    await updateKnowledgeIngestionRun(run.id, {
      stage: "chunk",
      diagnostics,
    });

    const chunkStartedAt = Date.now();
    const chunks = chunkKnowledgeDocument(extracted.blocks);
    const chunkDurationMs = Date.now() - chunkStartedAt;
    diagnostics.stageTimingsMs = {
      ...(diagnostics.stageTimingsMs as Record<string, number>),
      chunk: chunkDurationMs,
    };

    if (chunks.length === 0) {
      await replaceKnowledgeDocumentChunks({
        organizationId: document.organizationId,
        documentId: document.id,
        chunks: [],
      });
      await updateKnowledgeDocument(document.id, {
        title: extracted.title ?? document.title,
        pageCount: extracted.pageCount,
        chunkCount: 0,
        extractionMetadata: buildKnowledgeExtractionMetadata({
          warnings: extracted.warnings,
          metadata: extracted.metadata,
          embedding: { mode: "lexical" },
        }),
        status: "partial",
        error:
          extracted.warnings.join("; ") || "No searchable text was extracted",
      });
      await updateKnowledgeIngestionRun(run.id, {
        stage: "complete",
        status: "completed",
        diagnostics: {
          ...diagnostics,
          chunkCount: 0,
        },
        finishedAt: new Date(),
      });
      return;
    }

    await updateKnowledgeIngestionRun(run.id, {
      stage: "embed",
      diagnostics,
    });

    const embedStartedAt = Date.now();
    const embeddings = await embedKnowledgeTexts(
      chunks.map((chunk) => chunk.content)
    );
    const embedDurationMs = Date.now() - embedStartedAt;
    diagnostics.stageTimingsMs = {
      ...(diagnostics.stageTimingsMs as Record<string, number>),
      embed: embedDurationMs,
    };

    await replaceKnowledgeDocumentChunks({
      organizationId: document.organizationId,
      documentId: document.id,
      chunks: chunks.map((chunk, index) => ({
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        contentLength: chunk.contentLength,
        tokenCount: chunk.tokenCount,
        pageNumber: chunk.pageNumber,
        sectionTitle: chunk.sectionTitle,
        metadata: chunk.metadata,
        embedding: embeddings[index],
      })),
    });

    await updateKnowledgeDocument(document.id, {
      title: extracted.title ?? document.title ?? document.filename,
      pageCount: extracted.pageCount,
      chunkCount: chunks.length,
      extractionMetadata: buildKnowledgeExtractionMetadata({
        warnings: extracted.warnings,
        metadata: extracted.metadata,
        embedding: embeddingProvenance,
      }),
      status: extracted.warnings.length > 0 ? "partial" : "ready",
      error:
        extracted.warnings.length > 0 ? extracted.warnings.join("; ") : null,
    });

    await updateKnowledgeIngestionRun(run.id, {
      stage: "complete",
      status: "completed",
      diagnostics: {
        ...diagnostics,
        chunkCount: chunks.length,
      },
      finishedAt: new Date(),
    });
  } catch (error) {
    const failure = buildKnowledgeIngestionFailureState({
      error,
      ocrMode: getKnowledgeOcrMode(),
      embeddingMode: embeddingRuntime.mode,
      embedding: embeddingProvenance,
      finishedAt: new Date(),
    });
    await updateKnowledgeDocument(document.id, failure.documentUpdate);
    await updateKnowledgeIngestionRun(run.id, failure.runUpdate);
    throw error;
  }
}
