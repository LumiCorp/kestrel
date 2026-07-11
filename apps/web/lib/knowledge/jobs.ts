import { knowledgeDb } from "@/lib/knowledge/db";
import { enqueueKnowledgeSyncRun } from "@/lib/knowledge/queue";
import { getSnapshotRepoConfig } from "@/lib/knowledge/snapshot-config";
import { createManualSnapshotFromActive } from "@/lib/knowledge/sync-runtime";
import {
  createKnowledgeSyncRun,
  getKnowledgeSyncRun,
} from "@/lib/knowledge/sync-store";

type SyncResult = {
  runId: string;
  sourceCount: number;
  status: "started";
  snapshotRepo: string | null;
  snapshotBranch: string;
};

export async function runSyncAllSources(
  organizationId: string,
  sourceFilter?: string,
  requestedByUserId?: string | null
): Promise<SyncResult> {
  const [allSources, snapshotConfig] = await Promise.all([
    knowledgeDb.query.sources.findMany({
      where: (table, { eq }) => eq(table.organizationId, organizationId),
    }),
    getSnapshotRepoConfig(organizationId),
  ]);

  const filtered = sourceFilter
    ? allSources.filter(
        (source) =>
          source.id === sourceFilter ||
          source.type === sourceFilter ||
          source.label === sourceFilter
      )
    : allSources;

  const run = await createKnowledgeSyncRun({
    organizationId,
    requestedByUserId,
    sourceFilter: sourceFilter ?? null,
    metadata: {
      sourceIds: filtered.map((source) => source.id),
    },
  });

  await enqueueKnowledgeSyncRun(run.id);

  return {
    runId: run.id,
    sourceCount: filtered.length,
    status: "started",
    snapshotRepo: snapshotConfig.snapshotRepo || null,
    snapshotBranch: snapshotConfig.snapshotBranch || "main",
  };
}

export async function runSyncSingleSource(
  organizationId: string,
  sourceId: string,
  requestedByUserId?: string | null
): Promise<SyncResult> {
  return runSyncAllSources(organizationId, sourceId, requestedByUserId);
}

export async function createSnapshotForOrganization(
  organizationId: string
): Promise<{
  runId: string;
  snapshotId: string;
  status: "completed";
}> {
  const snapshot = await createManualSnapshotFromActive(organizationId);
  if (!snapshot) {
    throw new Error("Snapshot unavailable");
  }

  return {
    runId: crypto.randomUUID(),
    snapshotId: snapshot.id,
    status: "completed",
  };
}

export async function getSyncRunForOrganization(
  organizationId: string,
  runId: string
) {
  return getKnowledgeSyncRun(organizationId, runId);
}
