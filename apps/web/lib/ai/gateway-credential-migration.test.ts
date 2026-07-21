import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  encryptGatewayCredential,
  isEncryptedGatewayCredential,
} from "./gateway-credential-crypto";
import {
  buildGatewayCredentialMigrationPlan,
  parseGatewayCredentialMigrationMode,
} from "./gateway-credential-migration";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "migration-v1",
  KESTREL_GATEWAY_CREDENTIAL_KEYS: JSON.stringify({
    "migration-v1": Buffer.alloc(32, 9).toString("base64"),
  }),
};

contractTest("web.hermetic", "gateway credential migration identifies only plaintext stored values", () => {
  const encrypted = encryptGatewayCredential({
    gatewayId: "gateway-encrypted",
    plaintext: "encrypted-secret",
    env,
  });
  const plan = buildGatewayCredentialMigrationPlan([
    { id: "gateway-env", apiKey: null },
    { id: "gateway-plaintext", apiKey: "plaintext-secret" },
    { id: "gateway-encrypted", apiKey: encrypted },
  ]);

  assert.equal(plan.gatewayCount, 3);
  assert.equal(plan.stored.length, 2);
  assert.deepEqual(
    plan.plaintext.map((row) => row.id),
    ["gateway-plaintext"]
  );
  assert.equal(plan.encryptedCount, 1);
});

contractTest("web.hermetic", "gateway credential migration planning is idempotent after encryption", () => {
  const encrypted = encryptGatewayCredential({
    gatewayId: "gateway-1",
    plaintext: "provider-secret",
    env,
  });

  assert.equal(isEncryptedGatewayCredential(encrypted), true);
  assert.equal(
    buildGatewayCredentialMigrationPlan([
      { id: "gateway-1", apiKey: encrypted },
    ]).plaintext.length,
    0
  );
});

contractTest("web.hermetic", "gateway credential migration arguments fail closed on unknown flags", () => {
  assert.equal(parseGatewayCredentialMigrationMode([]), "migrate");
  assert.equal(parseGatewayCredentialMigrationMode(["--dry-run"]), "dry-run");
  assert.equal(parseGatewayCredentialMigrationMode(["--verify"]), "verify");
  assert.throws(
    () => parseGatewayCredentialMigrationMode(["--dry-rnu"]),
    /Usage:/
  );
  assert.throws(
    () => parseGatewayCredentialMigrationMode(["--dry-run", "--verify"]),
    /Usage:/
  );
});

contractTest("web.hermetic", "gateway credential migration entrypoint runs in the CommonJS web package", async () => {
  const source = await readFile(
    new URL("../../scripts/migrate-gateway-credentials.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(
    source,
    /^\s*await runGatewayCredentialMigration\(\)/mu
  );
  assert.match(source, /runGatewayCredentialMigration\(\)\.catch\(/u);
});
