import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { getKnowledgeEmbeddingMode } from "@/lib/knowledge/documents/embed";
import { getKnowledgeOcrMode } from "@/lib/knowledge/documents/extract";
import {
  isKnowledgeDocumentMediaTypeSupported,
  normalizeMediaType,
} from "@/lib/knowledge/documents/shared";
import {
  getKnowledgeDocumentsForOrganization,
  getLatestKnowledgeIngestionRunsForDocuments,
} from "@/lib/knowledge/documents/store";
import { errorResponse } from "@/lib/knowledge/http";
import {
  MAX_KNOWLEDGE_FILE_BYTES,
  uploadKnowledgeDocumentForUser,
} from "@/lib/knowledge/mutations";
import { getKnowledgeQueueStatus } from "@/lib/knowledge/queue";
import { getStorageConfig } from "@/lib/storage";

const listQuerySchema = z.object({
  status: z.string().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { organizationId } = await requireActiveOrganization();
    const query = listQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries())
    );

    const documents =
      await getKnowledgeDocumentsForOrganization(organizationId);
    const latestRuns = await getLatestKnowledgeIngestionRunsForDocuments(
      documents.map((document) => document.id)
    );
    const runtime = {
      storage: {
        provider: getStorageConfig().provider,
        configured: true,
      },
      embeddingMode: getKnowledgeEmbeddingMode(),
      ocrMode: getKnowledgeOcrMode(),
      queue: await getKnowledgeQueueStatus(),
    };
    const filtered = query.status
      ? documents.filter((document) => document.status === query.status)
      : documents;

    return NextResponse.json({
      total: filtered.length,
      readyCount: filtered.filter((document) => document.status === "ready")
        .length,
      partialCount: filtered.filter((document) => document.status === "partial")
        .length,
      failedCount: filtered.filter((document) => document.status === "failed")
        .length,
      processingCount: filtered.filter(
        (document) =>
          document.status === "uploaded" || document.status === "processing"
      ).length,
      documents: filtered.map((document) => {
        const normalizedMediaType = normalizeMediaType(
          document.mediaType,
          document.originalFilename
        );

        return {
          ...document,
          mediaType: normalizedMediaType,
          latestRun: latestRuns.get(document.id) ?? null,
        };
      }),
      runtime,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { organizationId, session } = await requireActiveOrganization();

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const mediaType = normalizeMediaType(file.type, file.name);
    if (!isKnowledgeDocumentMediaTypeSupported(mediaType, file.name)) {
      return NextResponse.json(
        {
          error: `File type ${mediaType} is not supported for knowledge uploads`,
        },
        { status: 400 }
      );
    }

    const bytes = file.size;
    if (bytes > MAX_KNOWLEDGE_FILE_BYTES) {
      return NextResponse.json(
        { error: "File size exceeds 32MB limit" },
        { status: 400 }
      );
    }

    const { document, run, deduped } = await uploadKnowledgeDocumentForUser({
      organizationId,
      uploaderUserId: session.user.id,
      file,
    });

    const message = deduped
      ? run
        ? `Reused ${document.filename}. Reindexing has started on the existing document.`
        : `Reused ${document.filename}. This file already exists in the Knowledge Library.`
      : `Uploaded ${document.filename}. Indexing has started.`;

    return NextResponse.json(
      {
        document,
        run,
        deduped,
        message,
      },
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
