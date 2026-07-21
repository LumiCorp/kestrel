import { createSqlExecutorFromEnv } from "../store/createSessionStore.js";
import {
  parseLocalCoreCredentialSecret,
  type LocalCoreCredentialStore,
} from "./credentialStore.js";

export interface LocalCoreExternalDatabaseVerificationResult {
  verifiedAt: string;
  target: { host: string; port: number; database: string };
  credentialConfigured: true;
}

export async function verifyAndStoreLocalCoreExternalDatabase(
  value: unknown,
  options: {
    credentialStore: LocalCoreCredentialStore;
    verify?: ((databaseUrl: string) => Promise<void>) | undefined;
  },
): Promise<LocalCoreExternalDatabaseVerificationResult> {
  const databaseUrl = parseExternalDatabaseUrl(value);
  if (options.credentialStore.available === false) {
    throw new Error("The Local Core credential store is unavailable.");
  }
  if (options.verify !== undefined) {
    await options.verify(databaseUrl);
  } else {
    const handle = createSqlExecutorFromEnv({
      driver: "postgres",
      databaseUrl,
      enforceSchemaV3: true,
    });
    try {
      await handle.executor.query("SELECT 1 AS local_core_external_database_ready");
    } finally {
      await handle.close().catch(() => {});
    }
  }
  await options.credentialStore.set("data.database.external", databaseUrl);
  const url = new URL(databaseUrl);
  return {
    verifiedAt: new Date().toISOString(),
    target: {
      host: url.hostname,
      port: Number(url.port || "5432"),
      database: decodeURIComponent(url.pathname.replace(/^\//u, "")),
    },
    credentialConfigured: true,
  };
}

export function parseExternalDatabaseUrl(value: unknown): string {
  const secret = parseLocalCoreCredentialSecret(value);
  let url: URL;
  try {
    url = new URL(secret);
  } catch {
    throw new Error("External database connection URL is invalid.");
  }
  if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || url.hostname.length === 0 || url.pathname.length <= 1) {
    throw new Error("External database connection URL must identify a PostgreSQL host and database.");
  }
  return secret;
}
