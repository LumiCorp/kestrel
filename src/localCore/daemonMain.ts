import { fileURLToPath } from "node:url";
import path from "node:path";

import { startLocalCoreApiServer } from "./api.js";
import { LOCAL_CORE_SCHEMA_VERSION } from "./contracts.js";
import { MacosKeychainCredentialStore } from "./macosKeychainCredentialStore.js";
import { parseLocalCorePlatform } from "./platform.js";

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export async function runLocalCoreDaemon(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const platform = parseLocalCorePlatform(env.KESTREL_CORE_PLATFORM) ?? process.platform;
  const server = await startLocalCoreApiServer({
    env,
    platform,
    coreVersion: readRequiredEnv(env, "KESTREL_CORE_VERSION"),
    schemaVersion: parseInteger(env.KESTREL_CORE_SCHEMA_VERSION) ?? LOCAL_CORE_SCHEMA_VERSION,
    ownerExecutable: env.KESTREL_CORE_OWNER_EXECUTABLE ?? process.execPath,
    databaseMode: env.KESTREL_CORE_DATABASE_MODE === "external" ? "external" : "pglite",
    externalDatabaseUrl: env.KESTREL_CORE_EXTERNAL_DATABASE_URL,
    allowInheritedDatabaseUrl: env.KESTREL_CORE_ALLOW_INHERITED_DATABASE_URL === "1",
    postgresBundleRootPath: env.KESTREL_LOCAL_CORE_POSTGRES_BUNDLE,
    runMigrations: env.KESTREL_CORE_RUN_MIGRATIONS === "1",
    repoRoot: env.KESTREL_CORE_REPO_ROOT,
    idleTimeoutMs: parseInteger(env.KESTREL_CORE_IDLE_TIMEOUT_MS) ?? DEFAULT_IDLE_TIMEOUT_MS,
    ...(platform === "darwin" && env.KESTREL_CORE_CREDENTIAL_STORE === "macos_keychain"
      ? { credentialStore: new MacosKeychainCredentialStore() }
      : {}),
  });

  const close = async () => {
    await server.close();
  };
  process.once("SIGINT", () => {
    void close().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void close().finally(() => process.exit(143));
  });
}

function readRequiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${key} is required to start Kestrel Local Core.`);
  }
  return value;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runLocalCoreDaemon().catch((error) => {
    process.stderr.write(`[kestrel-core] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
