import { isEncryptedGatewayCredential } from "./gateway-credential-crypto";

export type GatewayCredentialMigrationRow = {
  id: string;
  apiKey: string | null;
};

export type GatewayCredentialMigrationMode = "dry-run" | "migrate" | "verify";

export function parseGatewayCredentialMigrationMode(
  args: string[]
): GatewayCredentialMigrationMode {
  if (args.length === 0) {
    return "migrate";
  }
  if (args.length === 1 && args[0] === "--dry-run") {
    return "dry-run";
  }
  if (args.length === 1 && args[0] === "--verify") {
    return "verify";
  }
  throw new Error(
    "Usage: migrate-gateway-credentials.ts [--dry-run | --verify]"
  );
}

export function buildGatewayCredentialMigrationPlan(
  rows: GatewayCredentialMigrationRow[]
) {
  const stored = rows.filter((row): row is { id: string; apiKey: string } =>
    Boolean(row.apiKey?.trim())
  );
  const plaintext = stored.filter(
    (row) => !isEncryptedGatewayCredential(row.apiKey)
  );
  return {
    gatewayCount: rows.length,
    stored,
    plaintext,
    encryptedCount: stored.length - plaintext.length,
  };
}
