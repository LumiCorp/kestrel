import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { resolveKestrelHomePath } from "../../src/runtime/kestrelHome.js";
import { resolveLocalCoreStoreClient } from "../localCoreStoreClient.js";

const LOGS_DIR_NAME = "logs";
const DIAGNOSTICS_FILE_NAME = "tui-diagnostics.log";

export interface DiagnosticLogEntry {
  scope: string;
  summary: string;
  details?: string | undefined;
  sessionId?: string | undefined;
  profileId?: string | undefined;
  workspaceId?: string | undefined;
  cwd?: string | undefined;
}

export class DiagnosticLogStore {
  private readonly baseDir: string;
  private readonly logsDir: string;
  private readonly filePath: string;

  constructor(baseDir = resolveKestrelHomePath()) {
    this.baseDir = baseDir;
    this.logsDir = path.join(this.baseDir, LOGS_DIR_NAME);
    this.filePath = path.join(this.logsDir, DIAGNOSTICS_FILE_NAME);
  }

  getFilePath(): string {
    return this.filePath;
  }

  getDisplayPath(): string {
    const home = homedir();
    return this.filePath.startsWith(`${home}${path.sep}`)
      ? `~${this.filePath.slice(home.length)}`
      : this.filePath;
  }

  async append(entry: DiagnosticLogEntry): Promise<void> {
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      await core.client.postJson("/v1/diagnostics/log", { entry });
      return;
    }

    await mkdir(this.logsDir, { recursive: true });
    await appendFile(this.filePath, `${formatEntry(entry)}\n`, "utf8");
  }
}

function formatEntry(entry: DiagnosticLogEntry): string {
  const lines = [
    `[${new Date().toISOString()}] ${entry.scope}`,
    `summary: ${entry.summary}`,
    ...(entry.sessionId !== undefined ? [`sessionId: ${entry.sessionId}`] : []),
    ...(entry.profileId !== undefined ? [`profileId: ${entry.profileId}`] : []),
    ...(entry.workspaceId !== undefined ? [`workspaceId: ${entry.workspaceId}`] : []),
    ...(entry.cwd !== undefined ? [`cwd: ${entry.cwd}`] : []),
  ];

  if (entry.details !== undefined && entry.details.trim().length > 0) {
    lines.push("details:");
    lines.push(entry.details);
  }

  lines.push("---");
  return lines.join("\n");
}
