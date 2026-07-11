import { asc, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getKnowledgeEmbeddingMode } from "@/lib/knowledge/documents/embed";
import { getKnowledgeOcrMode } from "@/lib/knowledge/documents/extract";
import {
  getKnowledgeDocumentsForOrganization,
  getLatestKnowledgeIngestionRunsForDocuments,
} from "@/lib/knowledge/documents/store";
import { KV_KEYS, kvGet } from "@/lib/knowledge/kv";
import { getKnowledgeQueueStatus } from "@/lib/knowledge/queue";
import { getSnapshotRepoConfig } from "@/lib/knowledge/snapshot-config";
import { getStorageConfig } from "@/lib/storage";
import { normalizeMediaType } from "./documents/shared";

export async function getKnowledgeSourcesPayload(organizationId: string) {
  const [allSources, lastSyncAt, snapshotConfig] = await Promise.all([
    knowledgeDb
      .select()
      .from(schema.sources)
      .where(eq(schema.sources.organizationId, organizationId))
      .orderBy(asc(schema.sources.label)),
    kvGet<number>(KV_KEYS.LAST_SOURCE_SYNC, organizationId),
    getSnapshotRepoConfig(organizationId),
  ]);

  const github = allSources.filter((source) => source.type === "github");
  const youtube = allSources.filter((source) => source.type === "youtube");
  const snapshotRepo = snapshotConfig.snapshotRepo || null;
  const snapshotBranch = snapshotConfig.snapshotBranch || "main";

  return {
    total: github.length + youtube.length,
    lastSyncAt,
    youtubeEnabled: true,
    snapshotRepo,
    snapshotBranch,
    snapshotRepoUrl: snapshotRepo ? `https://github.com/${snapshotRepo}` : null,
    github: {
      count: github.length,
      sources: github.map((source) => ({
        ...source,
        updatedAt: source.updatedAt.toISOString(),
      })),
    },
    youtube: {
      count: youtube.length,
      sources: youtube.map((source) => ({
        ...source,
        updatedAt: source.updatedAt.toISOString(),
      })),
    },
  };
}

export async function getKnowledgeDocumentsPayload(
  organizationId: string,
  status?: string
) {
  const documents = await getKnowledgeDocumentsForOrganization(organizationId);
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
      };
    }),
    runtime,
  };
}
