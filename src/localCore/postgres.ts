import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LocalCoreDatabaseStatus, LocalCoreFailure, LocalCorePaths } from "./contracts.js";

const LOCAL_CORE_POSTGRES_METADATA_VERSION = 1;
const DEFAULT_SOCKET_PORT = 5432;
const MAX_COMMAND_OUTPUT_CHARS = 4_000;

export interface LocalCorePostgresMetadata {
  version: typeof LOCAL_CORE_POSTGRES_METADATA_VERSION;
  port: number;
  database: "kestrel";
  user: "kestrel";
  dataPath: string;
  socketPath: string;
}

export interface LocalCorePostgresInstallation {
  rootPath: string;
  binDir: string;
  libDir: string;
  shareDir: string;
  initdbPath: string;
  postgresPath: string;
  pgCtlPath: string;
  createdbPath: string;
}

export interface LocalCorePostgresCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  detail: string;
}

export interface LocalCorePostgresCommandInput {
  installation: LocalCorePostgresInstallation;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  allowNonZero: boolean;
}

export interface EnsureLocalCoreManagedPostgresOptions {
  paths: LocalCorePaths;
  bundleRootPath: string;
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
  fileExists?: ((targetPath: string) => boolean | Promise<boolean>) | undefined;
  mkdirImpl?: typeof mkdir | undefined;
  readFileImpl?: typeof readFile | undefined;
  writeFileImpl?: typeof writeFile | undefined;
  rmImpl?: typeof rm | undefined;
  runCommandImpl?: ((input: LocalCorePostgresCommandInput) => Promise<LocalCorePostgresCommandResult>) | undefined;
  probeSocketImpl?: ((input: { socketPath: string; port: number }) => Promise<void>) | undefined;
  isPidAlive?: ((pid: number) => boolean) | undefined;
}

