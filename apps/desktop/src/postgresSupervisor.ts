import { spawn, } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

import type { DesktopDatabaseStatus } from "../../../src/desktopShell/contracts.js";
import { probeTcpPort } from "../../../src/runtime/databasePreflight.js";
import { createRuntimeFailure } from "../../../src/runtime/RuntimeFailure.js";
import type { BundledPostgresInstallation } from "./postgresBundle.js";
import { resolveBundledPostgresInstallation } from "./postgresBundle.js";

interface DesktopPostgresMetadata {
  version: 1;
  port: number;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  detail: string;
}

export interface DesktopPostgresSupervisorOptions {
  bundleRootPath: string;
  dataPath: string;
  logPath: string;
  metadataPath: string;
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
  fileExists?: ((targetPath: string) => boolean) | undefined;
  mkdirImpl?: typeof mkdir | undefined;
  readFileImpl?: typeof readFile | undefined;
  writeFileImpl?: typeof writeFile | undefined;
  rmImpl?: typeof rm | undefined;
  probeTcpPortImpl?: typeof probeTcpPort | undefined;
  allocatePort?: (() => Promise<number>) | undefined;
  spawnImpl?: typeof spawn | undefined;
}

export class DesktopPostgresSupervisor {
  private readonly options: DesktopPostgresSupervisorOptions;
  private status: DesktopDatabaseStatus = {
    state: "blocked",
    summary: "Bundled database not prepared.",
    managed: true,
    initialized: false,
    running: false,
  };

  constructor(options: DesktopPostgresSupervisorOptions) {
    this.options = options;
  }

  getStatus(): DesktopDatabaseStatus {
    return { ...this.status };
  }

  async ensureReady(): Promise<{ databaseUrl: string; status: DesktopDatabaseStatus }> {
    const installation = this.resolveInstallation();
    if (installation === undefined) {
      throw createRuntimeFailure(
        "DESKTOP_POSTGRES_BUNDLE_MISSING",
        "Bundled database installation is unavailable.",
      );
    }
    const metadata = await this.readOrCreateMetadata();
    await this.ensureClusterInitialized(installation);
    const alreadyRunning = await this.clearStalePidFile(metadata.port);
    if (!alreadyRunning) {
      await this.startCluster(installation, metadata.port);
    }
    await this.ensureDatabaseExists(installation, metadata.port);
    this.status = {
      state: "healthy",
      summary: "Bundled database ready.",
      managed: true,
      initialized: true,
      running: true,
      host: "127.0.0.1",
      port: metadata.port,
      database: "kestrel",
      logPath: this.options.logPath,
    };
    return {
      databaseUrl: buildManagedDatabaseUrl(metadata.port),
      status: this.getStatus(),
    };
  }

  async restart(): Promise<DesktopDatabaseStatus> {
    await this.stop();
    return (await this.ensureReady()).status;
  }

  async repair(): Promise<DesktopDatabaseStatus> {
    return this.restart();
  }

  async stop(): Promise<void> {
    const installation = this.resolveInstallation({ allowMissing: true });
    if (installation === undefined) {
      return;
    }
    await this.runCommand(installation, installation.pgCtlPath, [
      "stop",
      "-D",
      this.options.dataPath,
      "-m",
      "fast",
      "-w",
    ], 20_000, true);
    this.status = {
      ...this.status,
      state: this.status.lastError === undefined ? "degraded" : "blocked",
      summary: this.status.lastError === undefined ? "Bundled database stopped." : this.status.summary,
      running: false,
    };
  }

  getDataPath(): string {
    return this.options.dataPath;
  }

  private resolveInstallation(input: { allowMissing?: boolean | undefined } = {}): BundledPostgresInstallation | undefined {
    const installation = resolveBundledPostgresInstallation({
      bundleRootPath: this.options.bundleRootPath,
      platform: this.options.platform,
      arch: this.options.arch,
      fileExists: this.options.fileExists,
    });
    if (installation === undefined && input.allowMissing !== true) {
      const lastError = {
        code: "DESKTOP_POSTGRES_BUNDLE_MISSING",
        message: `No bundled Postgres installation was found under '${this.options.bundleRootPath}'.`,
        details: {
          bundleRootPath: this.options.bundleRootPath,
          platform: this.options.platform ?? process.platform,
          arch: this.options.arch ?? process.arch,
        },
      } as const;
      this.status = {
        state: "blocked",
        summary: "Bundled database is unavailable.",
        managed: true,
        initialized: false,
        running: false,
        logPath: this.options.logPath,
        lastError,
      };
      throw createRuntimeFailure(
        lastError.code,
        lastError.message,
        lastError.details,
      );
    }
    return installation;
  }

