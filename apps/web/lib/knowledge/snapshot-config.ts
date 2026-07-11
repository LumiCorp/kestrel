import { KV_KEYS, kvGet, kvSet } from "@/lib/knowledge/kv";

export interface SnapshotRepoConfig {
  snapshotRepo: string;
  snapshotBranch: string;
}

const SNAPSHOT_REPO_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function normalizeSnapshotRepo(value?: string | null): string {
  return (value || "").trim();
}

function normalizeSnapshotBranch(value?: string | null): string {
  const branch = (value || "").trim();
  return branch || "main";
}

export function isValidSnapshotRepo(repo: string): boolean {
  return SNAPSHOT_REPO_REGEX.test(repo);
}

export async function getSnapshotRepoConfig(
  organizationId: string
): Promise<SnapshotRepoConfig> {
  const stored = await kvGet<Partial<SnapshotRepoConfig>>(
    KV_KEYS.SNAPSHOT_REPO_CONFIG,
    organizationId
  );
  const snapshotRepo = normalizeSnapshotRepo(
    stored?.snapshotRepo || process.env.SNAPSHOT_REPO
  );
  const snapshotBranch = normalizeSnapshotBranch(
    stored?.snapshotBranch || process.env.SNAPSHOT_BRANCH
  );

  return {
    snapshotRepo,
    snapshotBranch,
  };
}

export async function setSnapshotRepoConfig(input: {
  snapshotRepo: string;
  snapshotBranch?: string;
  organizationId: string;
}): Promise<SnapshotRepoConfig> {
  const snapshotRepo = normalizeSnapshotRepo(input.snapshotRepo);
  const snapshotBranch = normalizeSnapshotBranch(input.snapshotBranch);

  if (!isValidSnapshotRepo(snapshotRepo)) {
    throw new Error("Invalid snapshot repository format");
  }

  const nextConfig: SnapshotRepoConfig = {
    snapshotRepo,
    snapshotBranch,
  };

  await kvSet(KV_KEYS.SNAPSHOT_REPO_CONFIG, nextConfig, input.organizationId);
  return nextConfig;
}
