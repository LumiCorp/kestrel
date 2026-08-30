import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { defaultToolCatalog } from "../../tools/catalog.js";
import {
  createToolActivationRefV1,
  fingerprintToolScopeV1,
  hashCanonical,
} from "../../src/kestrel/contracts/tool-contract.js";
import { parsePreparedToolCallV1 } from "../../src/kestrel/contracts/tool-invocation.js";
import {
  HOSTED_BROWSER_CAPABILITY_VERSION,
  issueHostedBrowserOperationCapability,
} from "../../src/browser/hostedCapability.js";
import {
  HOSTED_BROWSER_WORKER_HOME_PATH,
  HOSTED_BROWSER_WORKER_MAX_SERIALIZED_BYTES,
  hostedBrowserWorkerConfigFromEnv,
  startHostedBrowserWorker,
  type HostedBrowserWorkerEngine,
} from "../../src/browser/hostedWorkerServer.js";
import { measureHostedBrowserWorkerRuntime } from "../../src/browser/hostedWorkerRuntime.js";
import {
  BROWSER_RUNTIME_RELEASE_MANIFEST,
  HOSTED_BROWSER_WORKER_IMAGE_REPOSITORY,
  requireImmutableHostedBrowserWorkerImage,
} from "../../src/browser/runtimeReleaseManifest.js";
import type { BrowserEffectiveDomainAuthorityV1 } from "../../src/browser/domainAuthority.js";
import {
  HOSTED_BROWSER_VIEWER_AUDIENCE,
  HOSTED_BROWSER_VIEWER_TICKET_VERSION,
  issueHostedBrowserViewerTicket,
} from "../../src/browser/hostedViewer.js";

const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const authority: BrowserEffectiveDomainAuthorityV1 = {
  version: "browser_effective_domain_authority_v1",
  environmentId: "env-1",
  projectId: "project-1",
  userId: "user-1",
  enabledModes: ["operator"],
  personalGrantsEnabled: true,
  publicDomains: [{
    version: "browser_public_domain_authority_v1",
    scheme: "https",
    canonicalDomain: "example.com",
    includeSubdomains: true,
    port: 443,
  }],
  qaTarget: null,
  effectiveAllowlistRevision: "revision-1",
};

test("hosted worker uses the settled 20 MiB serialized payload ceiling", () => {
  assert.equal(HOSTED_BROWSER_WORKER_MAX_SERIALIZED_BYTES, 20 * 1024 * 1024);
});

test("hosted worker uses one short fixed worker-local home root", () => {
  assert.equal(HOSTED_BROWSER_WORKER_HOME_PATH, "/tmp/kb");
});

test("hosted worker measures exact installed engine and Chrome revisions", async () => {
  const calls: Array<{ executablePath: string; args: readonly string[] }> = [];
  const measured = await measureHostedBrowserWorkerRuntime({
    engineExecutablePath: "/runtime/agent-browser",
    chromeExecutablePath: "/runtime/chrome",
    async probe(executablePath, args) {
      calls.push({ executablePath, args });
      return executablePath.endsWith("agent-browser")
        ? { stdout: "agent-browser 0.35.0\n", stderr: "" }
        : {
            stdout: "Google Chrome for Testing 152.0.7977.54\n",
            stderr: "",
          };
    },
  });
  assert.deepEqual(measured, {
    engineRevision: BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision,
    chromeRevision: BROWSER_RUNTIME_RELEASE_MANIFEST.chrome.revision,
  });
  assert.deepEqual(calls, [
    { executablePath: "/runtime/agent-browser", args: ["--version"] },
    { executablePath: "/runtime/chrome", args: ["--version"] },
  ]);
});

test("hosted worker fails closed before startup on an installed runtime mismatch", async () => {
  await assert.rejects(
    measureHostedBrowserWorkerRuntime({
      engineExecutablePath: "/runtime/agent-browser",
      chromeExecutablePath: "/runtime/chrome",
      async probe(executablePath) {
        return executablePath.endsWith("agent-browser")
          ? { stdout: "agent-browser 0.34.0\n", stderr: "" }
          : {
              stdout: "Google Chrome for Testing 152.0.7977.54\n",
              stderr: "",
            };
      },
    }),
    /does not match the pinned release manifest/u,
  );
  await assert.rejects(
    measureHostedBrowserWorkerRuntime({
      engineExecutablePath: "/runtime/agent-browser",
      chromeExecutablePath: "/runtime/chrome",
      async probe() {
        throw new Error("exec failed");
      },
    }),
    /runtime measurement failed/u,
  );
});

