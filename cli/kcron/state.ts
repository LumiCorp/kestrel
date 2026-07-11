import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractResponseField, resolveLocalCoreStoreClient } from "../localCoreStoreClient.js";

export interface KcronWorkspaceState {
  workspaceId: string;
  rootPath: string;
  lastEvaluatedAt?: string | undefined;
  lastRunAt?: string | undefined;
  nextRunAt?: string | undefined;
  lastOutcome?: "completed" | "failed" | "skipped_overlap" | "stale" | "disabled" | "not_due" | "deferred" | undefined;
  lastError?: string | undefined;
  runningPid?: number | undefined;
  runningStartedAt?: string | undefined;
  lastSkipReason?: string | undefined;
}

export interface KcronStateFile {
  version: 1;
  daemon?: {
    pid: number;
    startedAt: string;
    heartbeatAt?: string | undefined;
  } | undefined;
  workspaces: Record<string, KcronWorkspaceState>;
}

export class KcronStateStore {
  private readonly baseDir: string;
  private readonly dirPath: string;
  private readonly filePath: string;

  constructor(homeDir: string) {
    this.baseDir = homeDir;
    this.dirPath = path.join(this.baseDir, "kcron");
    this.filePath = path.join(this.dirPath, "state.json");
  }

  async load(): Promise<KcronStateFile> {
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      return extractResponseField<KcronStateFile>(
        await core.client.getJson("/v1/kcron/state"),
        "state",
        "kcron state",
      );
    }

    await mkdir(this.dirPath, { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<KcronStateFile>;
      return {
        version: 1,
        ...(parsed.daemon !== undefined ? { daemon: parsed.daemon } : {}),
        workspaces: parsed.workspaces ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const empty: KcronStateFile = {
          version: 1,
          workspaces: {},
        };
        await this.save(empty);
        return empty;
      }
      throw error;
    }
  }

  async save(state: KcronStateFile): Promise<void> {
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      await core.client.putJson("/v1/kcron/state", { state });
      return;
    }

    await mkdir(this.dirPath, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}
