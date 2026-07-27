import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type DesktopEnvironmentWorkspaceMapping = {
  workspaceRef: string;
  projectId: string;
  label: string;
  path: string;
  available: boolean;
};

export type LocalCoreDesktopEnrollment = {
  requestId: string;
  baseUrl: string;
  desktopName: string;
  fingerprint: string;
  verificationUrl: string;
  expiresAt: string;
  status: "pending";
  createdAt: string;
};

export type LocalCoreDesktopEnvironment = {
  connectionId: string;
  environmentId: string;
  organizationId: string;
  baseUrl: string;
  desktopName: string;
  ticketPublicKey: string;
  status: "active" | "error";
  capacity: number;
  workspaces: DesktopEnvironmentWorkspaceMapping[];
  lastConnectedAt?: string | undefined;
  lastError?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

export type LocalCoreDesktopEnvironmentConfig = {
  version: 1;
  enrollments: LocalCoreDesktopEnrollment[];
  environments: LocalCoreDesktopEnvironment[];
};

const EMPTY_CONFIG: LocalCoreDesktopEnvironmentConfig = {
  version: 1,
  enrollments: [],
  environments: [],
};

export class LocalCoreDesktopEnvironmentConfigStore {
  readonly #filePath: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(homePath: string) {
    this.#filePath = path.join(
      homePath,
      "settings",
      "desktop-environments-v1.json",
    );
  }

  async read(): Promise<LocalCoreDesktopEnvironmentConfig> {
    return this.#withLock(() => this.#read());
  }

  async write(
    config: LocalCoreDesktopEnvironmentConfig,
  ): Promise<LocalCoreDesktopEnvironmentConfig> {
    return this.#withLock(() => this.#write(config));
  }

  async update(
    mutate: (
      current: LocalCoreDesktopEnvironmentConfig,
    ) => LocalCoreDesktopEnvironmentConfig,
  ) {
    return this.#withLock(async () => this.#write(mutate(await this.#read())));
  }

  async #read(): Promise<LocalCoreDesktopEnvironmentConfig> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(EMPTY_CONFIG);
      }
      throw error;
    }
    return parseDesktopEnvironmentConfig(JSON.parse(raw) as unknown);
  }

  async #write(
    config: LocalCoreDesktopEnvironmentConfig,
  ): Promise<LocalCoreDesktopEnvironmentConfig> {
    const parsed = parseDesktopEnvironmentConfig(config);
    await mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.#filePath);
    return parsed;
  }

  async #withLock<T>(action: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(action);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function parseDesktopEnvironmentConfig(
  value: unknown,
): LocalCoreDesktopEnvironmentConfig {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Desktop Environment configuration version is invalid.");
  }
  if (!Array.isArray(value.enrollments) || !Array.isArray(value.environments)) {
    throw new Error("Desktop Environment configuration is invalid.");
  }
  return {
    version: 1,
    enrollments: value.enrollments.map(parseEnrollment),
    environments: value.environments.map(parseEnvironment),
  };
}

function parseEnrollment(value: unknown): LocalCoreDesktopEnrollment {
  const record = requireRecord(value, "Desktop enrollment");
  return {
    requestId: text(record.requestId, "requestId"),
    baseUrl: baseUrl(record.baseUrl, "baseUrl"),
    desktopName: text(record.desktopName, "desktopName"),
    fingerprint: text(record.fingerprint, "fingerprint"),
    verificationUrl: verificationUrl(record.verificationUrl, "verificationUrl"),
    expiresAt: dateTime(record.expiresAt, "expiresAt"),
    status: literal(record.status, "pending", "status"),
    createdAt: dateTime(record.createdAt, "createdAt"),
  };
}

function parseEnvironment(value: unknown): LocalCoreDesktopEnvironment {
  const record = requireRecord(value, "Desktop Environment");
  const capacity = number(record.capacity, "capacity");
  if (capacity < 1 || capacity > 16) {
    throw new Error("Desktop Environment capacity must be between 1 and 16.");
  }
  if (!Array.isArray(record.workspaces)) {
    throw new Error("Desktop Environment workspaces must be an array.");
  }
  const status =
    record.status === "active" || record.status === "error"
      ? record.status
      : undefined;
  if (!status) throw new Error("Desktop Environment status is invalid.");
  return {
    connectionId: text(record.connectionId, "connectionId"),
    environmentId: text(record.environmentId, "environmentId"),
    organizationId: text(record.organizationId, "organizationId"),
    baseUrl: baseUrl(record.baseUrl, "baseUrl"),
    desktopName: text(record.desktopName, "desktopName"),
    ticketPublicKey: text(record.ticketPublicKey, "ticketPublicKey"),
    status,
    capacity,
    workspaces: record.workspaces.map(parseWorkspace),
    ...(record.lastConnectedAt === undefined
      ? {}
      : {
          lastConnectedAt: dateTime(record.lastConnectedAt, "lastConnectedAt"),
        }),
    ...(record.lastError === undefined
      ? {}
      : { lastError: text(record.lastError, "lastError") }),
    createdAt: dateTime(record.createdAt, "createdAt"),
    updatedAt: dateTime(record.updatedAt, "updatedAt"),
  };
}

function parseWorkspace(value: unknown): DesktopEnvironmentWorkspaceMapping {
  const record = requireRecord(value, "Desktop workspace mapping");
  if (typeof record.available !== "boolean") {
    throw new Error("Desktop workspace availability must be boolean.");
  }
  return {
    workspaceRef: text(record.workspaceRef, "workspaceRef"),
    projectId: text(record.projectId, "projectId"),
    label: text(record.label, "label"),
    path: text(record.path, "path"),
    available: record.available,
  };
}

function requireRecord(value: unknown, label: string) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function text(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Desktop Environment ${field} must be a non-empty string.`);
  }
  return value;
}

function baseUrl(value: unknown, field: string) {
  const parsed = new URL(text(value, field));
  if (
    (parsed.protocol !== "https:" &&
      !(
        parsed.protocol === "http:" &&
        (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
      )) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `Desktop Environment ${field} must be an HTTPS origin or development loopback origin.`,
    );
  }
  return parsed.origin;
}

function verificationUrl(value: unknown, field: string) {
  const parsed = new URL(text(value, field));
  baseUrl(parsed.origin, field);
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error(`Desktop Environment ${field} is invalid.`);
  }
  return parsed.toString();
}

function dateTime(value: unknown, field: string) {
  const parsed = text(value, field);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new Error(`Desktop Environment ${field} must be an ISO timestamp.`);
  }
  return parsed;
}

function number(value: unknown, field: string) {
  if (!Number.isInteger(value)) {
    throw new Error(`Desktop Environment ${field} must be an integer.`);
  }
  return value as number;
}

function literal<T extends string>(
  value: unknown,
  expected: T,
  field: string,
): T {
  if (value !== expected) {
    throw new Error(`Desktop Environment ${field} is invalid.`);
  }
  return expected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