test("hosted worker derives expected revisions locally and accepts only its approved image repository", () => {
  const image = `${HOSTED_BROWSER_WORKER_IMAGE_REPOSITORY}@sha256:${"a".repeat(64)}`;
  const config = hostedBrowserWorkerConfigFromEnv({
    KESTREL_BROWSER_SESSION_ID: "browser-session-1",
    KESTREL_BROWSER_GENERATION: "1",
    KESTREL_BROWSER_ORGANIZATION_ID: "org-1",
    KESTREL_BROWSER_ENVIRONMENT_ID: "env-1",
    KESTREL_BROWSER_PROJECT_ID: "project-1",
    KESTREL_BROWSER_USER_ID: "user-1",
    KESTREL_BROWSER_THREAD_ID: "thread-1",
    KESTREL_BROWSER_EFFECTIVE_ALLOWLIST_REVISION: "revision-1",
    KESTREL_BROWSER_WORKER_IMAGE_DIGEST: image,
    KESTREL_BROWSER_CAPABILITY_PUBLIC_KEY: publicKeyPem,
    KESTREL_BROWSER_EGRESS_GATEWAY_HOST:
      "gateway-machine-1.vm.browser-workers.internal",
    KESTREL_BROWSER_EGRESS_GATEWAY_ADDRESS: "127.0.0.1",
    KESTREL_BROWSER_EGRESS_GATEWAY_PORT: "43109",
  });
  assert.equal(
    config.engineRevision,
    BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision,
  );
  assert.equal(
    config.chromeRevision,
    BROWSER_RUNTIME_RELEASE_MANIFEST.chrome.revision,
  );
  assert.equal(config.effectiveAllowlistRevision, "revision-1");
  assert.equal(requireImmutableHostedBrowserWorkerImage(image), image);
  assert.throws(
    () =>
      requireImmutableHostedBrowserWorkerImage(
        `registry.fly.io/other@sha256:${"a".repeat(64)}`,
      ),
    /kestrel-one-browser-worker/u,
  );
});

