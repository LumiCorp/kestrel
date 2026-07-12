import { eq, sql } from "drizzle-orm";
import {
  assertGatewayCredentialEncryptionConfigured,
  decryptGatewayCredential,
  encryptGatewayCredential,
  isEncryptedGatewayCredential,
} from "../lib/ai/gateway-credential-crypto";
import {
  buildGatewayCredentialMigrationPlan,
  parseGatewayCredentialMigrationMode,
} from "../lib/ai/gateway-credential-migration";
import { knowledgeDb, schema } from "../lib/knowledge/db";

async function runGatewayCredentialMigration() {
  const mode = parseGatewayCredentialMigrationMode(process.argv.slice(2));

  assertGatewayCredentialEncryptionConfigured();

  let scannedGatewayCount = 0;
  let scannedStoredCredentialCount = 0;
  let scannedPlaintextCredentialCount = 0;
  let scannedEncryptedCredentialCount = 0;
  let migratedCredentialCount = 0;

  if (mode === "dry-run") {
    const rows = await knowledgeDb
      .select({
        id: schema.aiGateways.id,
        apiKey: schema.aiGateways.apiKey,
      })
      .from(schema.aiGateways);
    const plan = buildGatewayCredentialMigrationPlan(rows);
    scannedGatewayCount = plan.gatewayCount;
    scannedStoredCredentialCount = plan.stored.length;
    scannedPlaintextCredentialCount = plan.plaintext.length;
    scannedEncryptedCredentialCount = plan.encryptedCount;
  } else if (mode === "migrate") {
    await knowledgeDb.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('kestrel-one-gateway-credential-migration'))`
      );
      const rows = await tx
        .select({
          id: schema.aiGateways.id,
          apiKey: schema.aiGateways.apiKey,
        })
        .from(schema.aiGateways)
        .for("update");
      const plan = buildGatewayCredentialMigrationPlan(rows);
      scannedGatewayCount = plan.gatewayCount;
      scannedStoredCredentialCount = plan.stored.length;
      scannedPlaintextCredentialCount = plan.plaintext.length;
      scannedEncryptedCredentialCount = plan.encryptedCount;

      const plaintextIds = new Set(plan.plaintext.map((row) => row.id));
      for (const row of plan.stored) {
        const nextApiKey = plaintextIds.has(row.id)
          ? encryptGatewayCredential({
              gatewayId: row.id,
              plaintext: row.apiKey,
            })
          : row.apiKey;
        const updated = await tx
          .update(schema.aiGateways)
          .set({
            apiKey: nextApiKey,
            apiKeyEnvVar: null,
            updatedAt: new Date(),
          })
          .where(eq(schema.aiGateways.id, row.id))
          .returning({ id: schema.aiGateways.id });
        if (updated.length !== 1) {
          throw new Error("Gateway credential migration update failed.");
        }
        if (plaintextIds.has(row.id)) {
          migratedCredentialCount += 1;
        }
      }
    });
  }

  const verifiedRows =
    mode === "dry-run"
      ? []
      : await knowledgeDb
          .select({
            id: schema.aiGateways.id,
            apiKey: schema.aiGateways.apiKey,
            apiKeyEnvVar: schema.aiGateways.apiKeyEnvVar,
          })
          .from(schema.aiGateways);

  if (mode === "verify") {
    const plan = buildGatewayCredentialMigrationPlan(verifiedRows);
    scannedGatewayCount = plan.gatewayCount;
    scannedStoredCredentialCount = plan.stored.length;
    scannedPlaintextCredentialCount = plan.plaintext.length;
    scannedEncryptedCredentialCount = plan.encryptedCount;
  }

  if (mode !== "dry-run") {
    for (const row of verifiedRows) {
      if (!row.apiKey?.trim()) {
        continue;
      }
      if (!isEncryptedGatewayCredential(row.apiKey)) {
        throw new Error(
          `Gateway '${row.id}' still contains a plaintext credential.`
        );
      }
      decryptGatewayCredential({
        gatewayId: row.id,
        encrypted: row.apiKey,
      });
      if (row.apiKeyEnvVar?.trim()) {
        throw new Error(
          `Gateway '${row.id}' still combines a stored credential with an environment fallback.`
        );
      }
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      mode,
      gateways: scannedGatewayCount,
      storedCredentials: scannedStoredCredentialCount,
      plaintextCredentials: scannedPlaintextCredentialCount,
      encryptedCredentials: scannedEncryptedCredentialCount,
      migratedCredentials: migratedCredentialCount,
      verifiedCredentials:
        mode === "dry-run"
          ? 0
          : verifiedRows.filter((row) => row.apiKey).length,
    })}\n`
  );
}

try {
  await runGatewayCredentialMigration();
} catch {
  process.stderr.write("Gateway credential migration failed.\n");
  process.exitCode = 1;
}
