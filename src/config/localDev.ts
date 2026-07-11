const DEFAULT_LOCAL_DATABASE_HOST = "localhost";
const DEFAULT_LOCAL_DATABASE_NAME = "kestrel";
const DEFAULT_LOCAL_DATABASE_USER = "kestrel";
const DEFAULT_LOCAL_DATABASE_PASSWORD = "kestrel";

export const DEFAULT_KESTREL_DB_PORT = 55432;
export const DEFAULT_KESTREL_WEB_PORT = 43103;
export const DEFAULT_KESTREL_RUNNER_SERVICE_PORT = 43102;

export interface KestrelLocalPortConfig {
  dbPort: number;
  webPort: number;
  runnerServicePort: number;
}

export function resolveKestrelLocalPortConfig(
  env: NodeJS.ProcessEnv = process.env,
): KestrelLocalPortConfig {
  return {
    dbPort: readPortOverride(env.KESTREL_DB_PORT, DEFAULT_KESTREL_DB_PORT, "KESTREL_DB_PORT"),
    webPort: readPortOverride(env.KESTREL_WEB_PORT, DEFAULT_KESTREL_WEB_PORT, "KESTREL_WEB_PORT"),
    runnerServicePort: readPortOverride(
      env.KESTREL_RUNNER_SERVICE_PORT,
      DEFAULT_KESTREL_RUNNER_SERVICE_PORT,
      "KESTREL_RUNNER_SERVICE_PORT",
    ),
  };
}

export function buildDefaultKestrelDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  database = DEFAULT_LOCAL_DATABASE_NAME,
): string {
  const { dbPort } = resolveKestrelLocalPortConfig(env);
  return `postgres://${DEFAULT_LOCAL_DATABASE_USER}:${DEFAULT_LOCAL_DATABASE_PASSWORD}@${DEFAULT_LOCAL_DATABASE_HOST}:${dbPort}/${database}`;
}

export function applyKestrelLocalEnvDefaults(env: NodeJS.ProcessEnv = process.env): void {
  if (typeof env.DATABASE_URL !== "string" || env.DATABASE_URL.trim().length === 0) {
    env.DATABASE_URL = buildDefaultKestrelDatabaseUrl(env);
  }
}

function readPortOverride(value: string | undefined, fallback: number, key: string): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value.trim());
  if (Number.isInteger(parsed) === false || parsed <= 0 || parsed > 65535) {
    const error = new Error(`${key} must be a valid TCP port.`) as Error & { code: string };
    error.code = "LOCAL_DEV_INVALID_PORT";
    throw error;
  }

  return parsed;
}