test("hosted worker deduplicates exact accept while one adapter acceptance waits for invoke", async () => {
  const prepared = preparedNavigate();
  const capability = issueHostedBrowserOperationCapability({
    privateKeyPem,
    claims: {
      version: HOSTED_BROWSER_CAPABILITY_VERSION,
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      userId: "user-1",
      threadId: "thread-1",
      sessionId: "browser-session-1",
      generation: 1,
      operationId: prepared.callId,
      effectiveAllowlistRevision: "revision-1",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  });
  let executions = 0;
  const engine: HostedBrowserWorkerEngine = {
    async execute(_input, lifecycle) {
      await lifecycle.acknowledgeDispatch();
      executions += 1;
      const output = { version: "browser_tool_result_v1", operation: "browser.navigate", outcome: "navigated" };
      await lifecycle.persistCompletedResult(output);
      return output;
    },
    async adopt() { return 0; },
    async destroy() {},
  };
  const worker = startHostedBrowserWorker({
    config: {
      sessionId: "browser-session-1",
      generation: 1,
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      userId: "user-1",
      threadId: "thread-1",
      engineRevision: "v0.35.0",
      chromeRevision: "152.0.7977.54",
      effectiveAllowlistRevision: "revision-1",
      imageDigest: `registry.fly.io/kestrel-one-browser-worker@sha256:${"a".repeat(64)}`,
      capabilityPublicKeyPem: publicKeyPem,
      gatewayHost: "gateway-machine-1.vm.browser-workers.internal",
      gatewayAddress: "127.0.0.1",
      gatewayPort: 43_109,
      engineExecutablePath: process.execPath,
      chromeExecutablePath: process.execPath,
      port: 0,
    },
    engine,
  });
  await once(worker.server, "listening");
  const port = (worker.server.address() as AddressInfo).port;
  const request = (path: string, body: unknown) => fetch(
    `http://[::1]:${port}${path}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const acceptBody = { capability, prepared, authority };
  const first = await request("/v1/operations/accept", acceptBody);
  const duplicate = await request("/v1/operations/accept", acceptBody);
  assert.equal(first.status, 200);
  assert.deepEqual(await duplicate.json(), await first.json());
  const invokeBody = { capability, operationId: prepared.callId };
  const invoked = await request("/v1/operations/invoke", invokeBody);
  const reinvoked = await request("/v1/operations/invoke", invokeBody);
  assert.equal(invoked.status, 200);
  assert.equal(reinvoked.status, 409);
  assert.equal(
    (await reinvoked.json() as { error: { code: string } }).error.code,
    "BROWSER_ACTION_OUTCOME_UNKNOWN",
  );
  assert.equal(executions, 1);
  const committed = await request("/v1/operations/commit", invokeBody);
  assert.equal(committed.status, 200);
  await worker.close();
});

test("hosted worker rejects a capability for another actor before engine acceptance", async () => {
  const prepared = preparedNavigate();
  const capability = issueHostedBrowserOperationCapability({
    privateKeyPem,
    claims: {
      version: HOSTED_BROWSER_CAPABILITY_VERSION,
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      userId: "user-other",
      threadId: "thread-1",
      sessionId: "browser-session-1",
      generation: 1,
      operationId: prepared.callId,
      effectiveAllowlistRevision: "revision-1",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  });
  const worker = startHostedBrowserWorker({
    config: {
      sessionId: "browser-session-1", generation: 1,
      organizationId: "org-1", environmentId: "env-1", projectId: "project-1",
      userId: "user-1", threadId: "thread-1",
      engineRevision: "v0.35.0", chromeRevision: "152.0.7977.54",
      effectiveAllowlistRevision: "revision-1",
      imageDigest: `registry.fly.io/kestrel-one-browser-worker@sha256:${"a".repeat(64)}`,
      capabilityPublicKeyPem: publicKeyPem,
      gatewayHost: "gateway-machine-1.vm.browser-workers.internal",
      gatewayAddress: "127.0.0.1",
      gatewayPort: 43_109,
      engineExecutablePath: process.execPath, chromeExecutablePath: process.execPath,
      port: 0,
    },
    engine: { async execute() { assert.fail("engine must not run"); }, async adopt() { return 0; }, async destroy() {} },
  });
  await once(worker.server, "listening");
  const port = (worker.server.address() as AddressInfo).port;
  const response = await fetch(`http://[::1]:${port}/v1/operations/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability, prepared, authority }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "BROWSER_ENGINE_FAILURE");
  await worker.close();
});

test("hosted worker returns an exact pre-dispatch result without accepting an adapter operation", async () => {
  const prepared = preparedRequestGrant();
  const capability = issueHostedBrowserOperationCapability({
    privateKeyPem,
    claims: {
      version: HOSTED_BROWSER_CAPABILITY_VERSION,
      organizationId: "org-1", environmentId: "env-1", projectId: "project-1",
      userId: "user-1", threadId: "thread-1", sessionId: "browser-session-1",
      generation: 1, operationId: prepared.callId,
      effectiveAllowlistRevision: "revision-1",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  });
  let executions = 0;
  const output = {
    version: "browser_tool_result_v1",
    operation: "browser.request_grant",
    outcome: "already_allowed",
    effectiveAllowlistRevision: "revision-1",
  };
  const worker = startHostedBrowserWorker({
    config: {
      sessionId: "browser-session-1", generation: 1,
      organizationId: "org-1", environmentId: "env-1", projectId: "project-1",
      userId: "user-1", threadId: "thread-1",
      engineRevision: "v0.35.0", chromeRevision: "152.0.7977.54",
      effectiveAllowlistRevision: "revision-1",
      imageDigest: `registry.fly.io/kestrel-one-browser-worker@sha256:${"a".repeat(64)}`,
      capabilityPublicKeyPem: publicKeyPem,
      gatewayHost: "gateway-machine-1.vm.browser-workers.internal",
      gatewayAddress: "127.0.0.1",
      gatewayPort: 43_109,
      engineExecutablePath: process.execPath, chromeExecutablePath: process.execPath,
      port: 0,
    },
    engine: {
      async execute(_input, lifecycle) {
        executions += 1;
        await lifecycle.persistCompletedResult(output);
        return output;
      },
      async adopt() { return 0; },
      async destroy() {},
    },
  });
  await once(worker.server, "listening");
  const port = (worker.server.address() as AddressInfo).port;
  const request = (path: string, body: unknown) => fetch(
    `http://[::1]:${port}${path}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const body = { capability, prepared, authority };
  const completed = await request("/v1/operations/accept", body);
  const duplicate = await request("/v1/operations/accept", body);
  assert.equal(completed.status, 200);
  assert.deepEqual(await duplicate.json(), await completed.json());
  assert.equal(executions, 1);
  const invoke = await request("/v1/operations/invoke", {
    capability,
    operationId: prepared.callId,
  });
  assert.equal(invoke.status, 409);
  const commit = await request("/v1/operations/commit", {
    capability,
    operationId: prepared.callId,
  });
  assert.equal(commit.status, 200);
  await worker.close();
});

test("hosted worker destroys the session after an unmarked post-accept engine failure", async () => {
  const prepared = preparedNavigate();
  const capability = issueHostedBrowserOperationCapability({
    privateKeyPem,
    claims: {
      version: HOSTED_BROWSER_CAPABILITY_VERSION,
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      userId: "user-1",
      threadId: "thread-1",
      sessionId: "browser-session-1",
      generation: 1,
      operationId: prepared.callId,
      effectiveAllowlistRevision: "revision-1",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  });
  let destroys = 0;
  let resolveControlLoss!: () => void;
  const controlLost = new Promise<void>((resolve) => {
    resolveControlLoss = resolve;
  });
  const worker = startHostedBrowserWorker({
    config: {
      sessionId: "browser-session-1", generation: 1,
      organizationId: "org-1", environmentId: "env-1", projectId: "project-1",
      userId: "user-1", threadId: "thread-1",
      engineRevision: "v0.35.0", chromeRevision: "152.0.7977.54",
      effectiveAllowlistRevision: "revision-1",
      imageDigest: `registry.fly.io/kestrel-one-browser-worker@sha256:${"a".repeat(64)}`,
      capabilityPublicKeyPem: publicKeyPem,
      gatewayHost: "gateway-machine-1.vm.browser-workers.internal",
      gatewayAddress: "127.0.0.1",
      gatewayPort: 43_109,
      engineExecutablePath: process.execPath, chromeExecutablePath: process.execPath,
      port: 0,
    },
    engine: {
      async execute(_input, lifecycle) {
        await lifecycle.acknowledgeDispatch();
        throw new Error("BROWSER_ENGINE_FAILURE");
      },
      async adopt() { return 0; },
      async destroy() { destroys += 1; },
    },
    onControlLoss: resolveControlLoss,
  });
  await once(worker.server, "listening");
  const port = (worker.server.address() as AddressInfo).port;
  const request = (path: string, body: unknown) => fetch(
    `http://[::1]:${port}${path}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const accepted = await request("/v1/operations/accept", {
    capability,
    prepared,
    authority,
  });
  assert.equal(accepted.status, 200);
  const invoked = await request("/v1/operations/invoke", {
    capability,
    operationId: prepared.callId,
  });
  assert.equal(invoked.status, 400);
  assert.equal(
    (await invoked.json() as { error: { code: string } }).error.code,
    "BROWSER_ENGINE_FAILURE",
  );
  await controlLost;
  assert.equal(destroys, 1);
});

test("hosted worker rejects the old revision after settings adoption returns", async () => {
  const prepared = preparedNavigate();
  const operationCapability = operationCapabilityFor(prepared, "revision-1");
  const nextAuthority = {
    ...authority,
    effectiveAllowlistRevision: "revision-2",
  };
  const revisionCapability = revisionCapabilityFor("revision-2");
  let adoptionStartedResolve!: () => void;
  const adoptionStarted = new Promise<void>((resolve) => {
    adoptionStartedResolve = resolve;
  });
  let releaseAdoption!: () => void;
  const adoptionRelease = new Promise<void>((resolve) => {
    releaseAdoption = resolve;
  });
  const worker = startHostedBrowserWorker({
    config: workerConfig(),
    engine: {
      async execute(_input, lifecycle) {
        await lifecycle.acknowledgeDispatch();
        const output = { ok: true };
        await lifecycle.persistCompletedResult(output);
        return output;
      },
      async adopt() {
        adoptionStartedResolve();
        await adoptionRelease;
        return 2;
      },
      async destroy() {},
    },
  });
  await once(worker.server, "listening");
  const port = (worker.server.address() as AddressInfo).port;
  const request = (path: string, body: unknown) => fetch(
    `http://[::1]:${port}${path}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const adoption = request("/v1/operations/revision", {
    sessionId: "browser-session-1",
    generation: 1,
    revision: "revision-2",
    cause: "personal_revocation",
    authority: nextAuthority,
    capability: revisionCapability,
  });
  await adoptionStarted;
  const blocked = await request("/v1/operations/accept", {
    capability: operationCapability,
    prepared,
    authority,
  });
  assert.equal(blocked.status, 400);
  assert.equal(
    (await blocked.json() as { error: { code: string } }).error.code,
    "BROWSER_ENGINE_FAILURE",
  );
  releaseAdoption();
  assert.equal((await adoption).status, 200);
  const staleAfterInstall = await request("/v1/operations/accept", {
    capability: operationCapability,
    prepared,
    authority,
  });
  assert.equal(staleAfterInstall.status, 400);
  assert.equal(
    (await staleAfterInstall.json() as { error: { code: string } }).error.code,
    "BROWSER_ENGINE_FAILURE",
  );
  const currentCapability = operationCapabilityFor(prepared, "revision-2");
  const current = await request("/v1/operations/accept", {
    capability: currentCapability,
    prepared,
    authority: nextAuthority,
  });
  assert.equal(current.status, 200);
  const operationBody = {
    capability: currentCapability,
    operationId: prepared.callId,
  };
  assert.equal((await request("/v1/operations/invoke", operationBody)).status, 200);
  assert.equal((await request("/v1/operations/commit", operationBody)).status, 200);
  await worker.close();
});

test("hosted worker commits a request_grant revision before later acceptance", async () => {
  const grant = preparedRequestGrant();
  const nextAuthority = {
    ...authority,
    effectiveAllowlistRevision: "revision-2",
  };
  const grantCapability = issueHostedBrowserOperationCapability({
    privateKeyPem,
    claims: {
      version: HOSTED_BROWSER_CAPABILITY_VERSION,
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      userId: "user-1",
      threadId: "thread-1",
      sessionId: "browser-session-1",
      generation: 1,
      operationId: grant.callId,
      effectiveAllowlistRevision: "revision-2",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  });
  const worker = startHostedBrowserWorker({
    config: workerConfig(),
    engine: {
      async execute(input, lifecycle) {
        const operation = input.prepared.activation.descriptor.toolId;
        await lifecycle.acknowledgeDispatch();
        const output = operation === "browser.request_grant"
          ? {
              version: "browser_tool_result_v1",
              operation,
              outcome: "granted",
              sessionId: "browser-session-1",
              canonicalWildcard: "*.example.com",
              effectiveAllowlistRevision: "revision-2",
            }
          : { ok: true };
        await lifecycle.persistCompletedResult(output);
        return output;
      },
      async adopt() {
        assert.fail("request_grant installs authority inside its accepted operation");
      },
      async destroy() {},
    },
  });
  await once(worker.server, "listening");
  const port = (worker.server.address() as AddressInfo).port;
  const request = (path: string, body: unknown) => fetch(
    `http://[::1]:${port}${path}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  assert.equal((await request("/v1/operations/accept", {
    capability: grantCapability,
    prepared: grant,
    authority: nextAuthority,
  })).status, 200);
  const grantBody = { capability: grantCapability, operationId: grant.callId };
  assert.equal((await request("/v1/operations/invoke", grantBody)).status, 200);
  assert.equal((await request("/v1/operations/commit", grantBody)).status, 200);

  const next = preparedNavigate();
  const stale = await request("/v1/operations/accept", {
    capability: operationCapabilityFor(next, "revision-1"),
    prepared: next,
    authority,
  });
  assert.equal(stale.status, 400);
  const currentCapability = operationCapabilityFor(next, "revision-2");
  assert.equal((await request("/v1/operations/accept", {
    capability: currentCapability,
    prepared: next,
    authority: nextAuthority,
  })).status, 200);
  const nextBody = { capability: currentCapability, operationId: next.callId };
  assert.equal((await request("/v1/operations/invoke", nextBody)).status, 200);
  assert.equal((await request("/v1/operations/commit", nextBody)).status, 200);
  await worker.close();
});

