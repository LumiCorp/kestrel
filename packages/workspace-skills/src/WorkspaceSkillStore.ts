import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  InstalledWorkspaceSkillRevision,
  WorkspaceSkillInstallation,
  WorkspaceSkillSource,
  WorkspaceSkillSyncResult,
} from "./contracts.js";
import { WorkspaceSkillInstaller } from "./WorkspaceSkillInstaller.js";

interface WorkspaceSkillsFile {
  version: 1;
  workspaceId: string;
  installations: WorkspaceSkillInstallation[];
}

export class WorkspaceSkillStore {
  private readonly filePath: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly workspaceId: string,
  ) {
    this.filePath = path.join(path.resolve(workspaceRoot), ".kestrel", "skills", "installations.json");
  }

  async load(): Promise<WorkspaceSkillInstallation[]> {
    try {
      const parsed = parseWorkspaceSkillsFile(JSON.parse(await readFile(this.filePath, "utf8")));
      if (parsed.workspaceId !== this.workspaceId) throw new Error("Workspace skill catalog belongs to a different workspace.");
      return parsed.installations;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(installations: readonly WorkspaceSkillInstallation[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, workspaceId: this.workspaceId, installations }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temp, this.filePath);
  }
}

export interface WorkspaceSkillManagerDependencies {
  installer?: WorkspaceSkillInstaller | undefined;
  now?: (() => Date) | undefined;
  isWorkspaceIdle?: (() => Promise<boolean>) | undefined;
}

export class WorkspaceSkillManager {
  private readonly store: WorkspaceSkillStore;
  private readonly installer: WorkspaceSkillInstaller;
  private readonly now: () => Date;
  private readonly isWorkspaceIdle: () => Promise<boolean>;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspace: { workspaceId: string; workspaceRoot: string },
    dependencies: WorkspaceSkillManagerDependencies = {},
  ) {
    this.store = new WorkspaceSkillStore(workspace.workspaceRoot, workspace.workspaceId);
    this.installer = dependencies.installer ?? new WorkspaceSkillInstaller();
    this.now = dependencies.now ?? (() => new Date());
    this.isWorkspaceIdle = dependencies.isWorkspaceIdle ?? (async () => true);
  }

  async list(): Promise<WorkspaceSkillInstallation[]> {
    return this.store.load();
  }

  async install(source: WorkspaceSkillSource): Promise<WorkspaceSkillInstallation> {
    return this.exclusive(() => this.installUnlocked(source));
  }

  private async installUnlocked(source: WorkspaceSkillSource): Promise<WorkspaceSkillInstallation> {
    const now = this.now().toISOString();
    const installation: WorkspaceSkillInstallation = {
      installationId: randomUUID(),
      workspaceId: this.workspace.workspaceId,
      source,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const installations = await this.store.load();
    await this.store.save([...installations, installation]);
    return (await this.isWorkspaceIdle()) ? this.syncUnlocked(installation.installationId) : installation;
  }

  async updateSource(installationId: string, source: WorkspaceSkillSource): Promise<WorkspaceSkillInstallation> {
    return this.exclusive(async () => {
      const next = await this.updateSourceUnlocked(installationId, source);
      return (await this.isWorkspaceIdle()) ? this.syncUnlocked(next.installationId) : next;
    });
  }

  private async updateSourceUnlocked(installationId: string, source: WorkspaceSkillSource): Promise<WorkspaceSkillInstallation> {
    const installations = await this.store.load();
    const current = requireInstallation(installations, installationId);
    const next: WorkspaceSkillInstallation = {
      ...current,
      source,
      status: "pending",
      updatedAt: this.now().toISOString(),
      lastSyncError: undefined,
    };
    await this.store.save(replaceInstallation(installations, next));
    return next;
  }

  async syncAll(): Promise<WorkspaceSkillInstallation[]> {
    return this.exclusive(() => this.syncAllUnlocked());
  }

  private async syncAllUnlocked(): Promise<WorkspaceSkillInstallation[]> {
    if (!(await this.isWorkspaceIdle())) return this.store.load();
    const snapshot = await this.store.load();
    const results: WorkspaceSkillInstallation[] = [];
    for (const installation of snapshot) {
      if (installation.status === "removal_pending") {
        await this.installer.remove({ workspaceRoot: this.workspace.workspaceRoot, installationId: installation.installationId });
        const remaining = (await this.store.load()).filter((candidate) => candidate.installationId !== installation.installationId);
        await this.store.save(remaining);
        continue;
      }
      results.push(await this.syncUnlocked(installation.installationId));
    }
    return results;
  }

  async sync(installationId: string): Promise<WorkspaceSkillInstallation> {
    return this.exclusive(() => this.syncUnlocked(installationId));
  }

  private async syncUnlocked(installationId: string): Promise<WorkspaceSkillInstallation> {
    if (!(await this.isWorkspaceIdle())) throw new Error("Workspace skills can only sync while the workspace is idle.");
    let installations = await this.store.load();
    const current = requireInstallation(installations, installationId);
    const syncing: WorkspaceSkillInstallation = {
      ...current,
      status: "syncing",
      updatedAt: this.now().toISOString(),
      lastSyncError: undefined,
    };
    await this.store.save(replaceInstallation(installations, syncing));
    const result = await this.installer.sync({
      workspaceRoot: this.workspace.workspaceRoot,
      installationId,
      source: current.source,
      acceptManifest: async (manifest) => {
        const duplicates = (await this.store.load()).filter((candidate) =>
          candidate.installationId !== installationId &&
          candidate.revision?.name === manifest.name &&
          (candidate.status === "ready" || candidate.status === "stale")
        );
        if (duplicates.length > 0) throw new Error(`Workspace already has an installed skill named '${manifest.name}'.`);
      },
    });
    installations = await this.store.load();
    const latest = requireInstallation(installations, installationId);
    const next = applySyncResult(latest, result, this.now().toISOString());
    await this.store.save(replaceInstallation(installations, next));
    return next;
  }

  async remove(installationId: string): Promise<void> {
    return this.exclusive(() => this.removeUnlocked(installationId));
  }

  private async removeUnlocked(installationId: string): Promise<void> {
    const installations = await this.store.load();
    const current = requireInstallation(installations, installationId);
    if (!(await this.isWorkspaceIdle())) {
      await this.store.save(replaceInstallation(installations, {
        ...current,
        status: "removal_pending",
        updatedAt: this.now().toISOString(),
      }));
      return;
    }
    await this.installer.remove({ workspaceRoot: this.workspace.workspaceRoot, installationId });
    await this.store.save(installations.filter((candidate) => candidate.installationId !== installationId));
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function applySyncResult(
  installation: WorkspaceSkillInstallation,
  result: WorkspaceSkillSyncResult,
  updatedAt: string,
): WorkspaceSkillInstallation {
  return {
    ...installation,
    status: result.status,
    updatedAt,
    lastSyncAttemptAt: result.attemptedAt,
    ...(result.revision !== undefined ? { revision: result.revision } : {}),
    ...(result.error !== undefined ? { lastSyncError: result.error } : { lastSyncError: undefined }),
  };
}

function replaceInstallation(
  installations: readonly WorkspaceSkillInstallation[],
  next: WorkspaceSkillInstallation,
): WorkspaceSkillInstallation[] {
  return installations.map((candidate) => candidate.installationId === next.installationId ? next : candidate);
}

function requireInstallation(
  installations: readonly WorkspaceSkillInstallation[],
  installationId: string,
): WorkspaceSkillInstallation {
  const installation = installations.find((candidate) => candidate.installationId === installationId);
  if (installation === undefined) throw new Error(`Workspace skill installation '${installationId}' was not found.`);
  return installation;
}

function parseWorkspaceSkillsFile(value: unknown): WorkspaceSkillsFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Workspace skill catalog must be an object.");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.workspaceId !== "string" || !Array.isArray(record.installations)) {
    throw new Error("Workspace skill catalog has an unsupported schema.");
  }
  return {
    version: 1,
    workspaceId: record.workspaceId,
    installations: record.installations.map(parseInstallation),
  };
}

