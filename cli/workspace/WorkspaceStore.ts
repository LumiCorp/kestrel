import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  WorkspaceRegistryEntry,
  WorkspacesFile,
} from "../contracts.js";
import { resolveKestrelHomePath } from "../../src/runtime/kestrelHome.js";
import { extractResponseField, resolveLocalCoreStoreClient } from "../localCoreStoreClient.js";

const WORKSPACES_FILE_NAME = "workspaces.json";

export class WorkspaceStore {
  private readonly baseDir: string;
  private readonly filePath: string;

  constructor(baseDir = resolveKestrelHomePath()) {
    this.baseDir = baseDir;
    this.filePath = path.join(this.baseDir, WORKSPACES_FILE_NAME);
  }

  async load(): Promise<WorkspacesFile> {
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      return {
        version: 3,
        workspaces: extractResponseField<WorkspaceRegistryEntry[]>(
          await core.client.getJson("/v1/workspaces"),
          "workspaces",
          "workspaces",
        ),
      };
    }

    await mkdir(this.baseDir, { recursive: true });

    const raw = await this.readRawFile();
    if (raw === undefined) {
      const empty: WorkspacesFile = {
        version: 3,
        workspaces: [],
      };
      await this.save(empty);
      return empty;
    }

    try {
      return parseWorkspacesFile(raw);
    } catch (error) {
      if (error instanceof WorkspaceSchemaVersionError) {
        const empty: WorkspacesFile = {
          version: 3,
          workspaces: [],
        };
        await this.save(empty);
        return empty;
      }
      throw error;
    }
  }

  async save(file: WorkspacesFile): Promise<void> {
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      await core.client.putJson("/v1/workspaces", { workspaces: file });
      return;
    }

    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }

  upsert(file: WorkspacesFile, entry: WorkspaceRegistryEntry): WorkspacesFile {
    const normalizedRootPath = path.resolve(entry.rootPath);
    const workspaces = [...file.workspaces];
    const index = workspaces.findIndex((workspace) =>
      workspace.workspaceId === entry.workspaceId ||
      path.resolve(workspace.rootPath) === normalizedRootPath,
    );
    const existing = index >= 0 ? workspaces[index] : undefined;
    const normalizedEntry: WorkspaceRegistryEntry = {
      ...entry,
      rootPath: normalizedRootPath,
      automationEnabled: entry.automationEnabled ?? existing?.automationEnabled ?? false,
      ...(entry.automationEnabledAt !== undefined
        ? { automationEnabledAt: entry.automationEnabledAt }
        : existing?.automationEnabledAt !== undefined
          ? { automationEnabledAt: existing.automationEnabledAt }
          : {}),
    };
    if (index >= 0) {
      workspaces[index] = normalizedEntry;
    } else {
      workspaces.push(normalizedEntry);
    }

    return {
      version: 3,
      workspaces: workspaces.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)),
    };
  }

  findById(file: WorkspacesFile, workspaceId: string): WorkspaceRegistryEntry | undefined {
    return file.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
  }

  findByRootPath(file: WorkspacesFile, rootPath: string): WorkspaceRegistryEntry | undefined {
    const normalized = path.resolve(rootPath);
    return file.workspaces.find((workspace) => path.resolve(workspace.rootPath) === normalized);
  }

  private async readRawFile(): Promise<string | undefined> {
    try {
      return await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return ;
      }

      throw error;
    }
  }
}

export function parseWorkspacesFile(raw: string): WorkspacesFile {
  let decoded: unknown;

  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid workspaces JSON: ${error instanceof Error ? error.message : "unknown parse error"}`,
    );
  }

  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("workspaces.json must be an object");
  }

  const root = decoded as Record<string, unknown>;
  if (root.version !== 3) {
    throw new WorkspaceSchemaVersionError("workspaces.json version must be 3");
  }

  if (Array.isArray(root.workspaces) === false) {
    throw new Error("workspaces.json workspaces must be an array");
  }

  return {
    version: 3,
    workspaces: root.workspaces.map((entry) => validateWorkspaceRegistryEntry(entry)),
  };
}

class WorkspaceSchemaVersionError extends Error {}

function validateWorkspaceRegistryEntry(value: unknown): WorkspaceRegistryEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("workspace registry entries must be objects");
  }

  const entry = value as Record<string, unknown>;
  return {
    workspaceId: readRequiredString(entry, "workspaceId"),
    rootPath: path.resolve(readRequiredString(entry, "rootPath")),
    ...(typeof entry.launchCwd === "string" ? { launchCwd: path.resolve(entry.launchCwd) } : {}),
    discoveredAt: readRequiredString(entry, "discoveredAt"),
    updatedAt: readRequiredString(entry, "updatedAt"),
    automationEnabled: readBoolean(entry, "automationEnabled", false),
    ...(typeof entry.automationEnabledAt === "string" ? { automationEnabledAt: entry.automationEnabledAt } : {}),
    ...(typeof entry.label === "string" ? { label: entry.label } : {}),
    ...(typeof entry.lastUsedAt === "string" ? { lastUsedAt: entry.lastUsedAt } : {}),
  };
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
  const maybe = value[key];
  if (typeof maybe !== "string" || maybe.trim().length === 0) {
    throw new Error(`Workspace field '${key}' must be a non-empty string`);
  }
  return maybe;
}

function readBoolean(
  value: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const maybe = value[key];
  return typeof maybe === "boolean" ? maybe : fallback;
}
