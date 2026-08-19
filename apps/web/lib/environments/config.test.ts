import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  assertHostedEnvironmentConfiguration,
  assertHostedEnvironmentRuntimeConfiguration,
  assertLocalEnvironmentRuntimeConfiguration,
  getHostedEnvironmentRuntimeMode,
  getHostedRoutingContractMode,
  hostedEnvironmentsDeploymentEnabled,
  hostedEnvironmentsEnabled,
  hostedEnvironmentsOrganizationEnabled,
} from "./config";


test("Environment runtime mode defaults to Fly and selects local explicitly", () => {
  assert.equal(getHostedEnvironmentRuntimeMode({}), "fly");
  assert.equal(
    getHostedEnvironmentRuntimeMode({
      KESTREL_ENVIRONMENT_RUNTIME: "local",
    }),
    "local"
  );
  assert.throws(
    () =>
      getHostedEnvironmentRuntimeMode({
        KESTREL_ENVIRONMENT_RUNTIME: "local",
        VERCEL_ENV: "preview",
      }),
    /cannot be used in a Vercel deployment/u
  );
  assert.throws(
    () =>
      getHostedEnvironmentRuntimeMode({
        KESTREL_ENVIRONMENT_RUNTIME: "docker",
      }),
    /must be fly or local/u
  );
});

test("hosted routing rolls out as one global reader-first contract mode", () => {
  assert.equal(getHostedRoutingContractMode({}), "legacy");
  assert.equal(
    getHostedRoutingContractMode({ KESTREL_HOSTED_ROUTING_CONTRACT_MODE: "logical-v1" }),
    "logical-v1",
  );
  assert.throws(() => getHostedRoutingContractMode({
    KESTREL_HOSTED_ROUTING_CONTRACT_MODE: "kubernetes",
  }), /legacy or logical-v1/u);
});

test("local Environment mode needs only the loopback runner service", () => {
  const local = {
    KESTREL_ENVIRONMENT_RUNTIME: "local",
    KESTREL_LOCAL_ENVIRONMENT_RUNNER_URL: "http://127.0.0.1:43106",
  };
  assert.doesNotThrow(() => assertHostedEnvironmentConfiguration(local));
  assert.doesNotThrow(() => assertLocalEnvironmentRuntimeConfiguration(local));
  assert.throws(
    () =>
      assertHostedEnvironmentConfiguration({
        KESTREL_ENVIRONMENT_RUNTIME: "local",
      }),
    /requires KESTREL_LOCAL_ENVIRONMENT_RUNNER_URL/u
  );
  assert.throws(
    () =>
      assertHostedEnvironmentConfiguration({
        KESTREL_ENVIRONMENT_RUNTIME: "local",
        KESTREL_LOCAL_ENVIRONMENT_RUNNER_URL: "https://runner.example",
      }),
    /must target localhost/u
  );
});

test("the checked-in local environment enables hosted Environments", async () => {
  const envExample = await readFile(
    new URL("../../.env.example", import.meta.url),
    "utf8"
  );
  assert.match(envExample, /^KESTREL_ENVIRONMENTS_ENABLED=true$/mu);
});

function validEnvironment() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    CRON_SECRET: "cron-secret",
    KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY: privateKey.export({
      format: "pem",
      type: "pkcs8",
    }) as string,
    KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: publicKey.export({
      format: "pem",
      type: "spki",
    }) as string,
    KESTREL_WORKSPACE_BACKUP_KEY: randomBytes(32).toString("base64"),
    KESTREL_WORKSPACE_BACKUP_KEY_ID: "workspace-backup-v1",
    KESTREL_ONE_APP_URL: "https://kestrel-one.example",
    KESTREL_ONE_CREDENTIAL_BROKER_TOKEN: "legacy-rollout-broker-secret",
    KESTREL_ONE_TOOL_TOKEN: "tool-secret",
    KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "key-v1",
    KESTREL_GATEWAY_CREDENTIAL_KEYS: JSON.stringify({
      "key-v1": randomBytes(32).toString("base64"),
    }),
  };
}

test("Environment deployment defaults on while organization eligibility is explicit", () => {
  assert.equal(hostedEnvironmentsDeploymentEnabled({}), true);
  assert.equal(
    hostedEnvironmentsDeploymentEnabled({
      KESTREL_ENVIRONMENTS_ENABLED: "true",
    }),
    true
  );
  assert.equal(
    hostedEnvironmentsDeploymentEnabled({
      KESTREL_ENVIRONMENTS_ENABLED: "false",
    }),
    false
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
    true
  );
  assert.equal(hostedEnvironmentsOrganizationEnabled(undefined), false);
  assert.equal(hostedEnvironmentsOrganizationEnabled(null), false);
  assert.equal(hostedEnvironmentsOrganizationEnabled(true), true);
  assert.equal(hostedEnvironmentsOrganizationEnabled(false), false);
});

test("hosted cutover accepts complete non-image Environment configuration", () => {
  assert.doesNotThrow(() =>
    assertHostedEnvironmentConfiguration(validEnvironment())
  );
});

test("tenant Environment readiness does not depend on platform Fly authority", () => {
  assert.doesNotThrow(() =>
    assertHostedEnvironmentConfiguration(validEnvironment())
  );
});

test("hosted runtime preparation permits the legacy runner during staged deployment", () => {
  assert.doesNotThrow(() =>
    assertHostedEnvironmentRuntimeConfiguration({
      ...validEnvironment(),
      KESTREL_RUNNER_SERVICE_URL: "https://legacy-runner.example",
      KESTREL_RUNNER_SERVICE_TOKEN: "legacy-token",
    })
  );
});

test("hosted runtime readiness does not read duplicated image configuration", () => {
  const environment = validEnvironment();
  assert.doesNotThrow(() =>
    assertHostedEnvironmentRuntimeConfiguration({
      ...environment,
      KESTREL_ENVIRONMENT_ROUTER_IMAGE: "not-runtime-authority",
      KESTREL_WORKSPACE_RUNTIME_IMAGE: "not-runtime-authority",
    })
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

test("hosted cutover rejects mismatched ticket keys", () => {
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
