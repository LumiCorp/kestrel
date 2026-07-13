import { randomUUID } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { resolveWorkspacePath, WorkspaceRequestError } from "./security.js";

export type WorkspaceApplication = {
  id: string;
  name: string;
  command: string;
  workingDirectory: string;
  port: number;
  desiredState: "running" | "stopped";
  status: "starting" | "running" | "stopped" | "failed";
  processId: number | null;
  createdAt: string;
  updatedAt: string;
};

export class WorkspaceApplicationRegistry {
  private readonly applications = new Map<string, WorkspaceApplication>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly registryPath: string;

  constructor(private readonly workspaceRoot: string) {
    this.registryPath = path.join(workspaceRoot, ".kestrel", "applications.json");
  }

  async restore() {
    try {
      const rows = JSON.parse(await readFile(this.registryPath, "utf8")) as unknown;
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        const parsed = parseStoredApplication(row);
        if (parsed) {
          this.applications.set(parsed.id, {
            ...parsed,
            status: "stopped",
            processId: null,
          });
        }
      }
    } catch {}
    for (const application of this.applications.values()) {
      if (application.desiredState !== "running") continue;
      await this.start(application.id).catch(async () => {
        Object.assign(application, {
          status: "failed",
          processId: null,
          updatedAt: new Date().toISOString(),
        });
        await this.persist();
      });
    }
  }

  list() {
    return [...this.applications.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  get(id: string) {
    return this.applications.get(id) ?? null;
  }

  async register(value: unknown) {
    const input = parseRegistration(value, this.workspaceRoot);
    const now = new Date().toISOString();
    const application: WorkspaceApplication = {
      id: randomUUID(),
      ...input,
      desiredState: "running",
      status: "starting",
      processId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.applications.set(application.id, application);
    await this.start(application.id);
    return this.get(application.id)!;
  }

  async start(id: string) {
    const application = this.applications.get(id);
    if (!application) throw new WorkspaceRequestError(404, "APPLICATION_NOT_FOUND");
    if (this.processes.has(id)) return application;
    Object.assign(application, {
      desiredState: "running",
      status: "starting",
      processId: null,
      updatedAt: new Date().toISOString(),
    });
    await this.persist();
    const log = await open(
      path.join(this.workspaceRoot, ".kestrel", `application-${id}.log`),
      "a"
    );
    const child = spawn("/bin/sh", ["-lc", application.command], {
      cwd: resolveWorkspacePath(this.workspaceRoot, application.workingDirectory),
      env: { ...process.env, PORT: String(application.port) },
      stdio: ["ignore", log.fd, log.fd],
    });
    this.processes.set(id, child);
    Object.assign(application, {
      status: "running",
      processId: child.pid ?? null,
      updatedAt: new Date().toISOString(),
    });
    child.once("exit", (code) => {
      this.processes.delete(id);
      Object.assign(application, {
        status:
          application.desiredState === "stopped" || code === 0
            ? "stopped"
            : "failed",
        processId: null,
        updatedAt: new Date().toISOString(),
      });
      void this.persist();
      void log.close();
    });
    await this.persist();
    return application;
  }

  async stop(id: string) {
    const application = this.applications.get(id);
    if (!application) throw new WorkspaceRequestError(404, "APPLICATION_NOT_FOUND");
    const child = this.processes.get(id);
    Object.assign(application, {
      desiredState: "stopped",
      status: child ? "running" : "stopped",
      processId: child?.pid ?? null,
      updatedAt: new Date().toISOString(),
    });
    await this.persist();
    child?.kill("SIGTERM");
    return application;
  }

  async stopAll() {
    for (const child of this.processes.values()) child.kill("SIGTERM");
    this.processes.clear();
  }

  private async persist() {
    await writeFile(
      this.registryPath,
      JSON.stringify(this.list(), null, 2),
      "utf8"
    );
  }
}

export function parseRegistration(value: unknown, workspaceRoot: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceRequestError(400, "APPLICATION_INPUT_INVALID");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 120 ||
    typeof input.command !== "string" ||
    !input.command.trim() ||
    input.command.length > 2000 ||
    typeof input.port !== "number" ||
    !Number.isInteger(input.port) ||
    input.port < 1024 ||
    input.port > 65_535 ||
    input.port === 43_104 ||
    input.port === 43_105
  ) {
    throw new WorkspaceRequestError(400, "APPLICATION_INPUT_INVALID");
  }
  const workingDirectory =
    typeof input.workingDirectory === "string" ? input.workingDirectory : "";
  resolveWorkspacePath(workspaceRoot, workingDirectory);
  return {
    name: input.name.trim(),
    command: input.command.trim(),
    workingDirectory,
    port: input.port,
  };
}

function parseStoredApplication(value: unknown): WorkspaceApplication | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" &&
    typeof row.name === "string" &&
    typeof row.command === "string" &&
    typeof row.workingDirectory === "string" &&
    typeof row.port === "number" &&
    typeof row.createdAt === "string" &&
    typeof row.updatedAt === "string" &&
    (row.desiredState === undefined ||
      row.desiredState === "running" ||
      row.desiredState === "stopped")
    ? ({
        ...row,
        desiredState: row.desiredState ?? "running",
      } as WorkspaceApplication)
    : null;
}