for (const ending of ["known failure", "cancellation"] as const) {
  test(`hosted worker keeps the installed revision after request_grant ${ending}`, async () => {
    const grant = preparedRequestGrant();
    const nextAuthority = {
      ...authority,
      effectiveAllowlistRevision: "revision-2",
    };
    const grantCapability = operationCapabilityFor(grant, "revision-2");
    const worker = startHostedBrowserWorker({
      config: workerConfig(),
      engine: {
        async execute(input, lifecycle) {
          const operation = input.prepared.activation.descriptor.toolId;
          await lifecycle.acknowledgeDispatch();
          if (operation === "browser.request_grant") {
            assert.equal(ending, "known failure");
            throw Object.assign(new Error("BROWSER_DESTINATION_BLOCKED"), {
              code: "BROWSER_DESTINATION_BLOCKED",
              details: { browserOutcomeKnown: true },
            });
          }
          const output = { ok: true };
          await lifecycle.persistCompletedResult(output);
          return output;
        },
        async adopt() {
          assert.fail("request_grant must not use settings revision adoption");
        },
        async destroy() {},
      },
    });
    await once(worker.server, "listening");
    const port = (worker.server.address() as AddressInfo).port;
    const request = (path: string, body: unknown) => fetch(
      `http://[::1]:${port}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const grantAccept = await request("/v1/operations/accept", {
      capability: grantCapability,
      prepared: grant,
      authority: nextAuthority,
    });
    assert.equal(grantAccept.status, 200);
    const grantBody = {
      capability: grantCapability,
      operationId: grant.callId,
    };
    if (ending === "known failure") {
      const failed = await request("/v1/operations/invoke", grantBody);
      assert.equal(failed.status, 400);
      assert.equal(
        (await failed.json() as { error: { code: string } }).error.code,
        "BROWSER_DESTINATION_BLOCKED",
      );
    } else {
      const cancelled = await request("/v1/operations/cancel", grantBody);
      assert.equal(cancelled.status, 200);
    }

    const next = preparedNavigate();
    const uncommittedRevision = await request("/v1/operations/accept", {
      capability: operationCapabilityFor(next, "revision-2"),
      prepared: next,
      authority: nextAuthority,
    });
    assert.equal(uncommittedRevision.status, 400);
    const installedCapability = operationCapabilityFor(next, "revision-1");
    const installedRevision = await request("/v1/operations/accept", {
      capability: installedCapability,
      prepared: next,
      authority,
    });
    assert.equal(installedRevision.status, 200);
    const operationBody = {
      capability: installedCapability,
      operationId: next.callId,
    };
    assert.equal(
      (await request("/v1/operations/invoke", operationBody)).status,
      200,
    );
    assert.equal(
      (await request("/v1/operations/commit", operationBody)).status,
      200,
    );
    await worker.close();
  });
}

test("hosted worker destroys an uncommitted request_grant result before its revision can be used", async () => {
  const grant = preparedRequestGrant();
  const nextAuthority = {
    ...authority,
    effectiveAllowlistRevision: "revision-2",
  };
  const grantCapability = issueHostedBrowserOperationCapability({
    privateKeyPem,
    claims: {
      version: HOSTED_BROWSER_CAPABILITY_VERSION,
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      userId: "user-1",
      threadId: "thread-1",
      sessionId: "browser-session-1",
      generation: 1,
      operationId: grant.callId,
      effectiveAllowlistRevision: "revision-2",
      expiresAt: new Date(Date.now() + 500).toISOString(),
    },
  });
  let destroys = 0;
  let resolveControlLoss!: () => void;
  const controlLost = new Promise<void>((resolve) => {
    resolveControlLoss = resolve;
  });
  const worker = startHostedBrowserWorker({
    config: workerConfig(),
    engine: {
      async execute(_input, lifecycle) {
        await lifecycle.acknowledgeDispatch();
        const output = {
          version: "browser_tool_result_v1",
          operation: "browser.request_grant",
          outcome: "granted",
          sessionId: "browser-session-1",
          canonicalWildcard: "*.example.com",
          effectiveAllowlistRevision: "revision-2",
        };
        await lifecycle.persistCompletedResult(output);
        return output;
      },
      async adopt() {
        assert.fail("request_grant must not use settings revision adoption");
      },
      async destroy() {
        destroys += 1;
      },
    },
    onControlLoss: resolveControlLoss,
  });
  const serverClosed = once(worker.server, "close");
  await once(worker.server, "listening");
  const port = (worker.server.address() as AddressInfo).port;
  const request = (path: string, body: unknown) => fetch(
    `http://[::1]:${port}${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  assert.equal((await request("/v1/operations/accept", {
    capability: grantCapability,
    prepared: grant,
    authority: nextAuthority,
  })).status, 200);
  const grantBody = {
    capability: grantCapability,
    operationId: grant.callId,
  };
  assert.equal(
    (await request("/v1/operations/invoke", grantBody)).status,
    200,
  );

  const next = preparedNavigate();
  const uncommittedRevision = await request("/v1/operations/accept", {
    capability: operationCapabilityFor(next, "revision-2"),
    prepared: next,
    authority: nextAuthority,
  });
  assert.equal(uncommittedRevision.status, 400);
  const priorRevision = await request("/v1/operations/accept", {
    capability: operationCapabilityFor(next, "revision-1"),
    prepared: next,
    authority,
  });
  assert.equal(priorRevision.status, 400);
  await controlLost;
  await serverClosed;
  assert.equal(destroys, 1);
});

