import assert from "node:assert/strict";
import {
  GatewayCredentialSourceError,
  normalizeGatewayStoredCredential,
  resolveGatewayEnvironmentCredential,
  selectGatewayCredentialEnvVarForCreate,
  selectGatewayCredentialEnvVarForUpdate,
  shouldClearStoredGatewayCredentialForUpdate,
} from "./gateway-credential-source";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "stored gateway credentials do not retain an implicit environment fallback", () => {
  assert.equal(
    selectGatewayCredentialEnvVarForCreate({
      apiKey: "stored-secret",
      apiKeyEnvVar: undefined,
      defaultApiKeyEnvVar: "OPENAI_API_KEY",
    }),
    null
  );
  assert.equal(
    selectGatewayCredentialEnvVarForUpdate({
      apiKey: null,
      apiKeyEnvVar: undefined,
    }),
    null
  );
});

contractTest("web.hermetic", "environment-backed gateway credentials require an explicit stored env-var name", () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    OPENAI_API_KEY: "app-owned-secret",
  };
  assert.equal(
    resolveGatewayEnvironmentCredential({
      apiKeyEnvVar: "OPENAI_API_KEY",
      env,
    }),
    "app-owned-secret"
  );
  assert.equal(
    resolveGatewayEnvironmentCredential({ apiKeyEnvVar: null, env }),
    null
  );
});

contractTest("web.hermetic", "gateways created without a stored key retain their app-owned env source", () => {
  assert.equal(
    selectGatewayCredentialEnvVarForCreate({
      apiKey: null,
      apiKeyEnvVar: undefined,
      defaultApiKeyEnvVar: "OPENROUTER_API_KEY",
    }),
    "OPENROUTER_API_KEY"
  );
});

contractTest("web.hermetic", "gateway credential writes reject simultaneous stored and environment sources", () => {
  assert.throws(
    () =>
      selectGatewayCredentialEnvVarForCreate({
        apiKey: "stored-secret",
        apiKeyEnvVar: "OPENAI_API_KEY",
        defaultApiKeyEnvVar: null,
      }),
    GatewayCredentialSourceError
  );
  assert.throws(
    () =>
      selectGatewayCredentialEnvVarForUpdate({
        apiKey: "stored-secret",
        apiKeyEnvVar: "OPENAI_API_KEY",
      }),
    GatewayCredentialSourceError
  );
});

contractTest("web.hermetic", "switching to an environment credential clears any stored credential", () => {
  assert.equal(
    shouldClearStoredGatewayCredentialForUpdate({
      apiKey: undefined,
      apiKeyEnvVar: "OPENAI_API_KEY",
    }),
    true
  );
  assert.equal(
    shouldClearStoredGatewayCredentialForUpdate({
      apiKey: undefined,
      apiKeyEnvVar: null,
    }),
    false
  );
});

contractTest("web.hermetic", "stored gateway credential input is trimmed and rejects whitespace", () => {
  assert.equal(
    normalizeGatewayStoredCredential("  provider-secret  "),
    "provider-secret"
  );
  assert.throws(
    () => normalizeGatewayStoredCredential("   "),
    (error) =>
      error instanceof GatewayCredentialSourceError &&
      error.code === "GATEWAY_CREDENTIAL_EMPTY"
  );
});
