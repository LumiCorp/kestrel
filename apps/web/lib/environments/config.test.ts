import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  assertHostedEnvironmentConfiguration,
  assertHostedEnvironmentRuntimeConfiguration,
  assertLocalEnvironmentRuntimeConfiguration,
  getHostedEnvironmentBuildPreflightPhase,
  getHostedEnvironmentRuntimeMode,
  hostedEnvironmentPreflightRequiresQuietCutover,
  hostedEnvironmentsDeploymentEnabled,
  hostedEnvironmentsEnabled,
  hostedEnvironmentsOrganizationEnabled,
} from "./config";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "Environment runtime mode defaults to Fly and selects local explicitly", () => {
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

contractTest("web.hermetic", "local Environment mode needs only the loopback runner service", () => {
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

contractTest("web.hermetic", "production builds select a fail-closed hosted Environment preflight phase", () => {
  assert.equal(getHostedEnvironmentBuildPreflightPhase({}), null);
  assert.equal(
    getHostedEnvironmentBuildPreflightPhase({
      VERCEL_ENV: "preview",
      KESTREL_ENVIRONMENTS_ENABLED: "true",
    }),
    null
  );
  assert.equal(
    getHostedEnvironmentBuildPreflightPhase({
      VERCEL_ENV: "production",
      KESTREL_ENVIRONMENTS_ENABLED: "false",
    }),
    "prepare"
  );
  assert.equal(
    getHostedEnvironmentBuildPreflightPhase({
      VERCEL_ENV: "production",
      KESTREL_ENVIRONMENTS_ENABLED: "true",
    }),
    "deploy"
  );
  assert.equal(
    getHostedEnvironmentBuildPreflightPhase({
      VERCEL_ENV: "production",
    }),
    "deploy"
  );
  assert.throws(
    () =>
      getHostedEnvironmentBuildPreflightPhase({
        VERCEL_ENV: "production",
        KESTREL_ENVIRONMENTS_ENABLED: "enabled",
      }),
    /must be true or false when configured/u
  );
});

contractTest("web.hermetic", "steady-state deployment does not require a quiet Environment execution boundary", () => {
  assert.equal(
    hostedEnvironmentPreflightRequiresQuietCutover("prepare"),
    false
  );
  assert.equal(
    hostedEnvironmentPreflightRequiresQuietCutover("deploy"),
    false
  );
  assert.equal(
    hostedEnvironmentPreflightRequiresQuietCutover("cutover"),
    true
  );
});

contractTest("web.hermetic", "Vercel production delegates to the phased deployment preflight", async () => {
  const source = await readFile(
    new URL("../../scripts/vercel-production-preflight.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /await import\("\.\/hosted-environment-build-preflight"\)/u
  );
  assert.doesNotMatch(
    source,
    /await import\("\.\/hosted-environment-preflight"\)/u
  );
});

contractTest("web.hermetic", "the checked-in local environment enables hosted Environments", async () => {
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
    KESTREL_ONE_CREDENTIAL_BROKER_TOKEN: "legacy-rollout-broker-secret",
    KESTREL_ONE_TOOL_TOKEN: "tool-secret",
    KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "key-v1",
    KESTREL_GATEWAY_CREDENTIAL_KEYS: JSON.stringify({
      "key-v1": randomBytes(32).toString("base64"),
    }),
  };
}

contractTest("web.hermetic", "Environment rollout defaults on with explicit off switches", () => {
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
  assert.equal(hostedEnvironmentsOrganizationEnabled(undefined), true);
  assert.equal(hostedEnvironmentsOrganizationEnabled(null), true);
  assert.equal(hostedEnvironmentsOrganizationEnabled(true), true);
  assert.equal(hostedEnvironmentsOrganizationEnabled(false), false);
});

contractTest("web.hermetic", "hosted cutover accepts complete immutable Environment configuration", () => {
  assert.doesNotThrow(() =>
    assertHostedEnvironmentConfiguration(validEnvironment())
  );
});

contractTest("web.hermetic", "hosted runtime preparation permits the legacy runner during staged deployment", () => {
  assert.doesNotThrow(() =>
    assertHostedEnvironmentRuntimeConfiguration({
      ...validEnvironment(),
      KESTREL_RUNNER_SERVICE_URL: "https://legacy-runner.example",
      KESTREL_RUNNER_SERVICE_TOKEN: "legacy-token",
    })
  );
});

contractTest("web.hermetic", "hosted runtime image validation ignores surrounding deployment whitespace", () => {
  const environment = validEnvironment();
  assert.doesNotThrow(() =>
    assertHostedEnvironmentRuntimeConfiguration({
      ...environment,
      KESTREL_ENVIRONMENT_ROUTER_IMAGE: ` ${environment.KESTREL_ENVIRONMENT_ROUTER_IMAGE}\n`,
      KESTREL_WORKSPACE_RUNTIME_IMAGE: `${environment.KESTREL_WORKSPACE_RUNTIME_IMAGE}\n`,
    })
  );
});

contractTest("web.hermetic", "hosted cutover rejects missing values and legacy global runner configuration", () => {
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

contractTest("web.hermetic", "hosted cutover rejects mutable images and mismatched ticket keys", () => {
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
