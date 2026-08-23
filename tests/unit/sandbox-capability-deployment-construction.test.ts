import assert from "node:assert/strict";
import test from "node:test";

import { resolveHostedSandboxCapabilityEnvironment } from "../../cli/runner/HostedRunnerStore.js";
import { resolveLocalCoreSandboxCapabilityEnvironment } from "../../src/localCore/executionRuntime.js";

const trusted = {
  KESTREL_TENANT_ID: "tenant-proof",
  KESTREL_ENVIRONMENT_ID: "environment-proof",
  KESTREL_SANDBOX_BROKER_AUTHORITY_ID: "broker-proof",
  KESTREL_SANDBOX_BROKER_AUTHORITY_REVISION: "broker-revision-proof",
};

function assertTrustedConstruction(environment: ReturnType<typeof resolveHostedSandboxCapabilityEnvironment>, fixtureFetch: typeof fetch): void {
  assert.deepEqual(environment.sandboxCapabilityAudience, { tenantId: "tenant-proof", environmentId: "environment-proof" });
  assert.deepEqual(environment.sandboxCapabilityBrokerAuthority, { authorityId: "broker-proof", revision: "broker-revision-proof" });
  assert.equal(environment.sandboxCapabilityFetchImpl, fixtureFetch);
}

test("hosted runner construction resolves trusted capability authority per call and uses only the isolated provider transport", async () => {
  let fixtureCalls = 0;
  const fixtureFetch: typeof fetch = async () => { fixtureCalls += 1; return new Response('{"results":[]}'); };
  const env: NodeJS.ProcessEnv = {
    ...trusted,
    KESTREL_SANDBOX_TAVILY_CREDENTIAL: "hosted-secret-one",
    KESTREL_SANDBOX_TAVILY_CREDENTIAL_REVISION: "hosted-revision-one",
  };
  const environment = resolveHostedSandboxCapabilityEnvironment(env, fixtureFetch);
  assertTrustedConstruction(environment, fixtureFetch);
  assert.deepEqual(await environment.sandboxCapabilityCredentialResolver?.(), {
    credentialId: "tool.tavily.default", revision: "hosted-revision-one", secret: "hosted-secret-one",
  });
  env.KESTREL_SANDBOX_TAVILY_CREDENTIAL = "hosted-secret-two";
  env.KESTREL_SANDBOX_TAVILY_CREDENTIAL_REVISION = "hosted-revision-two";
  assert.deepEqual(await environment.sandboxCapabilityCredentialResolver?.(), {
    credentialId: "tool.tavily.default", revision: "hosted-revision-two", secret: "hosted-secret-two",
  });
  await environment.sandboxCapabilityFetchImpl?.("https://api.tavily.com/search");
  assert.equal(fixtureCalls, 1);
});

test("Local Core construction binds runtime authority and credential-store revisions to the isolated provider transport", async () => {
  let secret = "local-secret-one";
  const fixtureFetch: typeof fetch = async () => new Response('{"results":[]}');
  const credentialStore = {
    available: true,
    async get(id: string) { assert.equal(id, "tool.tavily.default"); return secret; },
  };
  const snapshot = { modelEnv: {}, internetEnv: {}, runtimeEnv: { ...trusted }, mcpEnv: {} };
  const environment = resolveLocalCoreSandboxCapabilityEnvironment(snapshot as never, credentialStore as never, fixtureFetch);
  assertTrustedConstruction(environment, fixtureFetch);
  const first = await environment.sandboxCapabilityCredentialResolver?.();
  const unchanged = await environment.sandboxCapabilityCredentialResolver?.();
  assert.equal(first?.secret, "local-secret-one");
  assert.equal(unchanged?.revision, first?.revision);
  const restartedEnvironment = resolveLocalCoreSandboxCapabilityEnvironment(snapshot as never, credentialStore as never, fixtureFetch);
  assert.equal((await restartedEnvironment.sandboxCapabilityCredentialResolver?.())?.revision, first?.revision);
  secret = "local-secret-two";
  const rotated = await environment.sandboxCapabilityCredentialResolver?.();
  assert.equal(rotated?.secret, "local-secret-two");
  assert.notEqual(rotated?.revision, first?.revision);
});

test("capability-free deployment construction does not invent credential authority", () => {
  const fixtureFetch: typeof fetch = async () => new Response('{"results":[]}');
  const hosted = resolveHostedSandboxCapabilityEnvironment({ ...trusted }, fixtureFetch);
  assert.equal(hosted.sandboxCapabilityCredentialResolver, undefined);
  assert.equal(hosted.sandboxCapabilityFetchImpl, fixtureFetch);
});