  private async readOrCreateMetadata(): Promise<DesktopPostgresMetadata> {
    try {
      const raw = await (this.options.readFileImpl ?? readFile)(this.options.metadataPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<DesktopPostgresMetadata>;
      if (parsed.version === 1 && Number.isInteger(parsed.port) && Number(parsed.port) > 0) {
        return {
          version: 1,
          port: Number(parsed.port),
        };
      }
    } catch {
      // Fall through and create fresh metadata.
    }
    const metadata: DesktopPostgresMetadata = {
      version: 1,
      port: await (this.options.allocatePort ?? reserveLocalPort)(),
    };
    await this.writeMetadata(metadata);
    return metadata;
  }

  private async writeMetadata(metadata: DesktopPostgresMetadata): Promise<void> {
    await (this.options.mkdirImpl ?? mkdir)(path.dirname(this.options.metadataPath), { recursive: true });
    await (this.options.writeFileImpl ?? writeFile)(
      this.options.metadataPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
  }

  private async ensureClusterInitialized(installation: BundledPostgresInstallation): Promise<void> {
    const initialized = await fileExists(path.join(this.options.dataPath, "PG_VERSION"));
    if (initialized) {
      this.status = {
        ...this.status,
        initialized: true,
      };
      return;
    }

    await (this.options.mkdirImpl ?? mkdir)(path.dirname(this.options.dataPath), { recursive: true });
    const initdb = await this.runCommand(installation, installation.initdbPath, [
      "-D",
      this.options.dataPath,
      "-U",
      "kestrel",
      "-A",
      "trust",
      "--encoding=UTF8",
      "--no-instructions",
    ], 60_000);
    if (!initdb.ok) {
      throw this.raiseFailure("DESKTOP_POSTGRES_INIT_FAILED", `Bundled database initialization failed: ${initdb.detail}`);
    }
    this.status = {
      ...this.status,
      initialized: true,
    };
  }

  private async clearStalePidFile(port: number): Promise<boolean> {
    const pidPath = path.join(this.options.dataPath, "postmaster.pid");
    if (!(await fileExists(pidPath))) {
      return false;
    }
    try {
      await (this.options.probeTcpPortImpl ?? probeTcpPort)("127.0.0.1", port, 1000);
      return true;
    } catch {
      await (this.options.rmImpl ?? rm)(pidPath, { force: true });
      return false;
    }
  }

  private async startCluster(installation: BundledPostgresInstallation, port: number): Promise<void> {
    await (this.options.mkdirImpl ?? mkdir)(path.dirname(this.options.logPath), { recursive: true });
    const start = await this.runCommand(installation, installation.pgCtlPath, [
      "start",
      "-D",
      this.options.dataPath,
      "-w",
      "-l",
      this.options.logPath,
      "-o",
      `-p ${port} -h 127.0.0.1`,
    ], 60_000);
    if (!start.ok) {
      throw this.raiseFailure("DESKTOP_POSTGRES_START_FAILED", `Bundled database could not start: ${start.detail}`, {
        port,
      });
    }
    try {
      await (this.options.probeTcpPortImpl ?? probeTcpPort)("127.0.0.1", port, 2500);
    } catch (error) {
      throw this.raiseFailure("DESKTOP_POSTGRES_HEALTHCHECK_FAILED", `Bundled database did not become ready on 127.0.0.1:${port}.`, {
        port,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async ensureDatabaseExists(installation: BundledPostgresInstallation, port: number): Promise<void> {
    const createdb = await this.runCommand(installation, installation.createdbPath, [
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-U",
      "kestrel",
      "kestrel",
    ], 20_000, true);
    if (createdb.ok) {
      return;
    }
    const stderr = createdb.stderr.toLowerCase();
    if (stderr.includes("already exists")) {
      return;
    }
    throw this.raiseFailure("DESKTOP_POSTGRES_DATABASE_CREATE_FAILED", `Bundled database is running, but the 'kestrel' database could not be prepared: ${createdb.detail}`, {
      port,
    });
  }

  private async runCommand(
    installation: BundledPostgresInstallation,
    command: string,
    args: string[],
    timeoutMs: number,
    allowNonZero = false,
  ): Promise<CommandResult> {
    const spawnImpl = this.options.spawnImpl ?? spawn;
    return await new Promise<CommandResult>((resolve) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
      };
      env.DYLD_LIBRARY_PATH = installation.libDir;
      env.PATH = `${installation.binDir}:${env.PATH ?? ""}`;
      env.PGDATA = this.options.dataPath;
      env.PGHOST = "127.0.0.1";
      const child = spawnImpl(command, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: CommandResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish({
          ok: false,
          stdout,
          stderr,
          detail: "timed out",
        });
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout = appendCommandOutput(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr = appendCommandOutput(stderr, chunk);
      });
      child.on("error", (error) => {
        finish({
          ok: false,
          stdout,
          stderr,
          detail: error instanceof Error ? error.message : String(error),
        });
      });
      child.on("close", (code) => {
        if (code === 0 || allowNonZero) {
          finish({
            ok: code === 0,
            stdout,
            stderr,
            detail: summarizeCommandOutput(stdout, stderr, code),
          });
          return;
        }
        finish({
          ok: false,
          stdout,
          stderr,
          detail: summarizeCommandOutput(stdout, stderr, code),
        });
      });
    });
  }

  private raiseFailure(code: string, message: string, details?: Record<string, unknown>): Error {
    this.status = {
      ...this.status,
      state: "blocked",
      summary: message,
      running: false,
      logPath: this.options.logPath,
      lastError: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    };
    return createRuntimeFailure(code, message, details);
  }
}

function appendCommandOutput(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk)}`;
  return next.length > 4000 ? next.slice(-4000) : next;
}

function summarizeCommandOutput(stdout: string, stderr: string, code: number | null): string {
  const combined = `${stderr.trim()} ${stdout.trim()}`.trim();
  if (combined.length > 0) {
    return combined.length > 240 ? `${combined.slice(0, 237).trimEnd()}...` : combined;
  }
  return `exit ${code ?? "unknown"}`;
}

async function reserveLocalPort(): Promise<number> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("Unable to reserve local port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function buildManagedDatabaseUrl(port: number): string {
  return `postgres://kestrel:kestrel@127.0.0.1:${port}/kestrel`;
}
