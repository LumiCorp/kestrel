import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  assertControlWorkerProcessConfiguration,
  assertRunPodWorkerProcessConfiguration,
  assertTurnWorkerProcessConfiguration,
  assertWebProcessConfiguration,
  resolveTurnWorkerConcurrency,
} from "./process-contracts";

function turnWorkerEnvironment() {
  const keys = generateKeyPairSync("ed25519");
  return {
    POSTGRES_URL: "postgres://database",
    REDIS_URL: "redis://cache",
    KESTREL_ENVIRONMENTS_ENABLED: "true",
    KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY: keys.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: keys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "primary",
    KESTREL_GATEWAY_CREDENTIAL_KEYS: '{"primary":"secret"}',
    KESTREL_ONE_APP_URL: "https://kestrelagents.dev",
    KESTREL_ONE_CREDENTIAL_BROKER_TOKEN: "broker",
    KESTREL_ONE_PROFILE_ID: "kestrel",
    KESTREL_ONE_TOOL_TOKEN: "tool",
  };
}

function controlWorkerEnvironment() {
  const keys = generateKeyPairSync("ed25519");
  const encryptionKey = Buffer.alloc(32, 7).toString("base64");
  return {
    POSTGRES_URL: "postgres://database",
    FLY_API_TOKEN: "platform-authority",
    KESTREL_ENVIRONMENTS_ENABLED: "true",
    KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY: keys.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: keys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    KESTREL_FLY_ORGANIZATION_SLUG: "platform",
    KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "primary",
    KESTREL_GATEWAY_CREDENTIAL_KEYS: JSON.stringify({
      primary: encryptionKey,
    }),
    KESTREL_ONE_APP_URL: "https://kestrelagents.dev",
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

function runPodWorkerEnvironment() {
  const encryptionKey = Buffer.alloc(32, 9).toString("base64");
  return {
    POSTGRES_URL: "postgres://database",
    KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "primary",
    KESTREL_GATEWAY_CREDENTIAL_KEYS: JSON.stringify({
      primary: encryptionKey,
    }),
    KESTREL_PRIVATE_INFERENCE_ENABLED: "true",
    RUNPOD_MANAGED_DEPLOYMENTS_ENABLED: "true",
  };
}

function webEnvironment() {
  const control = controlWorkerEnvironment();
  return {
    POSTGRES_URL: control.POSTGRES_URL,
    CRON_SECRET: "cron",
    FLY_API_TOKEN: control.FLY_API_TOKEN,
    KESTREL_ENVIRONMENTS_ENABLED: control.KESTREL_ENVIRONMENTS_ENABLED,
    KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY:
      control.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY,
    KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY:
      control.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY,
    KESTREL_FLY_ORGANIZATION_SLUG: control.KESTREL_FLY_ORGANIZATION_SLUG,
    KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID:
      control.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID,
    KESTREL_GATEWAY_CREDENTIAL_KEYS:
      control.KESTREL_GATEWAY_CREDENTIAL_KEYS,
    KESTREL_ONE_APP_URL: control.KESTREL_ONE_APP_URL,
    KESTREL_ONE_CREDENTIAL_BROKER_TOKEN:
      control.KESTREL_ONE_CREDENTIAL_BROKER_TOKEN,
    KESTREL_ONE_TOOL_TOKEN: control.KESTREL_ONE_TOOL_TOKEN,
    KESTREL_WORKSPACE_BACKUP_KEY: control.KESTREL_WORKSPACE_BACKUP_KEY,
    KESTREL_WORKSPACE_BACKUP_KEY_ID:
      control.KESTREL_WORKSPACE_BACKUP_KEY_ID,
    STORAGE_ACCESS_KEY_ID: control.STORAGE_ACCESS_KEY_ID,
    STORAGE_BUCKET: control.STORAGE_BUCKET,
    STORAGE_ENDPOINT: control.STORAGE_ENDPOINT,
    STORAGE_PROVIDER: control.STORAGE_PROVIDER,
    STORAGE_SECRET_ACCESS_KEY: control.STORAGE_SECRET_ACCESS_KEY,
  };
}

test("web production configuration rejects legacy image authority", () => {
  const valid = webEnvironment();
  assert.doesNotThrow(() => assertWebProcessConfiguration(valid));
  assert.throws(
    () =>
      assertWebProcessConfiguration({
        ...valid,
        KESTREL_WORKSPACE_RUNTIME_IMAGE: "legacy-image",
      }),
    /forbidden values: KESTREL_WORKSPACE_RUNTIME_IMAGE/u,
  );
});

test("turn-worker configuration rejects cross-role authority", () => {
  const valid = turnWorkerEnvironment();
  assert.doesNotThrow(() => assertTurnWorkerProcessConfiguration(valid));
  assert.throws(
    () =>
      assertTurnWorkerProcessConfiguration({
        ...valid,
        FLY_API_TOKEN: "platform-authority",
      }),
    /forbidden values: FLY_API_TOKEN/u,
  );
  assert.throws(
    () =>
      assertTurnWorkerProcessConfiguration({
        ...valid,
        KESTREL_WORKSPACE_RUNTIME_IMAGE: "ghcr.io/example:legacy",
      }),
    /forbidden values: KESTREL_WORKSPACE_RUNTIME_IMAGE/u,
  );
});

test("turn-worker concurrency defaults to sixteen and accepts bounds", () => {
  assert.equal(resolveTurnWorkerConcurrency({}), 16);
  assert.equal(
    resolveTurnWorkerConcurrency({ KESTREL_TURN_WORKER_CONCURRENCY: "1" }),
    1,
  );
  assert.equal(
    resolveTurnWorkerConcurrency({ KESTREL_TURN_WORKER_CONCURRENCY: "64" }),
    64,
  );
});

test("turn-worker concurrency rejects malformed or out-of-range values", () => {
  for (const value of ["invalid", "1.5", "0", "65", "-1"]) {
    assert.throws(
      () =>
        resolveTurnWorkerConcurrency({
          KESTREL_TURN_WORKER_CONCURRENCY: value,
        }),
      /must be an integer from 1 to 64/u,
    );
  }
});

test("control-worker validation preserves semantic readiness checks", () => {
  const valid = controlWorkerEnvironment();
  assert.doesNotThrow(() => assertControlWorkerProcessConfiguration(valid));
  assert.throws(
    () =>
      assertControlWorkerProcessConfiguration({
        ...valid,
        CRON_SECRET: "web-only",
      }),
    /forbidden values: CRON_SECRET/u,
  );
  assert.throws(
    () =>
      assertControlWorkerProcessConfiguration({
        ...valid,
        KESTREL_WORKSPACE_BACKUP_KEY: "not-a-32-byte-key",
      }),
    /base64-encoded 32-byte key/u,
  );
  assert.throws(
    () =>
      assertControlWorkerProcessConfiguration({
        ...valid,
        KESTREL_ONE_APP_URL: "http://kestrelagents.dev",
      }),
    /must use HTTPS/u,
  );
  assert.throws(
    () =>
      assertControlWorkerProcessConfiguration({
        ...valid,
        KESTREL_GATEWAY_CREDENTIAL_KEYS: '{"primary":"short"}',
      }),
    /32 bytes/u,
  );
});

test("runpod-worker requires managed mode without provider authority", () => {
  const valid = runPodWorkerEnvironment();
  assert.doesNotThrow(() => assertRunPodWorkerProcessConfiguration(valid));
  assert.throws(
    () =>
      assertRunPodWorkerProcessConfiguration({
        ...valid,
        RUNPOD_MANAGED_DEPLOYMENTS_ENABLED: "false",
      }),
    /managed deployment flags must both be exactly true/u,
  );
  assert.throws(
    () =>
      assertRunPodWorkerProcessConfiguration({
        ...valid,
        RUNPOD_API_KEY: "organization-owned",
      }),
    /forbidden values: RUNPOD_API_KEY/u,
  );
});
