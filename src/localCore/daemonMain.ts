import { fileURLToPath } from "node:url";
import path from "node:path";

import { startLocalCoreApiServer } from "./api.js";
import { resolveLocalCoreBuildIdentity } from "./buildIdentity.js";
import { LOCAL_CORE_SCHEMA_VERSION } from "./contracts.js";
import type { LocalCoreCredentialStore } from "./credentialStore.js";
import { MacosKeychainCredentialStore } from "./macosKeychainCredentialStore.js";
import { parseLocalCorePlatform } from "./platform.js";

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export async function runLocalCoreDaemon(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const platform = parseLocalCorePlatform(env.KESTREL_CORE_PLATFORM) ?? process.platform;
  const coreVersion = readRequiredEnv(env, "KESTREL_CORE_VERSION");
  const expectedBuildId = normalizeString(env.KESTREL_CORE_BUILD_ID);
  const runtimeRoot = resolveRuntimeRoot(env);
  const buildIdentity = resolveLocalCoreBuildIdentity({
    runtimeRoot,
    suiteVersion: coreVersion,
    manifestRequired: env.KESTREL_CORE_BUILD_MANIFEST_REQUIRED === "1",
    ...(env.KESTREL_SOURCE_COMMIT !== undefined
      ? { sourceCommit: env.KESTREL_SOURCE_COMMIT }
      : {}),
  });
  if (expectedBuildId !== undefined && buildIdentity.buildId !== expectedBuildId) {
    throw new Error(
      `Local Core build changed during startup: expected ${expectedBuildId}, resolved ${buildIdentity.buildId}.`,
    );
  }
  const credentialStore = resolveLocalCoreDaemonCredentialStore({
    platform,
    configuredStore: env.KESTREL_CORE_CREDENTIAL_STORE,
  });
  const server = await startLocalCoreApiServer({
    env,
    platform,
    coreVersion,
    buildIdentity,
    schemaVersion: parseInteger(env.KESTREL_CORE_SCHEMA_VERSION) ?? LOCAL_CORE_SCHEMA_VERSION,
    ownerExecutable: env.KESTREL_CORE_OWNER_EXECUTABLE ?? process.execPath,
    databaseMode: env.KESTREL_CORE_DATABASE_MODE === "external" ? "external" : "pglite",
    externalDatabaseUrl: env.KESTREL_CORE_EXTERNAL_DATABASE_URL,
    allowInheritedDatabaseUrl: env.KESTREL_CORE_ALLOW_INHERITED_DATABASE_URL === "1",
    postgresBundleRootPath: env.KESTREL_LOCAL_CORE_POSTGRES_BUNDLE,
    runMigrations: env.KESTREL_CORE_RUN_MIGRATIONS === "1",
    repoRoot: env.KESTREL_CORE_REPO_ROOT,
    idleTimeoutMs: parseInteger(env.KESTREL_CORE_IDLE_TIMEOUT_MS) ?? DEFAULT_IDLE_TIMEOUT_MS,
    ...(credentialStore !== undefined ? { credentialStore } : {}),
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

function resolveRuntimeRoot(env: NodeJS.ProcessEnv): string {
  const explicit = env.KESTREL_CLI_LIBEXEC?.trim() || env.KESTREL_CORE_REPO_ROOT?.trim();
  return explicit ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function resolveLocalCoreDaemonCredentialStore(input: {
  platform: NodeJS.Platform;
  configuredStore?: string | undefined;
}): LocalCoreCredentialStore | undefined {
  const configuredStore = input.configuredStore?.trim();
  if (
    configuredStore !== undefined &&
    configuredStore.length > 0 &&
    configuredStore !== "macos_keychain" &&
    configuredStore !== "environment"
  ) {
    throw new Error(
      `Unsupported Local Core credential store '${configuredStore}'.`,
    );
  }
  if (configuredStore === "environment") {
    return undefined;
  }
  return input.platform === "darwin"
    ? new MacosKeychainCredentialStore()
    : undefined;
}

function readRequiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${key} is required to start Kestrel Local Core.`);
  }
  return value;
}

function normalizeString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return ;
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
