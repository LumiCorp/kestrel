import type { DesktopDatabaseStatus } from "../../../src/desktopShell/contracts.js";
import type { LocalCoreStatus } from "../../../src/localCore/contracts.js";
import {
  maybeBuildDatabaseConnectionFailure,
  preflightDatabaseConnection,
  type DatabaseConnectionFailure,
  type DatabaseUrlSource,
} from "../../../src/runtime/databasePreflight.js";
import { createRuntimeFailure } from "../../../src/runtime/RuntimeFailure.js";
import { attemptLocalDatabaseSelfHeal } from "../../../src/runtime/localDatabaseSelfHeal.js";
import { buildDefaultKestrelDatabaseUrl } from "./localDev.js";
import {
  buildManagedDatabaseUrl,
  type DesktopPostgresSupervisor,
} from "./postgresSupervisor.js";

export interface DesktopDatabaseController {
  prepare(): Promise<{ databaseUrl?: string | undefined; status: DesktopDatabaseStatus }>;
  getStatus(): Promise<DesktopDatabaseStatus>;
  restart(): Promise<DesktopDatabaseStatus>;
  repair(): Promise<DesktopDatabaseStatus>;
  close(): Promise<void>;
  getDatabaseUrl(): string | undefined;
  getLogPath(): string | undefined;
  getDataPath(): string | undefined;
}

export function createCoreOwnedDesktopDatabaseController(input: {
  ensureReady(): Promise<LocalCoreStatus>;
  readCurrentStatus?: (() => LocalCoreStatus | undefined) | undefined;
}): DesktopDatabaseController {
  return new CoreOwnedDesktopDatabaseController(input);
}

export function createDesktopDatabaseController(input: {
  mode: "external" | "managed" | "unavailable";
  databaseUrl?: string | undefined;
  databaseUrlSource?: DatabaseUrlSource | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  isPackaged: boolean;
  supervisor?: DesktopPostgresSupervisor | undefined;
  unavailableStatus?: DesktopDatabaseStatus | undefined;
}): DesktopDatabaseController {
  if (input.mode === "unavailable") {
    if (input.unavailableStatus === undefined) {
      throw createRuntimeFailure(
        "DESKTOP_DATABASE_STATUS_REQUIRED",
        "Unavailable Kestrel Local Core database controller requires a status payload.",
      );
    }
    return new UnavailableDesktopDatabaseController(input.unavailableStatus);
  }
  if (input.mode === "managed") {
    if (input.supervisor === undefined) {
      throw createRuntimeFailure(
        "DESKTOP_DATABASE_SUPERVISOR_REQUIRED",
        "Managed Kestrel Local Core database controller requires a supervisor.",
      );
    }
    return new ManagedDesktopDatabaseController(input.supervisor);
  }
  return new ExternalDesktopDatabaseController({
    databaseUrl: input.databaseUrl ?? buildDefaultKestrelDatabaseUrl(input.env),
    databaseUrlSource: input.databaseUrlSource ?? "desktop_default",
    env: input.env,
    isPackaged: input.isPackaged,
  });
}

class CoreOwnedDesktopDatabaseController implements DesktopDatabaseController {
  private readonly ensureReady: () => Promise<LocalCoreStatus>;
  private readonly readCurrentStatus: (() => LocalCoreStatus | undefined) | undefined;
  private status: DesktopDatabaseStatus = {
    state: "starting",
    summary: "Checking Kestrel Local Core database...",
    managed: true,
    initialized: false,
    running: false,
  };
  private databaseUrl: string | undefined;

  constructor(input: {
    ensureReady(): Promise<LocalCoreStatus>;
    readCurrentStatus?: (() => LocalCoreStatus | undefined) | undefined;
  }) {
    this.ensureReady = input.ensureReady;
    this.readCurrentStatus = input.readCurrentStatus;
    const current = input.readCurrentStatus?.();
    if (current !== undefined) {
      this.applyCoreStatus(current);
    }
  }

