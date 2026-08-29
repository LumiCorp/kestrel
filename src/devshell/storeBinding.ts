import { randomUUID } from "node:crypto";

export const DEV_SHELL_STORE_DRIVER_ENV = "KESTREL_DEV_SHELL_STORE_DRIVER";
export const DEV_SHELL_STORE_DATABASE_URL_ENV =
  "KESTREL_DEV_SHELL_STORE_DATABASE_URL";
export const DEV_SHELL_STORE_BINDING_REVISION_ENV =
  "KESTREL_DEV_SHELL_STORE_BINDING_REVISION";

export type DevShellStoreBinding =
  | {
      revision: string;
      driver: "sqlite";
    }
  | {
      revision: string;
      driver: "postgres";
      databaseUrl: string;
    };

export interface LegacyDevShellStoreBindingResolution {
  binding?: DevShellStoreBinding | undefined;
  missingDatabaseUrl: boolean;
}

export function createDevShellStoreBindingRevision(): string {
  return `dev-shell:${randomUUID()}`;
}

export function resolveLegacyDevShellStoreBinding(
  env: NodeJS.ProcessEnv,
): LegacyDevShellStoreBindingResolution {
  const configuredDriver = env.KESTREL_STORE_DRIVER?.trim();
  const databaseUrl = readRequiredValue(env.DATABASE_URL);
  const driver =
    configuredDriver === "postgres" ||
    (configuredDriver !== "sqlite" && databaseUrl !== undefined)
      ? "postgres"
      : "sqlite";
  const revision = createDevShellStoreBindingRevision();
  if (driver === "postgres") {
    if (databaseUrl === undefined) {
      return { missingDatabaseUrl: true };
    }
    return {
      missingDatabaseUrl: false,
      binding: { revision, driver, databaseUrl },
    };
  }
  return {
    missingDatabaseUrl: false,
    binding: { revision, driver },
  };
}

export function buildDevShellStoreBindingEnvironment(
  binding: DevShellStoreBinding,
): NodeJS.ProcessEnv {
  return {
    [DEV_SHELL_STORE_DRIVER_ENV]: binding.driver,
    [DEV_SHELL_STORE_BINDING_REVISION_ENV]: binding.revision,
    ...(binding.driver === "postgres"
      ? { [DEV_SHELL_STORE_DATABASE_URL_ENV]: binding.databaseUrl }
      : {}),
  };
}

export function readDevShellStoreBindingFromEnvironment(
  env: NodeJS.ProcessEnv,
): DevShellStoreBinding {
  const driver = readRequiredValue(env[DEV_SHELL_STORE_DRIVER_ENV]);
  const revision = readRequiredValue(env[DEV_SHELL_STORE_BINDING_REVISION_ENV]);
  if (driver !== "sqlite" && driver !== "postgres") {
    throw new Error("Developer shell store driver is missing or invalid.");
  }
  if (revision === undefined) {
    throw new Error("Developer shell store binding revision is missing.");
  }
  if (driver === "sqlite") {
    return { driver, revision };
  }
  const databaseUrl = readRequiredValue(env[DEV_SHELL_STORE_DATABASE_URL_ENV]);
  if (databaseUrl === undefined) {
    throw new Error("Developer shell Postgres store URL is missing.");
  }
  return { driver, revision, databaseUrl };
}

function readRequiredValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized !== undefined && normalized.length > 0
    ? normalized
    : undefined;
}
