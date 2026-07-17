import { createConnection } from "node:net";

import { resolveKestrelLocalPortConfig } from "../config/localDev.js";

export type DatabaseUrlSource =
  | "environment"
  | "desktop_default"
  | "desktop_managed"
  | "desktop_external"
  | "local_core_managed"
  | "cli_external";

export interface DatabasePreflightTarget {
  host: string;
  port: number;
  database: string;
  isLocalHarnessDefault: boolean;
}

export interface DatabaseConnectionFailure {
  code: string;
  message: string;
  host?: string | undefined;
  port?: number | undefined;
  database?: string | undefined;
  databaseUrlSource: DatabaseUrlSource;
  recommendedAction: string;
  autoStartAttempted: boolean;
  autoStartResult?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

export interface DatabasePreflightSuccess {
  ok: true;
  target: DatabasePreflightTarget;
}

export interface DatabasePreflightFailure {
  ok: false;
  failure: DatabaseConnectionFailure;
}

export type DatabasePreflightResult = DatabasePreflightSuccess | DatabasePreflightFailure;

export interface DatabaseConnectionDescriptor {
  databaseUrl: string;
  databaseUrlSource: DatabaseUrlSource;
}

export function resolveDatabasePreflightTarget(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): DatabasePreflightTarget {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch (error) {
    throw new Error(
      `DATABASE_URL is invalid: ${error instanceof Error ? error.message : "parse failed"}`,
    );
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      `DATABASE_URL must use postgres:// or postgresql:// (received '${parsed.protocol}').`,
    );
  }

  const host = parsed.hostname.trim();
  if (host.length === 0) {
    throw new Error("DATABASE_URL must include a hostname.");
  }

  const rawPort = parsed.port.trim();
  const port = rawPort.length === 0 ? 5432 : Number(rawPort);
  if (Number.isInteger(port) === false || port <= 0 || port > 65_535) {
    throw new Error(`DATABASE_URL port is invalid ('${rawPort}').`);
  }

  const databasePath = parsed.pathname.replace(/^\/+/u, "").trim();
  const database = databasePath.length > 0 ? databasePath : "postgres";
  const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const localPorts = resolveKestrelLocalPortConfig(env);
  const isLocalHarnessDefault = isLocalHost && port === localPorts.dbPort && database === "kestrel";

  return {
    host,
    port,
    database,
    isLocalHarnessDefault,
  };
}

export function resolveDatabaseSelfHealPolicy(input: {
  target: DatabasePreflightTarget;
  failureCode?: string | undefined;
  envValue?: string | undefined;
  defaultEnabled?: boolean | undefined;
}): {
  canAttempt: boolean;
  reason:
    | "enabled_local_refused"
    | "disabled"
    | "non_local_target"
    | "unsupported_failure_code";
} {
  const enabled = parseBooleanFlag(input.envValue, input.defaultEnabled === true);
  if (!enabled) {
    return {
      canAttempt: false,
      reason: "disabled",
    };
  }
  if (!input.target.isLocalHarnessDefault) {
    return {
      canAttempt: false,
      reason: "non_local_target",
    };
  }
  if (input.failureCode !== "ECONNREFUSED") {
    return {
      canAttempt: false,
      reason: "unsupported_failure_code",
    };
  }
  return {
    canAttempt: true,
    reason: "enabled_local_refused",
  };
}

export async function probeTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const finish = (error?: unknown) => {
      socket.removeAllListeners();
      socket.destroy();
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish());
    socket.once("timeout", () => {
      const timeoutError = new Error(`connect timeout ${host}:${port}`) as Error & { code?: string };
      timeoutError.code = "ETIMEDOUT";
      finish(timeoutError);
    });
    socket.once("error", (error) => {
      finish(error);
    });
  });
}