  async prepare(): Promise<{ databaseUrl?: string | undefined; status: DesktopDatabaseStatus }> {
    const coreStatus = await this.ensureReady();
    this.applyCoreStatus(coreStatus);
    const pgliteReady = coreStatus.dbMode === "pglite"
      && coreStatus.database.state === "healthy"
      && coreStatus.database.initialized
      && coreStatus.database.running;
    const externalReady = coreStatus.dbMode === "external"
      && coreStatus.database.state === "healthy"
      && coreStatus.database.initialized
      && coreStatus.database.running
      && coreStatus.database.identityVerified;
    if (coreStatus.state === "blocked" || (!pgliteReady && !externalReady)) {
      throw createRuntimeFailure(
        coreStatus.lastError?.code ?? coreStatus.database.lastError?.code ?? "LOCAL_CORE_DATABASE_UNAVAILABLE",
        coreStatus.lastError?.message ?? coreStatus.database.lastError?.message ?? coreStatus.summary,
        coreStatus.lastError?.details ?? coreStatus.database.lastError?.details,
      );
    }
    return {
      status: this.status,
    };
  }

  async getStatus(): Promise<DesktopDatabaseStatus> {
    const current = this.readCurrentStatus?.();
    if (current !== undefined) {
      this.applyCoreStatus(current);
    }
    return { ...this.status };
  }

  async restart(): Promise<DesktopDatabaseStatus> {
    return (await this.prepare()).status;
  }

  async repair(): Promise<DesktopDatabaseStatus> {
    return (await this.prepare()).status;
  }

  async close(): Promise<void> {
    return;
  }

  getDatabaseUrl(): string | undefined {
    return this.databaseUrl;
  }

  getLogPath(): string | undefined {
    return this.readCurrentStatus?.()?.database.logPath ?? this.status.logPath;
  }

  getDataPath(): string | undefined {
    return this.readCurrentStatus?.()?.database.dataPath;
  }

  private applyCoreStatus(coreStatus: LocalCoreStatus): void {
    this.databaseUrl = undefined;
    this.status = toDesktopDatabaseStatus(coreStatus);
  }
}

class ExternalDesktopDatabaseController implements DesktopDatabaseController {
  private readonly databaseUrl: string;
  private readonly databaseUrlSource: DatabaseUrlSource;
  private readonly env: NodeJS.ProcessEnv;
  private readonly isPackaged: boolean;
  private status: DesktopDatabaseStatus = {
    state: "starting",
    summary: "Checking Kestrel Local Core database…",
    managed: false,
    initialized: true,
    running: false,
  };

  constructor(input: {
    databaseUrl: string;
    databaseUrlSource: DatabaseUrlSource;
    env?: NodeJS.ProcessEnv | undefined;
    isPackaged: boolean;
  }) {
    this.databaseUrl = input.databaseUrl;
    this.databaseUrlSource = input.databaseUrlSource;
    this.env = input.env ?? process.env;
    this.isPackaged = input.isPackaged;
  }

  async prepare(): Promise<{ databaseUrl: string; status: DesktopDatabaseStatus }> {
    const result = await preflightDatabaseConnection({
      descriptor: {
        databaseUrl: this.databaseUrl,
        databaseUrlSource: this.databaseUrlSource,
      },
      env: this.env,
      selfHealEnvValue: this.env.KCHAT_DB_SELF_HEAL,
      selfHealDefaultEnabled: this.isPackaged === false,
      allowAutoStart: this.isPackaged === false,
      autoStart: this.isPackaged === false ? attemptLocalDatabaseSelfHeal : undefined,
    });
    if (!result.ok) {
      const status = toExternalDatabaseStatus(result.failure);
      this.status = status;
      throw createRuntimeFailure(result.failure.code, result.failure.message, {
        ...(result.failure.details ?? {}),
      });
    }
    this.status = {
      state: "healthy",
      summary: `Postgres reachable at ${result.target.host}:${result.target.port}/${result.target.database}.`,
      managed: false,
      initialized: true,
      running: true,
      host: result.target.host,
      port: result.target.port,
      database: result.target.database,
    };
    return {
      databaseUrl: this.databaseUrl,
      status: this.status,
    };
  }

  async getStatus(): Promise<DesktopDatabaseStatus> {
    return { ...this.status };
  }

  async restart(): Promise<DesktopDatabaseStatus> {
    return (await this.prepare()).status;
  }

  async repair(): Promise<DesktopDatabaseStatus> {
    return (await this.prepare()).status;
  }

  async close(): Promise<void> {
    return;
  }

  getDatabaseUrl(): string | undefined {
    return this.databaseUrl;
  }

  getLogPath(): string | undefined {
    return ;
  }

  getDataPath(): string | undefined {
    return ;
  }
}

class ManagedDesktopDatabaseController implements DesktopDatabaseController {
  private readonly supervisor: DesktopPostgresSupervisor;
  private databaseUrl: string | undefined;