test("failed revision installation clears its barrier for a later exact accept", async () => {
  const prepared = preparedNavigate();
  const operationCapability = operationCapabilityFor(prepared, "revision-1");
  const nextAuthority = {
    ...authority,
    effectiveAllowlistRevision: "revision-2",
  };
  const worker = startHostedBrowserWorker({
    config: workerConfig(),
    engine: {
      async execute(_input, lifecycle) {
        await lifecycle.acknowledgeDispatch();
        const output = { ok: true };
        await lifecycle.persistCompletedResult(output);
        return output;
      },
      async adopt() { throw new Error("BROWSER_ENGINE_FAILURE"); },
      async destroy() {},
    },
  });
  await once(worker.server, "listening");
  const port = (worker.server.address() as AddressInfo).port;
  const request = (path: string, body: unknown) => fetch(
    `http://[::1]:${port}${path}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const failed = await request("/v1/operations/revision", {
    sessionId: "browser-session-1",
    generation: 1,
    revision: "revision-2",
    cause: "personal_revocation",
    authority: nextAuthority,
    capability: revisionCapabilityFor("revision-2"),
  });
  assert.equal(failed.status, 400);
  const accepted = await request("/v1/operations/accept", {
    capability: operationCapability,
    prepared,
    authority,
  });
  assert.equal(accepted.status, 200);
  const operationBody = {
    capability: operationCapability,
    operationId: prepared.callId,
  };
  assert.equal((await request("/v1/operations/invoke", operationBody)).status, 200);
  assert.equal((await request("/v1/operations/commit", operationBody)).status, 200);
  await worker.close();
});

test("hosted worker viewer channel accepts only the exact signed actor and forwards typed input", async () => {
  const calls: Array<{ action: string; text?: string }> = [];
  const worker = startHostedBrowserWorker({
    config: workerConfig(),
    engine: {
      async execute() { throw new Error("not called"); },
      async adopt() { return 0; },
      async viewer(input) {
        const text = input.viewerInput?.kind === "keyboard"
          ? input.viewerInput.text
          : undefined;
        calls.push({ action: input.action, ...(text === undefined ? {} : { text }) });
        return input.action === "input"
          ? {
              version: "desktop_browser_viewer_state_v1",
              available: true,
              threadId: "thread-1",
              projectId: "project-1",
              sessionId: "browser-session-1",
              generation: 1,
              connectionId: "connection-1",
              sessionState: "human_control",
              takeoverRequested: false,
              inputLeaseId: "lease-1",
              inputLeaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
              nativeHandoffActive: false,
            }
          : null;
      },
      async destroy() {},
    },
  });
  await once(worker.server, "listening");
  const port = (worker.server.address() as AddressInfo).port;
  const request = (body: unknown) => fetch(`http://[::1]:${port}/v1/viewer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const ticket = viewerTicket("user-1");
  const secret = "KSTRL-MFA-SENTINEL-8372";
  const result = await request({
    ticket,
    action: "input",
    connectionId: "connection-1",
    leaseId: "lease-1",
    viewerInput: {
      version: "desktop_browser_viewer_input_v1",
      kind: "keyboard",
      phase: "down",
      key: "8",
      text: secret,
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{ action: "input", text: secret }]);
  assert.equal((await request({ ticket: viewerTicket("other"), action: "connect" })).status, 400);
  assert.equal(calls.length, 1);
  await worker.close();
});

function preparedNavigate() {
  const descriptor = defaultToolCatalog.getDescriptorRef("browser.navigate");
  assert.ok(descriptor);
  const activation = createToolActivationRefV1({
    descriptor,
    registryGeneration: "hosted-worker-test",
    scopeFingerprint: fingerprintToolScopeV1({ hostedBrowserWorker: true }),
  });
  return parsePreparedToolCallV1({
    version: "v1",
    runId: "run-1",
    sessionId: "runtime-session-1",
    callId: "call-1",
    activation,
    origin: { kind: "trusted_runtime", producerId: "test", adapterId: "test" },
    effectiveInput: {
      sessionId: "browser-session-1",
      generation: 1,
      kind: "url",
      url: "https://example.com/next",
    },
    policy: {
      decision: "allow",
      policyRevision: hashCanonical({ revision: 1 }),
      reasonCode: "environment_policy",
    },
    preparedAt: new Date().toISOString(),
  });
}

function preparedRequestGrant() {
  const descriptor = defaultToolCatalog.getDescriptorRef("browser.request_grant");
  assert.ok(descriptor);
  const activation = createToolActivationRefV1({
    descriptor,
    registryGeneration: "hosted-worker-test",
    scopeFingerprint: fingerprintToolScopeV1({ hostedBrowserWorker: true }),
  });
  return parsePreparedToolCallV1({
    version: "v1",
    runId: "run-1",
    sessionId: "runtime-session-1",
    callId: "call-1",
    activation,
    origin: { kind: "trusted_runtime", producerId: "test", adapterId: "test" },
    effectiveInput: {
      sessionId: "browser-session-1",
      generation: 1,
      destination: "https://example.com/",
    },
    policy: {
      decision: "allow",
      policyRevision: hashCanonical({ revision: 1 }),
      reasonCode: "personal_domain_grant",
    },
    preparedAt: new Date().toISOString(),
  });
}

function workerConfig() {
  return {
    sessionId: "browser-session-1",
    generation: 1,
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    userId: "user-1",
    threadId: "thread-1",
    engineRevision: "v0.35.0",
    chromeRevision: "152.0.7977.54",
    effectiveAllowlistRevision: "revision-1",
    imageDigest: `registry.fly.io/kestrel-one-browser-worker@sha256:${"a".repeat(64)}`,
    capabilityPublicKeyPem: publicKeyPem,
    gatewayHost: "gateway-machine-1.vm.browser-workers.internal",
    gatewayAddress: "127.0.0.1",
    gatewayPort: 43_109,
    engineExecutablePath: process.execPath,
    chromeExecutablePath: process.execPath,
    port: 0,
  };
}

function operationCapabilityFor(
  prepared: ReturnType<typeof preparedNavigate>,
  revision: string,
) {
  return issueHostedBrowserOperationCapability({
    privateKeyPem,
    claims: {
      version: HOSTED_BROWSER_CAPABILITY_VERSION,
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      userId: "user-1",
      threadId: "thread-1",
      sessionId: "browser-session-1",
      generation: 1,
      operationId: prepared.callId,
      effectiveAllowlistRevision: revision,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  });
}

function revisionCapabilityFor(revision: string) {
  return issueHostedBrowserOperationCapability({
    privateKeyPem,
    claims: {
      version: HOSTED_BROWSER_CAPABILITY_VERSION,
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      userId: "user-1",
      threadId: "thread-1",
      sessionId: "browser-session-1",
      generation: 1,
      operationId: `revision:${revision}`,
      effectiveAllowlistRevision: revision,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  });
}

function viewerTicket(actorId: string) {
  const now = new Date();
  return issueHostedBrowserViewerTicket({
    privateKeyPem,
    now,
    claims: {
      version: HOSTED_BROWSER_VIEWER_TICKET_VERSION,
      audience: HOSTED_BROWSER_VIEWER_AUDIENCE,
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      threadId: "thread-1",
      sessionId: "browser-session-1",
      generation: 1,
      actorId,
      nonce: `viewer-ticket-${actorId}`,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    },
  });
}
