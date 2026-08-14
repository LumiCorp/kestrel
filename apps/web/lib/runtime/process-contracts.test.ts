import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  assertTurnWorkerProcessConfiguration,
  processConfigurationContractFingerprint,
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