export function describeConnectionFailure(error: unknown): {
  code?: string | undefined;
  label: string;
} {
  const aggregate = error as { errors?: unknown };
  if (Array.isArray(aggregate?.errors) && aggregate.errors.length > 0) {
    for (const nested of aggregate.errors) {
      const nestedCode = readConnectionErrorCode(nested);
      if (nestedCode !== undefined) {
        return {
          code: nestedCode,
          label: nestedCode,
        };
      }
    }
  }

  const code = readConnectionErrorCode(error);
  if (code !== undefined) {
    return {
      code,
      label: code,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    label: truncatePreflightDetail(message),
  };
}

export async function preflightDatabaseConnection(input: {
  descriptor: DatabaseConnectionDescriptor;
  env?: NodeJS.ProcessEnv | undefined;
  selfHealEnvValue?: string | undefined;
  selfHealDefaultEnabled?: boolean | undefined;
  allowAutoStart?: boolean | undefined;
  autoStart?: (() => Promise<{ ok: boolean; detail: string }>) | undefined;
  timeoutMs?: number | undefined;
  retryTimeoutMs?: number | undefined;
}): Promise<DatabasePreflightResult> {
  let target: DatabasePreflightTarget;
  try {
    target = resolveDatabasePreflightTarget(input.descriptor.databaseUrl, input.env);
  } catch (error) {
    return {
      ok: false,
      failure: {
        code: "DATABASE_URL_INVALID",
        message: error instanceof Error ? error.message : String(error),
        databaseUrlSource: input.descriptor.databaseUrlSource,
        recommendedAction: buildRecommendedAction({
          source: input.descriptor.databaseUrlSource,
          reason: "invalid_url",
        }),
        autoStartAttempted: false,
      },
    };
  }

  try {
    await probeTcpPort(target.host, target.port, input.timeoutMs ?? 1200);
    return {
      ok: true,
      target,
    };
  } catch (error) {
    const connectionFailure = describeConnectionFailure(error);
    const policy = resolveDatabaseSelfHealPolicy({
      target,
      failureCode: connectionFailure.code,
      envValue: input.selfHealEnvValue,
      defaultEnabled: input.selfHealDefaultEnabled,
    });

    if (
      input.allowAutoStart === true &&
      input.autoStart !== undefined &&
      policy.canAttempt
    ) {
      const recovered = await input.autoStart();
      if (recovered.ok) {
        try {
          await probeTcpPort(target.host, target.port, input.retryTimeoutMs ?? 2500);
          return {
            ok: true,
            target,
          };
        } catch (retryError) {
          const retryFailure = describeConnectionFailure(retryError);
          return {
            ok: false,
            failure: buildDatabaseConnectionFailure({
              target,
              source: input.descriptor.databaseUrlSource,
              code: retryFailure.code ?? "DATABASE_UNREACHABLE",
              reason: "auto_start_failed",
              label: retryFailure.label,
              autoStartAttempted: true,
              autoStartResult: recovered.detail,
            }),
          };
        }
      }

      return {
        ok: false,
        failure: buildDatabaseConnectionFailure({
          target,
          source: input.descriptor.databaseUrlSource,
          code: connectionFailure.code ?? "DATABASE_UNREACHABLE",
          reason: "auto_start_failed",
          label: recovered.detail,
          autoStartAttempted: true,
          autoStartResult: recovered.detail,
        }),
      };
    }

    return {
      ok: false,
      failure: buildDatabaseConnectionFailure({
        target,
        source: input.descriptor.databaseUrlSource,
        code: connectionFailure.code ?? "DATABASE_UNREACHABLE",
        reason: "probe_failed",
        label: connectionFailure.label,
        autoStartAttempted: false,
      }),
    };
  }
}

export function maybeBuildDatabaseConnectionFailure(input: {
  error: unknown;
  descriptor: DatabaseConnectionDescriptor;
  env?: NodeJS.ProcessEnv | undefined;
  autoStartAttempted?: boolean | undefined;
  autoStartResult?: string | undefined;
}): DatabaseConnectionFailure | undefined {
  let target: DatabasePreflightTarget;
  try {
    target = resolveDatabasePreflightTarget(input.descriptor.databaseUrl, input.env);
  } catch {
    return ;
  }

  const failure = describeConnectionFailure(input.error);
  const message =
    input.error instanceof Error && input.error.message.trim().length > 0
      ? input.error.message.trim()
      : undefined;
  if (
    failure.code === undefined &&
    message !== undefined &&
    /connection refused|econnrefused|timeout|timed out|econnreset/iu.test(message) === false
  ) {
    return ;
  }

  return buildDatabaseConnectionFailure({
    target,
    source: input.descriptor.databaseUrlSource,
    code: failure.code ?? "DATABASE_UNREACHABLE",
    reason: "probe_failed",
    label: failure.label,
    autoStartAttempted: input.autoStartAttempted === true,
    ...(input.autoStartResult !== undefined ? { autoStartResult: input.autoStartResult } : {}),
  });
}

function buildDatabaseConnectionFailure(input: {
  target: DatabasePreflightTarget;
  source: DatabaseUrlSource;
  code: string;
  reason: "probe_failed" | "auto_start_failed";
  label: string;
  autoStartAttempted: boolean;
  autoStartResult?: string | undefined;
}): DatabaseConnectionFailure {
  const location = `${input.target.host}:${input.target.port}/${input.target.database}`;
  const runtimeLabel =
    input.source === "desktop_managed"
      ? "Bundled desktop Postgres"
      : input.source === "local_core_managed"
        ? "Kestrel Local Core managed database"
      : input.source === "desktop_default"
        ? "Desktop Postgres"
        : input.source === "desktop_external"
          ? "Hosted Postgres"
          : input.source === "cli_external"
            ? "Configured external Postgres"
            : "Postgres";
  const detail =
    input.reason === "auto_start_failed" && input.autoStartAttempted
      ? ` Auto-start did not recover the database (${input.label}).`
      : ` (${input.label})`;
  return {
    code: input.code,
    message: `${runtimeLabel} is not reachable at ${location}.${detail}`,
    host: input.target.host,
    port: input.target.port,
    database: input.target.database,
    databaseUrlSource: input.source,
    recommendedAction: buildRecommendedAction({
      source: input.source,
      reason: input.reason,
    }),
    autoStartAttempted: input.autoStartAttempted,
    ...(input.autoStartResult !== undefined ? { autoStartResult: input.autoStartResult } : {}),
    details: {
      storeDriver: "postgres",
      host: input.target.host,
      port: input.target.port,
      database: input.target.database,
      databaseUrlSource: input.source,
      recommendedAction: buildRecommendedAction({
        source: input.source,
        reason: input.reason,
      }),
      autoStartAttempted: input.autoStartAttempted,
      ...(input.autoStartResult !== undefined ? { autoStartResult: input.autoStartResult } : {}),
    },
  };
}

function buildRecommendedAction(input: {
  source: DatabaseUrlSource;
  reason: "probe_failed" | "auto_start_failed" | "invalid_url";
}): string {
  if (input.reason === "invalid_url") {
    return "Fix DATABASE_URL so it points to a reachable postgres:// endpoint.";
  }
  if (input.source === "desktop_managed") {
    return "Open Desktop Diagnostics to restart or repair the bundled database cluster.";
  }
  if (input.source === "local_core_managed") {
    return "Run `kestrel status` and use Local Core diagnostics to restart or repair the managed database.";
  }
  if (input.source === "desktop_default") {
    return input.reason === "auto_start_failed"
      ? "Check Docker Desktop, then start the local database with `pnpm run db:up`."
      : "Start the local database with `pnpm run db:up`, or enable KCHAT_DB_SELF_HEAL=true for dev auto-recovery.";
  }
  if (input.source === "desktop_external") {
    return "Open Settings > Database, verify DATABASE_URL points to your hosted Postgres endpoint, then retry.";
  }
  if (input.source === "cli_external") {
    return "Run `kestrel status` and verify the configured external DATABASE_URL points to a reachable Postgres endpoint.";
  }
  return "Verify DATABASE_URL and ensure the target Postgres instance is reachable.";
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

function readConnectionErrorCode(error: unknown): string | undefined {
  if (typeof (error as { code?: unknown })?.code !== "string") {
    return ;
  }
  const code = String((error as { code: string }).code).trim();
  return CONNECTION_ERROR_CODES.has(code) ? code : undefined;
}

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

function truncatePreflightDetail(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 120) {
    return trimmed;
  }
  return `${trimmed.slice(0, 117).trimEnd()}...`;
}