  constructor(supervisor: DesktopPostgresSupervisor) {
    this.supervisor = supervisor;
  }

  async prepare(): Promise<{ databaseUrl: string; status: DesktopDatabaseStatus }> {
    const ready = await this.supervisor.ensureReady();
    this.databaseUrl = ready.databaseUrl;
    return ready;
  }

  async getStatus(): Promise<DesktopDatabaseStatus> {
    return this.supervisor.getStatus();
  }

  async restart(): Promise<DesktopDatabaseStatus> {
    const status = await this.supervisor.restart();
    this.databaseUrl = status.port !== undefined
      ? buildManagedDatabaseUrl(status.port)
      : this.databaseUrl;
    return status;
  }

  async repair(): Promise<DesktopDatabaseStatus> {
    const status = await this.supervisor.repair();
    this.databaseUrl = status.port !== undefined
      ? buildManagedDatabaseUrl(status.port)
      : this.databaseUrl;
    return status;
  }

  async close(): Promise<void> {
    await this.supervisor.stop();
  }

  getDatabaseUrl(): string | undefined {
    return this.databaseUrl;
  }

  getLogPath(): string | undefined {
    return this.supervisor.getStatus().logPath;
  }

  getDataPath(): string | undefined {
    return this.supervisor.getDataPath();
  }
}

class UnavailableDesktopDatabaseController implements DesktopDatabaseController {
  private readonly status: DesktopDatabaseStatus;

  constructor(status: DesktopDatabaseStatus) {
    this.status = status;
  }

  async prepare(): Promise<{ databaseUrl: string; status: DesktopDatabaseStatus }> {
    throw createRuntimeFailure(
      this.status.lastError?.code ?? "DESKTOP_DATABASE_UNAVAILABLE",
      this.status.lastError?.message ?? this.status.summary,
      this.status.lastError?.details,
    );
  }

  async getStatus(): Promise<DesktopDatabaseStatus> {
    return { ...this.status };
  }

  async restart(): Promise<DesktopDatabaseStatus> {
    return { ...this.status };
  }

  async repair(): Promise<DesktopDatabaseStatus> {
    return { ...this.status };
  }

  async close(): Promise<void> {
    return;
  }

  getDatabaseUrl(): string | undefined {
    return ;
  }

  getLogPath(): string | undefined {
    return this.status.logPath;
  }

  getDataPath(): string | undefined {
    return ;
  }
}

export function buildDatabaseFailureFromRuntimeError(input: {
  error: unknown;
  databaseUrl: string;
  databaseUrlSource: DatabaseUrlSource;
  env?: NodeJS.ProcessEnv | undefined;
}): DatabaseConnectionFailure | undefined {
  return maybeBuildDatabaseConnectionFailure({
    error: input.error,
    descriptor: {
      databaseUrl: input.databaseUrl,
      databaseUrlSource: input.databaseUrlSource,
    },
    env: input.env,
  });
}

function toExternalDatabaseStatus(failure: DatabaseConnectionFailure): DesktopDatabaseStatus {
  return {
    state: "blocked",
    summary: failure.message,
    managed: false,
    initialized: true,
    running: false,
    ...(failure.host !== undefined ? { host: failure.host } : {}),
    ...(failure.port !== undefined ? { port: failure.port } : {}),
    ...(failure.database !== undefined ? { database: failure.database } : {}),
    lastError: {
      code: failure.code,
      message: failure.message,
      details: {
        ...(failure.details ?? {}),
        recommendedAction: failure.recommendedAction,
        autoStartAttempted: failure.autoStartAttempted,
        ...(failure.autoStartResult !== undefined ? { autoStartResult: failure.autoStartResult } : {}),
      },
    },
  };
}

function toDesktopDatabaseStatus(coreStatus: LocalCoreStatus): DesktopDatabaseStatus {
  const database = coreStatus.database;
  return {
    state: database.state === "missing" ? "blocked" : database.state,
    summary: database.summary,
    managed: database.managed,
    initialized: database.initialized,
    running: database.running,
    ...(database.port !== undefined ? { port: database.port } : {}),
    ...(database.database !== undefined ? { database: database.database } : {}),
    ...(database.logPath !== undefined ? { logPath: database.logPath } : {}),
    ...(database.lastError !== undefined ? { lastError: database.lastError } : {}),
  };
}
