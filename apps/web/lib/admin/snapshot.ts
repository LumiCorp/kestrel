import { createSnapshotForOrganization } from "@/lib/knowledge/jobs";
import { KV_KEYS, kvGet, kvSet } from "@/lib/knowledge/kv";
import {
  getSnapshotRepoConfig,
  setSnapshotRepoConfig,
} from "@/lib/knowledge/snapshot-config";
import {
  getActiveKnowledgeSnapshot,
  getLatestReadyKnowledgeSnapshot,
  markSnapshotActive,
} from "@/lib/knowledge/snapshot-store";

type SnapshotState = {
  snapshotId: string;
  createdAt?: number;
};

export async function getSnapshotStatusForOrganization(organizationId: string) {
  const [currentSnapshotState, activeSnapshot, latestSnapshot, lastSyncAt] =
    await Promise.all([
      kvGet<SnapshotState>(KV_KEYS.CURRENT_SNAPSHOT, organizationId),
      getActiveKnowledgeSnapshot(organizationId),
      getLatestReadyKnowledgeSnapshot(organizationId),
      kvGet<number>(KV_KEYS.LAST_SOURCE_SYNC, organizationId),
    ]);

  return {
    currentSnapshotId:
      activeSnapshot?.id ?? currentSnapshotState?.snapshotId ?? null,
    latestSnapshotId: latestSnapshot?.id ?? null,
    latestCreatedAt:
      latestSnapshot?.lastSyncedAt?.getTime() ??
      currentSnapshotState?.createdAt ??
      null,
    needsSync:
      !(latestSnapshot && activeSnapshot) ||
      activeSnapshot.id !== latestSnapshot.id ||
      (lastSyncAt
        ? (latestSnapshot.lastSyncedAt?.getTime() ?? 0) < lastSyncAt
        : false),
  };
}

export async function syncSnapshotForOrganization(organizationId: string) {
  let snapshot = await getLatestReadyKnowledgeSnapshot(organizationId);
  let created = false;

  if (!snapshot) {
    await createSnapshotForOrganization(organizationId);
    snapshot = await getLatestReadyKnowledgeSnapshot(organizationId);
    created = true;
  }

  if (!snapshot) {
    throw new Error("Snapshot unavailable");
  }

  await Promise.all([
    markSnapshotActive(organizationId, snapshot.id),
    kvSet(
      KV_KEYS.CURRENT_SNAPSHOT,
      {
        snapshotId: snapshot.id,
        createdAt: snapshot.lastSyncedAt?.getTime() ?? Date.now(),
      },
      organizationId
    ),
    kvSet(KV_KEYS.SNAPSHOT_STATUS_CACHE, null, organizationId),
    kvSet(KV_KEYS.ACTIVE_SANDBOX_SESSION, null, organizationId),
  ]);

  return {
    snapshotId: snapshot.id,
    created,
  };
}

export async function updateSnapshotConfigForOrganization(input: {
  organizationId: string;
  snapshotRepo: string;
  snapshotBranch?: string;
}) {
  const previous = await getSnapshotRepoConfig(input.organizationId);
  const next = await setSnapshotRepoConfig(input);
  const changed =
    previous.snapshotRepo !== next.snapshotRepo ||
    previous.snapshotBranch !== next.snapshotBranch;

  if (changed) {
    await Promise.all([
      kvSet(KV_KEYS.CURRENT_SNAPSHOT, null, input.organizationId),
      kvSet(KV_KEYS.SNAPSHOT_STATUS_CACHE, null, input.organizationId),
      kvSet(KV_KEYS.ACTIVE_SANDBOX_SESSION, null, input.organizationId),
    ]);
  }

  return {
    ...next,
    changed,
    success: true,
    repositoryEnsured: next.snapshotRepo,
    repositoryUrl: `https://github.com/${next.snapshotRepo}`,
    repositoryCreated: false,
    repositoryAdoptedExisting: false,
  };
}
