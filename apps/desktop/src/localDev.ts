const DEFAULT_LOCAL_DATABASE_HOST = "localhost";
const DEFAULT_LOCAL_DATABASE_NAME = "kestrel";
const DEFAULT_LOCAL_DATABASE_USER = "kestrel";
const DEFAULT_LOCAL_DATABASE_PASSWORD = "kestrel";

export const DEFAULT_KESTREL_DB_PORT = 55_432;

export function buildDefaultKestrelDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  database = DEFAULT_LOCAL_DATABASE_NAME,
): string {
  const dbPort = readPortOverride(env.KESTREL_DB_PORT, DEFAULT_KESTREL_DB_PORT, "KESTREL_DB_PORT");
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
  if (Number.isInteger(parsed) === false || parsed <= 0 || parsed > 65_535) {
    const error = new Error(`${key} must be a valid TCP port.`) as Error & { code: string };
    error.code = "LOCAL_DEV_INVALID_PORT";
    throw error;
  }

  return parsed;
}
