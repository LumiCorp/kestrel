import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  assertControlWorkerProcessConfiguration,
  assertRunPodWorkerProcessConfiguration,
  assertTurnWorkerProcessConfiguration,
  CONTROL_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
  processConfigurationContractFingerprint,
  RUNPOD_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
  RUNPOD_WORKER_PROCESS_CONTRACT,
  TURN_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
  TURN_WORKER_PROCESS_CONTRACT,
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
    KESTREL_APP_CREDENTIAL_ACTIVE_KEY_ID: "primary",
    KESTREL_APP_CREDENTIAL_KEYS: JSON.stringify({ primary: encryptionKey }),
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

test("turn-worker configuration fingerprint depends only on deterministic contract shape", () => {
  assert.match(
    TURN_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
    /^sha256:[a-f0-9]{64}$/u,
  );
  assert.equal(
    processConfigurationContractFingerprint(TURN_WORKER_PROCESS_CONTRACT),
    TURN_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
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
        KESTREL_WORKSPACE_RUNTIME_IMAGE: `ghcr.io/example@sha256:${"a".repeat(64)}`,
      }),
    /forbidden values: KESTREL_WORKSPACE_RUNTIME_IMAGE/u,
  );
});

test("control-worker validation preserves semantic readiness checks", () => {
  const valid = controlWorkerEnvironment();
  assert.doesNotThrow(() => assertControlWorkerProcessConfiguration(valid));
  assert.match(
    CONTROL_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
    /^sha256:[a-f0-9]{64}$/u,
  );
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
  assert.equal(
    processConfigurationContractFingerprint(RUNPOD_WORKER_PROCESS_CONTRACT),
    RUNPOD_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
  );
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
