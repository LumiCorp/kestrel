import {
  getKnowledgeDocumentsForOrganization,
  getLatestKnowledgeIngestionRunsForDocuments,
  getVisibleProjectUsageForKnowledgeDocuments,
} from "@/lib/knowledge/documents/store";
import { normalizeMediaType } from "./documents/shared";

export async function getKnowledgeDocumentsPayload(
  organizationId: string,
  userId: string,
  status?: string
) {
  const documents = await getKnowledgeDocumentsForOrganization(organizationId);
  const [latestRuns, projectUsage] = await Promise.all([
    getLatestKnowledgeIngestionRunsForDocuments(
      documents.map((document) => document.id)
    ),
    getVisibleProjectUsageForKnowledgeDocuments({
      organizationId,
      userId,
      documentIds: documents.map((document) => document.id),
    }),
  ]);
  const filtered = status
    ? documents.filter((document) => document.status === status)
    : documents;

  return {
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
      const latestRun = latestRuns.get(document.id) ?? null;

      return {
        ...document,
        mediaType: normalizedMediaType,
        createdAt: document.createdAt.toISOString(),
        updatedAt: document.updatedAt.toISOString(),
        latestRun: latestRun
          ? {
              ...latestRun,
              startedAt: latestRun.startedAt?.toISOString() ?? null,
              finishedAt: latestRun.finishedAt?.toISOString() ?? null,
              updatedAt: latestRun.updatedAt.toISOString(),
              createdAt: latestRun.createdAt.toISOString(),
            }
          : null,
        visibleProjectUsage: projectUsage.get(document.id) ?? [],
      };
    }),
  };
}
