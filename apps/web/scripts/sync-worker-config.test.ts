import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  assertStagedWorkerSecretInventory,
  assertFlyOwnedAuthorityPresent,
  classifyWorkerSecretInventory,
  selectWorkerConfiguration,
  serializeWorkerConfiguration,
} from "./sync-worker-config";

const encryptionKey = Buffer.alloc(32, 4).toString("base64");

test("role selection keeps Vercel shared configuration inside each worker contract", () => {
  const source = controlSource();
  const selected = selectWorkerConfiguration("control-worker", source);
  assert.equal(selected.CRON_SECRET, undefined);
  assert.equal(selected.FLY_API_TOKEN, undefined);
  assert.equal(selected.KESTREL_FLY_ORGANIZATION_SLUG, undefined);
  assert.equal(selected.POSTGRES_URL, source.POSTGRES_URL);
  assert.deepEqual(
    classifyWorkerSecretInventory(
      "control-worker",
      [
        "CRON_SECRET",
        "FLY_API_TOKEN",
        "KESTREL_FLY_ORGANIZATION_SLUG",
        "POSTGRES_URL",
      ],
      selected,
    ).removals,
    ["CRON_SECRET"],
  );
});

test("RunPod selection requires managed mode and never accepts provider credentials", () => {
  const source = {
    POSTGRES_URL: "postgres://database",
    KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "primary",
    KESTREL_GATEWAY_CREDENTIAL_KEYS: JSON.stringify({
      primary: encryptionKey,
    }),
    KESTREL_PRIVATE_INFERENCE_ENABLED: "true",
    RUNPOD_MANAGED_DEPLOYMENTS_ENABLED: "true",
  };
  assert.deepEqual(selectWorkerConfiguration("runpod-worker", source), source);
  assert.throws(
    () =>
      selectWorkerConfiguration("runpod-worker", {
        ...source,
        RUNPOD_MANAGED_DEPLOYMENTS_ENABLED: "false",
      }),
    /managed deployment flags/u,
  );
  assert.throws(
    () =>
      classifyWorkerSecretInventory(
        "runpod-worker",
        ["POSTGRES_URL", "RUNPOD_API_KEY"],
        source,
      ),
    /forbidden provider authority: RUNPOD_API_KEY/u,
  );
});

test("configuration synchronization fails on unknown managed names", () => {
  assert.throws(
    () =>
      classifyWorkerSecretInventory(
        "turn-worker",
        ["KESTREL_UNDECLARED_AUTHORITY"],
        {},
      ),
    /unknown managed secrets/u,
  );
});

test("control-worker refuses deployment without its Fly-owned authority", () => {
  assert.throws(
    () => assertFlyOwnedAuthorityPresent("control-worker", ["FLY_API_TOKEN"]),
    /missing Fly-owned authority: KESTREL_FLY_ORGANIZATION_SLUG/u,
  );
});

test("configuration values are serialized for stdin and staged inventory is exact", () => {
  assert.equal(
    serializeWorkerConfiguration({
      BETA: "line one\nline two",
      ALPHA: "plain",
    }),
    'ALPHA="plain"\nBETA="line one\\nline two"\n',
  );
  assert.doesNotThrow(() =>
    assertStagedWorkerSecretInventory({
      selectedNames: ["ALPHA"],
      removalNames: ["CRON_SECRET"],
      inventory: [
        { name: "ALPHA", status: "staged" },
        { name: "CRON_SECRET", status: "pending" },
      ],
    }),
  );
  assert.throws(
    () =>
      assertStagedWorkerSecretInventory({
        selectedNames: ["ALPHA"],
        removalNames: [],
        inventory: [{ name: "ALPHA", status: "deployed" }],
      }),
    /not staged: ALPHA/u,
  );
});

function controlSource() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    POSTGRES_URL: "postgres://database",
    CRON_SECRET: "web-only",
    FLY_API_TOKEN: "fly-owned",
    KESTREL_APP_CREDENTIAL_ACTIVE_KEY_ID: "primary",
    KESTREL_APP_CREDENTIAL_KEYS: JSON.stringify({ primary: encryptionKey }),
    KESTREL_ENVIRONMENTS_ENABLED: "true",
    KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    KESTREL_FLY_ORGANIZATION_SLUG: "fly-owned",
    KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "primary",
    KESTREL_GATEWAY_CREDENTIAL_KEYS: JSON.stringify({ primary: encryptionKey }),
    KESTREL_ONE_APP_URL: "https://kestrel.example",
    KESTREL_ONE_CREDENTIAL_BROKER_TOKEN: "broker",
    KESTREL_ONE_TOOL_TOKEN: "tool",
    KESTREL_WORKSPACE_BACKUP_KEY: encryptionKey,
    KESTREL_WORKSPACE_BACKUP_KEY_ID: "backup-v1",
    STORAGE_ACCESS_KEY_ID: "access",
    STORAGE_BUCKET: "bucket",
    STORAGE_ENDPOINT: "https://storage.example",
    STORAGE_PROVIDER: "s3",
    STORAGE_SECRET_ACCESS_KEY: "secret",
  };
}