function parseInstallation(value: unknown): WorkspaceSkillInstallation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Workspace skill installation must be an object.");
  const record = value as Record<string, unknown>;
  const source = record.source;
  if (typeof source !== "object" || source === null || Array.isArray(source)) throw new Error("Workspace skill source is invalid.");
  const sourceRecord = source as Record<string, unknown>;
  const required = (key: string) => {
    const candidate = record[key];
    if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`Workspace skill installation '${key}' is invalid.`);
    return candidate;
  };
  const status = required("status") as WorkspaceSkillInstallation["status"];
  if (!["pending", "syncing", "ready", "stale", "failed", "removal_pending"].includes(status)) throw new Error("Workspace skill installation status is invalid.");
  const installationId = required("installationId");
  const gitUrl = typeof sourceRecord.gitUrl === "string" ? sourceRecord.gitUrl.trim() : "";
  const branch = typeof sourceRecord.branch === "string" ? sourceRecord.branch.trim() : "";
  if (!gitUrl || !branch) throw new Error("Workspace skill source is invalid.");
  return {
    installationId,
    workspaceId: required("workspaceId"),
    source: {
      gitUrl,
      branch,
      ...(typeof sourceRecord.path === "string" ? { path: sourceRecord.path } : {}),
    },
    status,
    createdAt: required("createdAt"),
    updatedAt: required("updatedAt"),
    ...(record.revision !== undefined
      ? { revision: parseStoredRevision(record.revision, installationId) }
      : {}),
    ...(typeof record.lastSyncAttemptAt === "string" ? { lastSyncAttemptAt: record.lastSyncAttemptAt } : {}),
    ...(typeof record.lastSyncError === "string" ? { lastSyncError: record.lastSyncError } : {}),
  };
}

function parseStoredRevision(value: unknown, installationId: string): InstalledWorkspaceSkillRevision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Workspace skill revision is invalid.");
  const record = value as Record<string, unknown>;
  const required = (key: string) => {
    const candidate = record[key];
    if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`Workspace skill revision '${key}' is invalid.`);
    return candidate;
  };
  if (required("installationId") !== installationId) throw new Error("Workspace skill revision belongs to a different installation.");
  const fileCount = record.fileCount;
  const totalBytes = record.totalBytes;
  if (!Number.isSafeInteger(fileCount) || (fileCount as number) < 1 || !Number.isSafeInteger(totalBytes) || (totalBytes as number) < 1) {
    throw new Error("Workspace skill revision size metadata is invalid.");
  }
  return {
    installationId,
    name: required("name"),
    description: required("description"),
    commitSha: required("commitSha"),
    contentDigest: required("contentDigest"),
    relativeRoot: required("relativeRoot"),
    skillFile: required("skillFile"),
    installedAt: required("installedAt"),
    fileCount: fileCount as number,
    totalBytes: totalBytes as number,
  };
}