export async function ensureLocalCoreManagedPostgres(
  options: EnsureLocalCoreManagedPostgresOptions,
): Promise<{ databaseUrl: string; status: LocalCoreDatabaseStatus } | { status: LocalCoreDatabaseStatus }> {
  const supervisor = new LocalCorePostgresSupervisor(options);
  try {
    return await supervisor.ensureReady();
  } catch (error) {
    if (error instanceof LocalCorePostgresError) {
      return {
        status: blockedManagedStatus(options.paths, error.failure),
      };
    }
    return {
      status: blockedManagedStatus(options.paths, {
        code: "LOCAL_CORE_POSTGRES_UNEXPECTED_FAILURE",
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

export function resolveLocalCorePostgresInstallation(input: {
  bundleRootPath: string;
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
  fileExists?: ((targetPath: string) => boolean | Promise<boolean>) | undefined;
}): Promise<LocalCorePostgresInstallation | undefined> {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const candidates = [
    path.join(input.bundleRootPath, `${platform}-${arch}`),
    input.bundleRootPath,
  ];

  return (async () => {
    for (const rootPath of candidates) {
      const installation = buildInstallation(rootPath);
      if (
        await pathExists(installation.initdbPath, input.fileExists) &&
        await pathExists(installation.postgresPath, input.fileExists) &&
        await pathExists(installation.pgCtlPath, input.fileExists) &&
        await pathExists(installation.createdbPath, input.fileExists)
      ) {
        return installation;
      }
    }
    return undefined;
  })();
}

export function buildLocalCoreManagedDatabaseUrl(input: {
  socketPath: string;
  port: number;
  database?: string | undefined;
  user?: string | undefined;
}): string {
  const database = input.database ?? "kestrel";
  const user = input.user ?? "kestrel";
  const search = new URLSearchParams({
    host: input.socketPath,
    port: String(input.port),
  });
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(user)}@localhost/${encodeURIComponent(database)}?${search.toString()}`;
}

export class LocalCorePostgresSupervisor {
  private readonly options: EnsureLocalCoreManagedPostgresOptions;

  constructor(options: EnsureLocalCoreManagedPostgresOptions) {
    this.options = options;
  }

  async ensureReady(): Promise<{ databaseUrl: string; status: LocalCoreDatabaseStatus } | { status: LocalCoreDatabaseStatus }> {
    const installation = await resolveLocalCorePostgresInstallation({
      bundleRootPath: this.options.bundleRootPath,
      platform: this.options.platform,
      arch: this.options.arch,
      fileExists: this.options.fileExists,
    });
    if (installation === undefined) {
      return {
        status: this.blocked("LOCAL_CORE_POSTGRES_BUNDLE_MISSING", "Kestrel Local Core managed database bundle is unavailable.", {
          bundleRootPath: this.options.bundleRootPath,
          platform: this.options.platform ?? process.platform,
          arch: this.options.arch ?? process.arch,
        }),
      };
    }

    const metadata = await this.readOrCreateMetadata();
    await this.ensureClusterInitialized(installation);
    const existing = await this.inspectExistingPostmaster(metadata);
    if (existing.state === "repair_required") {
      return { status: existing.status };
    }
    if (existing.running === false) {
      const started = await this.startCluster(installation, metadata);
      if ("status" in started) {
        return started;
      }
    }
    const ensured = await this.ensureDatabaseExists(installation, metadata);
    if ("status" in ensured) {
      return ensured;
    }

    const databaseUrl = buildLocalCoreManagedDatabaseUrl(metadata);
    return {
      databaseUrl,
      status: {
        mode: "managed",
        state: "healthy",
        summary: "Kestrel Local Core managed database ready.",
        managed: true,
        initialized: true,
        running: true,
        identityVerified: true,
        dataPath: metadata.dataPath,
        socketPath: metadata.socketPath,
        metadataPath: this.options.paths.postgresMetadataPath,
        databaseUrl,
        database: metadata.database,
        user: metadata.user,
        port: metadata.port,
        logPath: this.options.paths.postgresLogPath,
      },
    };
  }

  private async readOrCreateMetadata(): Promise<LocalCorePostgresMetadata> {
    try {
      const raw = await (this.options.readFileImpl ?? readFile)(this.options.paths.postgresMetadataPath, "utf8");
      const parsed = parseMetadata(JSON.parse(raw), this.options.paths);
      if (parsed !== undefined) {
        return parsed;
      }
    } catch {
      // Fall through and create fresh metadata.
    }

    const metadata: LocalCorePostgresMetadata = {
      version: LOCAL_CORE_POSTGRES_METADATA_VERSION,
      port: DEFAULT_SOCKET_PORT,
      database: "kestrel",
      user: "kestrel",
      dataPath: this.options.paths.postgresDataPath,
      socketPath: this.options.paths.postgresSocketPath,
    };
    await this.writeMetadata(metadata);
    return metadata;
  }

  private async writeMetadata(metadata: LocalCorePostgresMetadata): Promise<void> {
    await (this.options.mkdirImpl ?? mkdir)(path.dirname(this.options.paths.postgresMetadataPath), { recursive: true });
    await (this.options.writeFileImpl ?? writeFile)(
      this.options.paths.postgresMetadataPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
  }

  private async ensureClusterInitialized(installation: LocalCorePostgresInstallation): Promise<void> {
    if (await pathExists(path.join(this.options.paths.postgresDataPath, "PG_VERSION"), this.options.fileExists)) {
      return;
    }
    await (this.options.mkdirImpl ?? mkdir)(path.dirname(this.options.paths.postgresDataPath), { recursive: true });
    await (this.options.mkdirImpl ?? mkdir)(this.options.paths.postgresSocketPath, { recursive: true });
    const initdb = await this.runCommand(installation, installation.initdbPath, [
      "-D",
      this.options.paths.postgresDataPath,
      "-U",
      "kestrel",
      "-A",
      "trust",
      "--encoding=UTF8",
      "--no-instructions",
    ], 60_000);
    if (!initdb.ok) {
      throw new LocalCorePostgresError(this.failure("LOCAL_CORE_POSTGRES_INIT_FAILED", `Kestrel Local Core managed database initialization failed: ${initdb.detail}`));
    }
  }

  private async inspectExistingPostmaster(metadata: LocalCorePostgresMetadata): Promise<
    | { state: "ok"; running: boolean }
    | { state: "repair_required"; status: LocalCoreDatabaseStatus }
  > {
    const pidPath = path.join(this.options.paths.postgresDataPath, "postmaster.pid");
    if (!(await pathExists(pidPath, this.options.fileExists))) {
      return { state: "ok", running: false };
    }

    let pidFile: PostmasterPidFile | undefined;
    try {
      pidFile = parsePostmasterPidFile(await (this.options.readFileImpl ?? readFile)(pidPath, "utf8"));
    } catch {
      pidFile = undefined;
    }
    if (pidFile === undefined) {
      return {
        state: "repair_required",
        status: this.blocked("LOCAL_CORE_POSTGRES_PID_REPAIR_REQUIRED", "Kestrel Local Core managed database pid file is invalid.", {
          pidPath,
        }),
      };
    }
    if (path.resolve(pidFile.dataPath) !== path.resolve(metadata.dataPath)) {
      return {
        state: "repair_required",
        status: this.blocked("LOCAL_CORE_POSTGRES_IDENTITY_MISMATCH", "Kestrel Local Core managed database pid file points at a different data directory.", {
          pidPath,
          expectedDataPath: metadata.dataPath,
          actualDataPath: pidFile.dataPath,
        }),
      };
    }
    if (pidFile.port !== metadata.port || path.resolve(pidFile.socketPath) !== path.resolve(metadata.socketPath)) {
      return {
        state: "repair_required",
        status: this.blocked("LOCAL_CORE_POSTGRES_SOCKET_MISMATCH", "Kestrel Local Core managed database pid file points at a different socket.", {
          pidPath,
          expectedSocketPath: metadata.socketPath,
          actualSocketPath: pidFile.socketPath,
          expectedPort: metadata.port,
          actualPort: pidFile.port,
        }),
      };
    }
    if (this.options.isPidAlive?.(pidFile.pid) === false) {
      await (this.options.rmImpl ?? rm)(pidPath, { force: true });
      return { state: "ok", running: false };
    }

    try {
      await this.probeSocket(metadata);
      return { state: "ok", running: true };
    } catch (error) {
      if (this.options.isPidAlive?.(pidFile.pid) === true) {
        return {
          state: "repair_required",
          status: this.blocked("LOCAL_CORE_POSTGRES_SOCKET_UNAVAILABLE", "Kestrel Local Core managed database process is alive but its private socket is unavailable.", {
            pidPath,
            socketPath: metadata.socketPath,
            port: metadata.port,
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
      await (this.options.rmImpl ?? rm)(pidPath, { force: true });
      return { state: "ok", running: false };
    }
  }

  private async startCluster(
    installation: LocalCorePostgresInstallation,
    metadata: LocalCorePostgresMetadata,
  ): Promise<{ ok: true } | { status: LocalCoreDatabaseStatus }> {
    await (this.options.mkdirImpl ?? mkdir)(path.dirname(this.options.paths.postgresLogPath), { recursive: true });
    await (this.options.mkdirImpl ?? mkdir)(metadata.socketPath, { recursive: true });
    const start = await this.runCommand(installation, installation.pgCtlPath, [
      "start",
      "-D",
      metadata.dataPath,
      "-w",
      "-l",
      this.options.paths.postgresLogPath,
      "-o",
      `-k ${quotePostgresOption(metadata.socketPath)} -h '' -p ${metadata.port}`,
    ], 60_000);
    if (!start.ok) {
      return {
        status: this.blocked("LOCAL_CORE_POSTGRES_START_FAILED", `Kestrel Local Core managed database could not start: ${start.detail}`, {
          socketPath: metadata.socketPath,
          port: metadata.port,
        }),
      };
    }
    try {
      await this.probeSocket(metadata);
    } catch (error) {
      return {
        status: this.blocked("LOCAL_CORE_POSTGRES_HEALTHCHECK_FAILED", "Kestrel Local Core managed database did not become ready on its private socket.", {
          socketPath: metadata.socketPath,
          port: metadata.port,
          error: error instanceof Error ? error.message : String(error),
        }),
      };
    }
    return { ok: true };
  }

  private async ensureDatabaseExists(
    installation: LocalCorePostgresInstallation,
    metadata: LocalCorePostgresMetadata,
  ): Promise<{ ok: true } | { status: LocalCoreDatabaseStatus }> {
    const createdb = await this.runCommand(installation, installation.createdbPath, [
      "-h",
      metadata.socketPath,
      "-p",
      String(metadata.port),
      "-U",
      metadata.user,
      metadata.database,
    ], 20_000, true);
    if (createdb.ok || createdb.stderr.toLowerCase().includes("already exists")) {
      return { ok: true };
    }
    return {
      status: this.blocked("LOCAL_CORE_POSTGRES_DATABASE_CREATE_FAILED", `Kestrel Local Core managed database is running, but the '${metadata.database}' database could not be prepared: ${createdb.detail}`, {
        socketPath: metadata.socketPath,
        port: metadata.port,
      }),
    };
  }

  private async probeSocket(metadata: LocalCorePostgresMetadata): Promise<void> {
    if (this.options.probeSocketImpl !== undefined) {
      await this.options.probeSocketImpl({ socketPath: metadata.socketPath, port: metadata.port });
      return;
    }
    await access(path.join(metadata.socketPath, `.s.PGSQL.${metadata.port}`), constants.F_OK);
  }

  private async runCommand(
    installation: LocalCorePostgresInstallation,
    command: string,
    args: string[],
    timeoutMs: number,
    allowNonZero = false,
  ): Promise<LocalCorePostgresCommandResult> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DYLD_LIBRARY_PATH: installation.libDir,
      PATH: `${installation.binDir}:${process.env.PATH ?? ""}`,
      PGDATA: this.options.paths.postgresDataPath,
      PGHOST: this.options.paths.postgresSocketPath,
      PGPORT: String(DEFAULT_SOCKET_PORT),
    };
    if (this.options.runCommandImpl !== undefined) {
      return await this.options.runCommandImpl({ installation, command, args, env, timeoutMs, allowNonZero });
    }
    return await runSpawnedCommand(command, args, env, timeoutMs, allowNonZero);
  }

  private blocked(code: string, message: string, details?: Record<string, unknown>): LocalCoreDatabaseStatus {
    return {
      mode: "managed",
      state: "blocked",
      summary: message,
      managed: true,
      initialized: false,
      running: false,
      identityVerified: false,
      dataPath: this.options.paths.postgresDataPath,
      socketPath: this.options.paths.postgresSocketPath,
      metadataPath: this.options.paths.postgresMetadataPath,
      logPath: this.options.paths.postgresLogPath,
      lastError: this.failure(code, message, details),
    };
  }

  private failure(code: string, message: string, details?: Record<string, unknown>): LocalCoreFailure {
    return {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    };
  }
}

class LocalCorePostgresError extends Error {
  readonly failure: LocalCoreFailure;

  constructor(failure: LocalCoreFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

function blockedManagedStatus(paths: LocalCorePaths, failure: LocalCoreFailure): LocalCoreDatabaseStatus {
  return {
    mode: "managed",
    state: "blocked",
    summary: failure.message,
    managed: true,
    initialized: false,
    running: false,
    identityVerified: false,
    dataPath: paths.postgresDataPath,
    socketPath: paths.postgresSocketPath,
    metadataPath: paths.postgresMetadataPath,
    logPath: paths.postgresLogPath,
    lastError: failure,
  };
}

interface PostmasterPidFile {
  pid: number;
  dataPath: string;
  port: number;
  socketPath: string;
}

function parsePostmasterPidFile(raw: string): PostmasterPidFile | undefined {
  const lines = raw.split(/\r?\n/u);
  const pid = Number(lines[0]);
  const dataPath = lines[1];
  const port = Number(lines[3]);
  const socketPath = lines[4];
  if (
    Number.isInteger(pid) === false ||
    pid <= 0 ||
    typeof dataPath !== "string" ||
    dataPath.length === 0 ||
    Number.isInteger(port) === false ||
    port <= 0 ||
    typeof socketPath !== "string" ||
    socketPath.length === 0
  ) {
    return undefined;
  }
  return { pid, dataPath, port, socketPath };
}

function parseMetadata(value: unknown, paths: LocalCorePaths): LocalCorePostgresMetadata | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Partial<LocalCorePostgresMetadata>;
  if (
    record.version !== LOCAL_CORE_POSTGRES_METADATA_VERSION ||
    Number.isInteger(record.port) === false ||
    record.database !== "kestrel" ||
    record.user !== "kestrel" ||
    record.dataPath !== paths.postgresDataPath ||
    record.socketPath !== paths.postgresSocketPath
  ) {
    return undefined;
  }
  const port = record.port;
  if (typeof port !== "number") {
    return undefined;
  }
  return {
    version: LOCAL_CORE_POSTGRES_METADATA_VERSION,
    port,
    database: "kestrel",
    user: "kestrel",
    dataPath: record.dataPath,
    socketPath: record.socketPath,
  };
}

function buildInstallation(rootPath: string): LocalCorePostgresInstallation {
  return {
    rootPath,
    binDir: path.join(rootPath, "bin"),
    libDir: path.join(rootPath, "lib"),
    shareDir: path.join(rootPath, "share"),
    initdbPath: path.join(rootPath, "bin", "initdb"),
    postgresPath: path.join(rootPath, "bin", "postgres"),
    pgCtlPath: path.join(rootPath, "bin", "pg_ctl"),
    createdbPath: path.join(rootPath, "bin", "createdb"),
  };
}

async function pathExists(
  targetPath: string,
  fileExists?: ((targetPath: string) => boolean | Promise<boolean>) | undefined,
): Promise<boolean> {
  if (fileExists !== undefined) {
    return await fileExists(targetPath);
  }
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function quotePostgresOption(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runSpawnedCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  allowNonZero: boolean,
): Promise<LocalCorePostgresCommandResult> {
  return new Promise<LocalCorePostgresCommandResult>((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    collectChildResult(child, timeoutMs, allowNonZero, resolve);
  });
}

function collectChildResult(
  child: ChildProcess,
  timeoutMs: number,
  allowNonZero: boolean,
  resolve: (result: LocalCorePostgresCommandResult) => void,
): void {
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (result: LocalCorePostgresCommandResult) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    finish({ ok: false, stdout, stderr, detail: "timed out" });
  }, timeoutMs);
  child.stdout?.on("data", (chunk) => {
    stdout = appendCommandOutput(stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendCommandOutput(stderr, chunk);
  });
  child.on("error", (error) => {
    finish({ ok: false, stdout, stderr, detail: error instanceof Error ? error.message : String(error) });
  });
  child.on("close", (code) => {
    if (code === 0 || allowNonZero) {
      finish({ ok: code === 0, stdout, stderr, detail: summarizeCommandOutput(stdout, stderr, code) });
      return;
    }
    finish({ ok: false, stdout, stderr, detail: summarizeCommandOutput(stdout, stderr, code) });
  });
}

function appendCommandOutput(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk)}`;
  return next.length > MAX_COMMAND_OUTPUT_CHARS ? next.slice(-MAX_COMMAND_OUTPUT_CHARS) : next;
}

function summarizeCommandOutput(stdout: string, stderr: string, code: number | null): string {
  const combined = `${stderr.trim()} ${stdout.trim()}`.trim();
  if (combined.length > 0) {
    return combined.length > 240 ? `${combined.slice(0, 237).trimEnd()}...` : combined;
  }
  return `exit ${code ?? "unknown"}`;
}
