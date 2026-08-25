import { and, eq } from "drizzle-orm";
import { getPgPool } from "@/lib/db/runtime";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getStorageAdapter } from "@/lib/storage";
import { ensureEffectiveFileAvailability } from "@/lib/files/availability";
import { chunkKnowledgeDocument } from "./chunk";
import { embedKnowledgeTexts, getKnowledgeEmbeddingRuntime } from "./embed";
import { extractKnowledgeDocument } from "./extract";
import { getKnowledgeOcrMode } from "./ocr-config";
import {
  buildKnowledgeExtractionMetadata,
  buildKnowledgeIngestionFailureState,
  buildKnowledgeIngestionRetryState,
} from "./process-state";
import {
  getKnowledgeDocumentById,
  getKnowledgeIngestionRun,
  replaceKnowledgeDocumentChunks,
  updateKnowledgeDocument,
  updateKnowledgeIngestionRun,
} from "./store";

export async function processKnowledgeDocumentRun(
  runId: string,
  options: {
    expectedDocumentId?: string | undefined;
    finalAttempt?: boolean | undefined;
  } = {},
) {
  const initialRun = await getKnowledgeIngestionRun(runId);
  if (!initialRun) {
    throw new Error("Knowledge document run not found");
  }
  if (
    options.expectedDocumentId &&
    options.expectedDocumentId !== initialRun.documentId
  ) {
    throw new Error("Knowledge document job does not match its run document.");
  }

  const client = await getPgPool().connect();
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      [`knowledge-document-processing:${initialRun.documentId}`],
    );
    return await processKnowledgeDocumentRunLocked(runId, options);
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        `knowledge-document-processing:${initialRun.documentId}`,
      ])
      .catch(() => {});
    client.release();
  }
}

async function processKnowledgeDocumentRunLocked(
  runId: string,
  options: { finalAttempt?: boolean | undefined },
) {
  const run = await getKnowledgeIngestionRun(runId);
  if (!run) {
    throw new Error("Knowledge document run not found");
  }
  if (run.status === "completed" || run.status === "failed") {
    return;
  }

  const document = await getKnowledgeDocumentById(
    run.organizationId,
    run.documentId
  );
  if (!document) {
    // A deleted document cannot become processable on a later attempt. Make
    // the durable run terminal so queue reconciliation does not resurrect the
    // same orphan forever on development databases created before the current
    // document/run foreign-key contract.
    await updateKnowledgeIngestionRun(run.id, {
      status: "failed",
      error: "Knowledge document is no longer available.",
      finishedAt: new Date(),
    });
    return;
  }

  await updateKnowledgeIngestionRun(run.id, {
    status: "running",
    stage: "extract",
    attemptCount: (run.attemptCount ?? 0) + 1,
    startedAt: run.startedAt ?? new Date(),
    finishedAt: null,
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
  const diagnostics: Record<string, unknown> = {
    modes: {
      ocr: getKnowledgeOcrMode(),
      embedding: embeddingRuntime.mode,
    },
    embedding: embeddingProvenance,
    stageTimingsMs: {},
  };

  try {
    const storage = getStorageAdapter();
    const file = await knowledgeDb.select({
      fileId: schema.kestrelFiles.id,
      blobId: schema.kestrelFiles.blobId,
      objectKey: schema.fileBlobs.objectKey,
      lifecycleState: schema.kestrelFiles.lifecycleState,
      availabilityStatus: schema.fileBlobs.availabilityStatus,
      blobDeletedAt: schema.fileBlobs.deletedAt,
    }).from(schema.kestrelFiles)
      .innerJoin(schema.fileBlobs, eq(schema.fileBlobs.id, schema.kestrelFiles.blobId))
      .where(eq(schema.kestrelFiles.id, document.fileId))
      .limit(1);
    if (!file[0]) throw new Error("Knowledge document file not found.");
    await ensureEffectiveFileAvailability(file[0]);
    const extractStartedAt = Date.now();
    const representation = await knowledgeDb.select({
      text: schema.fileRepresentations.textContent,
      truncated: schema.fileRepresentations.truncated,
      metadata: schema.fileRepresentations.metadata,
    }).from(schema.kestrelFiles)
      .innerJoin(schema.fileRepresentations, eq(schema.fileRepresentations.blobId, schema.kestrelFiles.blobId))
      .where(and(
        eq(schema.kestrelFiles.id, document.fileId),
        eq(schema.fileRepresentations.kind, "extracted_text"),
        eq(schema.fileRepresentations.status, "ready"),
      )).limit(1);
    const extracted = representation[0]?.text
      ? {
          title: null,
          pageCount: null,
          blocks: [{
            text: representation[0].text,
            metadata: {
              source: "kestrel_file_representation",
              ...(representation[0].metadata && typeof representation[0].metadata === "object"
                ? representation[0].metadata as Record<string, unknown>
                : {}),
            },
          }],
          metadata: {
            source: "kestrel_file_representation",
            truncated: representation[0].truncated,
          },
          warnings: representation[0].truncated ? ["file_representation_truncated"] : [],
        }
      : await extractKnowledgeDocument({
          buffer: await storage.getObjectBuffer(document.storageKey),
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
    const stateInput = {
      error,
      ocrMode: getKnowledgeOcrMode(),
      embeddingMode: embeddingRuntime.mode,
      embedding: embeddingProvenance,
      diagnostics,
    };
    const state =
      (options.finalAttempt ?? true)
        ? buildKnowledgeIngestionFailureState({
            ...stateInput,
            finishedAt: new Date(),
          })
        : buildKnowledgeIngestionRetryState(stateInput);
    await updateKnowledgeDocument(document.id, state.documentUpdate);
    await updateKnowledgeIngestionRun(run.id, state.runUpdate);
    if (options.finalAttempt ?? true) {
      console.error("Knowledge document ingestion failed permanently.", {
        runId: run.id,
        documentId: document.id,
        attemptCount: (run.attemptCount ?? 0) + 1,
        message: state.message,
      });
    }
    throw error;
  }
}
