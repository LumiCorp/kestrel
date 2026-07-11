import type { DatabaseUrlSource } from "../src/runtime/databasePreflight.js";

const DATABASE_URL_SOURCES = new Set<DatabaseUrlSource>([
  "desktop_external",
  "desktop_managed",
  "desktop_default",
  "cli_external",
  "local_core_managed",
]);

export function readDatabaseUrlSource(env: NodeJS.ProcessEnv = process.env): DatabaseUrlSource {
  const source = env.KESTREL_DATABASE_URL_SOURCE?.trim();
  return isDatabaseUrlSource(source) ? source : "environment";
}

export function shouldKeepEnvironmentDatabaseUrl(env: NodeJS.ProcessEnv = process.env): boolean {
  if (DATABASE_URL_SOURCES.has(readDatabaseUrlSource(env))) {
    return true;
  }
  return env.KESTREL_STORE_DRIVER?.trim() === "postgres";
}

function isDatabaseUrlSource(value: string | undefined): value is DatabaseUrlSource {
  return value !== undefined && DATABASE_URL_SOURCES.has(value as DatabaseUrlSource);
}
