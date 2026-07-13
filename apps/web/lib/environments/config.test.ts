import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import test from "node:test";
import {
  assertHostedEnvironmentConfiguration,
  hostedEnvironmentsDeploymentEnabled,
  hostedEnvironmentsEnabled,
} from "./config";

function validEnvironment() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    CRON_SECRET: "cron-secret",
    FLY_API_TOKEN: "FlyV1 example",
    KESTREL_FLY_ORGANIZATION_SLUG: "personal",
    KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY: privateKey.export({
      format: "pem",
      type: "pkcs8",
    }) as string,
    KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: publicKey.export({
      format: "pem",
      type: "spki",
    }) as string,
    KESTREL_ENVIRONMENT_ROUTER_IMAGE: `registry.fly.io/kestrel-one-runner@sha256:${"a".repeat(64)}`,
    KESTREL_WORKSPACE_RUNTIME_IMAGE: `registry.fly.io/kestrel-one-runner@sha256:${"b".repeat(64)}`,
    KESTREL_WORKSPACE_BACKUP_KEY: randomBytes(32).toString("base64"),
    KESTREL_WORKSPACE_BACKUP_KEY_ID: "workspace-backup-v1",
    KESTREL_ONE_APP_URL: "https://kestrel-one.example",
    KESTREL_ONE_CREDENTIAL_BROKER_TOKEN: "broker-secret",
    KESTREL_ONE_TOOL_TOKEN: "tool-secret",
    KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "key-v1",
    KESTREL_GATEWAY_CREDENTIAL_KEYS: JSON.stringify({
      "key-v1": randomBytes(32).toString("base64"),
    }),
  };
}

test("Environment rollout requires both deployment and organization flags", () => {
  assert.equal(hostedEnvironmentsDeploymentEnabled({}), false);
  assert.equal(
    hostedEnvironmentsDeploymentEnabled({
      KESTREL_ENVIRONMENTS_ENABLED: "true",
    }),
    true
  );
  assert.equal(
    hostedEnvironmentsEnabled({
      organizationEnabled: false,
      env: { KESTREL_ENVIRONMENTS_ENABLED: "true" },
    }),
    false
  );
  assert.equal(
    hostedEnvironmentsEnabled({
      organizationEnabled: true,
      env: { KESTREL_ENVIRONMENTS_ENABLED: "true" },
    }),
    true
  );
  assert.equal(
    hostedEnvironmentsEnabled({ organizationEnabled: true, env: {} }),
    false
  );
});

test("hosted cutover accepts complete immutable Environment configuration", () => {
  assert.doesNotThrow(() =>
    assertHostedEnvironmentConfiguration(validEnvironment())
  );
});

test("hosted cutover rejects missing values and legacy global runner configuration", () => {
  assert.throws(
    () => assertHostedEnvironmentConfiguration({}),
    /Hosted Environment configuration is incomplete/u
  );
  assert.throws(
    () =>
      assertHostedEnvironmentConfiguration({
        ...validEnvironment(),
        KESTREL_RUNNER_SERVICE_URL: "https://legacy-runner.example",
      }),
    /removing legacy global runner configuration/u
  );
});

test("hosted cutover rejects mutable images and mismatched ticket keys", () => {
  assert.throws(
    () =>
      assertHostedEnvironmentConfiguration({
        ...validEnvironment(),
        KESTREL_ENVIRONMENT_ROUTER_IMAGE:
          "registry.fly.io/kestrel-one-runner:latest",
      }),
    /immutable registry\.fly\.io sha256 digest/u
  );
  const first = validEnvironment();
  const second = validEnvironment();
  assert.throws(
    () =>
      assertHostedEnvironmentConfiguration({
        ...first,
        KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY:
          second.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY,
      }),
    /matching Ed25519 private\/public key pair/u
  );
});
