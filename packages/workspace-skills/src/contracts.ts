export const WORKSPACE_SKILL_STATUSES = [
  "pending",
  "syncing",
  "ready",
  "stale",
  "failed",
  "removal_pending",
] as const;

export type WorkspaceSkillStatus = (typeof WORKSPACE_SKILL_STATUSES)[number];

export interface WorkspaceSkillSource {
  gitUrl: string;
  branch: string;
  path?: string | undefined;
}

export interface WorkspaceSkillManifest {
  name: string;
  description: string;
}

export interface InstalledWorkspaceSkillRevision extends WorkspaceSkillManifest {
  installationId: string;
  commitSha: string;
  contentDigest: string;
  relativeRoot: string;
  skillFile: string;
  installedAt: string;
  fileCount: number;
  totalBytes: number;
}

export interface WorkspaceSkillInstallation {
  installationId: string;
  workspaceId: string;
  source: WorkspaceSkillSource;
  status: WorkspaceSkillStatus;
  createdAt: string;
  updatedAt: string;
  revision?: InstalledWorkspaceSkillRevision | undefined;
  lastSyncAttemptAt?: string | undefined;
  lastSyncError?: string | undefined;
}

export interface WorkspaceSkillCatalogEntry extends WorkspaceSkillManifest {
  installationId: string;
  commitSha: string;
  contentDigest: string;
  skillFile: string;
}

export interface WorkspaceSkillSyncResult {
  status: "ready" | "stale" | "failed";
  changed: boolean;
  attemptedAt: string;
  revision?: InstalledWorkspaceSkillRevision | undefined;
  error?: string | undefined;
}
