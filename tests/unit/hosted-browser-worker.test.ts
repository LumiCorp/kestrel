import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
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
  AgentBrowserHostedWorkerEngine,
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
  HOSTED_BROWSER_VIEWER_CLEANUP_AUDIENCE,
  HOSTED_BROWSER_VIEWER_CLEANUP_CAPABILITY_VERSION,
  HOSTED_BROWSER_VIEWER_TICKET_VERSION,
  issueHostedBrowserViewerCleanupCapability,
  issueHostedBrowserViewerTicket,
} from "../../src/browser/hostedViewer.js";
import {
  DesktopBrowserService,
  type DesktopBrowserAcceptedOperation,
  type DesktopBrowserEngineAdapter,
} from "../../src/localCore/desktopBrowserService.js";
import type { BrowserSessionV1 } from "../../src/browser/contracts.js";

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
  const calls: Array<{ action: string; connectionId?: string; text?: string }> = [];
  const worker = startHostedBrowserWorker({
    config: workerConfig(),
    engine: {
      async execute() { throw new Error("not called"); },
      async adopt() { return 0; },
      async viewer(input) {
        const text = input.viewerInput?.kind === "keyboard"
          ? input.viewerInput.text
          : undefined;
        calls.push({
          action: input.action,
          ...(input.connectionId === undefined
            ? {}
            : { connectionId: input.connectionId }),
          ...(text === undefined ? {} : { text }),
        });
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
  assert.deepEqual(calls, [{
    action: "input",
    connectionId: "connection-1",
    text: secret,
  }]);
  assert.equal((await request({
    ticket: viewerTicket("user-1", "connection-exact"),
    action: "connect",
    connectionId: "connection-exact",
  })).status, 200);
  assert.equal((await request({
    ticket: viewerTicket("user-1", "connection-ticket"),
    action: "connect",
    connectionId: "connection-drifted",
  })).status, 400);
  assert.equal((await request({
    ticket: viewerTicket("user-1", "connection-missing"),
    action: "connect",
  })).status, 400);
  assert.equal((await request({
    ticket: viewerTicket("other"),
    action: "connect",
    connectionId: "connection-1",
  })).status, 400);
  const expiredAt = new Date(Date.now() - 61_000);
  const expired = await request({
    ticket: viewerTicket("user-1", "expired-connection", expiredAt),
    action: "close",
    connectionId: "expired-connection",
  });
  assert.equal(expired.status, 400);
  assert.equal(
    ((await expired.json()) as { error: { code: string } }).error.code,
    "BROWSER_VIEWER_AUTHORITY_EXPIRED",
  );
  assert.deepEqual(calls.at(-1), {
    action: "connect",
    connectionId: "connection-exact",
  });
  assert.equal(calls.length, 2);
  await worker.close();
});

test("hosted worker reports transient frame unavailability while an agent operation owns the engine", async () => {
  const prepared = preparedNavigate();
  const capability = operationCapabilityFor(prepared, "revision-1");
  let viewerCalls = 0;
  const worker = startHostedBrowserWorker({
    config: workerConfig(),
    engine: {
      async execute(_input, lifecycle) {
        await lifecycle.acknowledgeDispatch();
        throw new Error("BROWSER_DESTINATION_BLOCKED");
      },
      async adopt() { return 0; },
      async viewer() {
        viewerCalls += 1;
        throw new Error("viewer must not run concurrently");
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

  const accepted = await request("/v1/operations/accept", {
    capability,
    prepared,
    authority,
  });
  assert.equal(accepted.status, 200);
  const frame = await request("/v1/viewer", {
    ticket: viewerTicket("user-1"),
    action: "frame",
    connectionId: "connection-1",
  });

  assert.equal(frame.status, 400);
  assert.deepEqual(await frame.json(), {
    error: {
      code: "BROWSER_VIEWER_FRAME_UNAVAILABLE",
      details: { browserOutcomeKnown: true },
    },
  });
  assert.equal(viewerCalls, 0);
  await worker.close();
});

test("hosted worker lets a valid agent operation wait for one slow frame to settle", async () => {
  const prepared = preparedNavigate();
  const capability = operationCapabilityFor(prepared, "revision-1");
  let frameStartedResolve!: () => void;
  const frameStarted = new Promise<void>((resolve) => {
    frameStartedResolve = resolve;
  });
  let releaseFrameResolve!: () => void;
  const releaseFrame = new Promise<void>((resolve) => {
    releaseFrameResolve = resolve;
  });
  let operationExecutions = 0;
  const worker = startHostedBrowserWorker({
    config: workerConfig(),
    engine: {
      async execute(_input, lifecycle) {
        operationExecutions += 1;
        await lifecycle.acknowledgeDispatch();
        throw new Error("BROWSER_DESTINATION_BLOCKED");
      },
      async adopt() { return 0; },
      async viewer(input) {
        assert.equal(input.action, "frame");
        frameStartedResolve();
        await releaseFrame;
        return {
          version: "desktop_browser_viewer_frame_v1",
          sessionId: "browser-session-1",
          generation: 1,
          sequence: 1,
          capturedAt: new Date().toISOString(),
          mediaType: "image/png",
          dataBase64: "iVBORw0KGgo=",
        };
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
  const frame = request("/v1/viewer", {
    ticket: viewerTicket("user-1"),
    action: "frame",
    connectionId: "connection-1",
  });
  await frameStarted;

  let acceptanceSettled = false;
  const accepted = request("/v1/operations/accept", {
    capability,
    prepared,
    authority,
  });
  void accepted.then(() => {
    acceptanceSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(acceptanceSettled, false);
  assert.equal(operationExecutions, 0);

  releaseFrameResolve();
  assert.equal((await frame).status, 200);
  assert.equal((await accepted).status, 200);
  assert.equal(operationExecutions, 1);
  await worker.close();
});

test("hosted worker rejects an operation capability that expires while waiting for a frame", async () => {
  const prepared = preparedNavigate();
  let frameStartedResolve!: () => void;
  const frameStarted = new Promise<void>((resolve) => {
    frameStartedResolve = resolve;
  });
  let releaseFrameResolve!: () => void;
  const releaseFrame = new Promise<void>((resolve) => {
    releaseFrameResolve = resolve;
  });
  let operationExecutions = 0;
  const worker = startHostedBrowserWorker({
    config: workerConfig(),
    engine: {
      async execute(_input, lifecycle) {
        operationExecutions += 1;
        await lifecycle.acknowledgeDispatch();
        const output = { ok: true };
        await lifecycle.persistCompletedResult(output);
        return output;
      },
      async adopt() { return 0; },
      async viewer(input) {
        assert.equal(input.action, "frame");
        frameStartedResolve();
        await releaseFrame;
        return {
          version: "desktop_browser_viewer_frame_v1",
          sessionId: "browser-session-1",
          generation: 1,
          sequence: 1,
          capturedAt: new Date().toISOString(),
          mediaType: "image/png",
          dataBase64: "iVBORw0KGgo=",
        };
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
  const frame = request("/v1/viewer", {
    ticket: viewerTicket("user-1"),
    action: "frame",
    connectionId: "connection-1",
  });
  await frameStarted;

  const expiresAt = new Date(Date.now() + 250);
  const expiringCapability = issueHostedBrowserOperationCapability({
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
      expiresAt: expiresAt.toISOString(),
    },
  });
  let acceptanceSettled = false;
  const expiredAcceptance = request("/v1/operations/accept", {
    capability: expiringCapability,
    prepared,
    authority,
  });
  void expiredAcceptance.then(() => {
    acceptanceSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(acceptanceSettled, false);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(1, expiresAt.getTime() - Date.now() + 5));
  });
  releaseFrameResolve();
  assert.equal((await frame).status, 200);

  const expired = await expiredAcceptance;
  assert.equal(expired.status, 400);
  assert.deepEqual(await expired.json(), {
    error: {
      code: "BROWSER_ENGINE_FAILURE",
      details: { browserOutcomeKnown: true },
    },
  });
  assert.equal(operationExecutions, 0);

  const freshCapability = operationCapabilityFor(prepared, "revision-1");
  const accepted = await request("/v1/operations/accept", {
    capability: freshCapability,
    prepared,
    authority,
  });
  assert.equal(accepted.status, 200);
  assert.equal(operationExecutions, 1);
  const operationBody = {
    capability: freshCapability,
    operationId: prepared.callId,
  };
  assert.equal((await request("/v1/operations/invoke", operationBody)).status, 200);
  assert.equal((await request("/v1/operations/commit", operationBody)).status, 200);
  await worker.close();
});

test("hosted worker termination rejects delayed and new work while exact cleanup remains available", async () => {
  let frameStartedResolve!: () => void;
  const frameStarted = new Promise<void>((resolve) => {
    frameStartedResolve = resolve;
  });
  let releaseFrameResolve!: () => void;
  const releaseFrame = new Promise<void>((resolve) => {
    releaseFrameResolve = resolve;
  });
  let destroyStartedResolve!: () => void;
  const destroyStarted = new Promise<void>((resolve) => {
    destroyStartedResolve = resolve;
  });
  let releaseDestroyResolve!: () => void;
  const releaseDestroy = new Promise<void>((resolve) => {
    releaseDestroyResolve = resolve;
  });
  let operationExecutions = 0;
  let revisionInstalls = 0;
  const viewerActions: string[] = [];
  const cleaned: string[] = [];
  const worker = startHostedBrowserWorker({
    config: workerConfig(),
    engine: {
      async execute() {
        operationExecutions += 1;
        throw new Error("operation must not be admitted during termination");
      },
      async adopt() {
        revisionInstalls += 1;
        return 0;
      },
      async viewer(input) {
        viewerActions.push(input.action);
        assert.equal(input.action, "frame");
        frameStartedResolve();
        await releaseFrame;
        return {
          version: "desktop_browser_viewer_frame_v1",
          sessionId: "browser-session-1",
          generation: 1,
          sequence: 1,
          capturedAt: new Date().toISOString(),
          mediaType: "image/png",
          dataBase64: "iVBORw0KGgo=",
        };
      },
      async viewerCleanup(claims) {
        cleaned.push(`${claims.purpose}:${claims.connectionId}`);
      },
      async destroy() {
        destroyStartedResolve();
        await releaseDestroy;
      },
    },
  });
  await once(worker.server, "listening");
  const port = (worker.server.address() as AddressInfo).port;
  const request = (path: string, body: unknown) => fetch(
    `http://[::1]:${port}${path}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const ticket = viewerTicket("user-1");
  const delayedFrame = request("/v1/viewer", {
    ticket,
    action: "frame",
    connectionId: "connection-1",
  });
  await frameStarted;
  const prepared = preparedNavigate();
  const delayedAcceptance = request("/v1/operations/accept", {
    capability: operationCapabilityFor(prepared, "revision-1"),
    prepared,
    authority,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(operationExecutions, 0);

  const closing = worker.close();
  await destroyStarted;
  const delayedOperationResponse = await delayedAcceptance;
  assert.equal(delayedOperationResponse.status, 400);
  assert.equal(
    ((await delayedOperationResponse.json()) as { error: { code: string } }).error.code,
    "BROWSER_SESSION_LOST",
  );
  releaseFrameResolve();
  const delayedResponse = await delayedFrame;
  assert.equal(delayedResponse.status, 400);
  assert.equal(
    ((await delayedResponse.json()) as { error: { code: string } }).error.code,
    "BROWSER_SESSION_LOST",
  );

  const nextAuthority = {
    ...authority,
    effectiveAllowlistRevision: "revision-2",
  };
  const rejected = await Promise.all([
    request("/v1/viewer", {
      ticket,
      action: "frame",
      connectionId: "connection-1",
    }),
    request("/v1/viewer", {
      ticket,
      action: "input",
      connectionId: "connection-1",
      leaseId: "lease-1",
      viewerInput: {
        version: "desktop_browser_viewer_input_v1",
        kind: "keyboard",
        phase: "down",
        key: "x",
        text: "x",
      },
    }),
    request("/v1/viewer", {
      ticket,
      action: "connect",
      connectionId: "connection-1",
    }),
    request("/v1/operations/accept", {
      capability: operationCapabilityFor(prepared, "revision-1"),
      prepared,
      authority,
    }),
    request("/v1/operations/revision", {
      sessionId: "browser-session-1",
      generation: 1,
      revision: "revision-2",
      cause: "personal_revocation",
      authority: nextAuthority,
      capability: revisionCapabilityFor("revision-2"),
    }),
  ]);
  for (const response of rejected) {
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "BROWSER_SESSION_LOST",
    );
  }
  assert.deepEqual(viewerActions, ["frame"]);
  assert.equal(operationExecutions, 0);
  assert.equal(revisionInstalls, 0);

  const cleanupConnectionId = "termination-cleanup";
  const cleanup = await request("/v1/viewer-cleanup", {
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    actorId: "user-1",
    threadId: "thread-1",
    sessionId: "browser-session-1",
    generation: 1,
    connectionId: cleanupConnectionId,
    purpose: "disconnect",
    cleanupCapability: viewerCleanupCapability(cleanupConnectionId),
  });
  assert.equal(cleanup.status, 200);
  assert.deepEqual(cleaned, [`disconnect:${cleanupConnectionId}`]);

  releaseDestroyResolve();
  await closing;
});

test("hosted worker cleanup requires a fixed-key capability bound to exact connection and purpose", async () => {
  const cleaned: string[] = [];
  const worker = startHostedBrowserWorker({
    config: workerConfig(),
    engine: {
      async execute() { throw new Error("not called"); },
      async adopt() { return 0; },
      async viewerCleanup(claims) {
        cleaned.push(`${claims.purpose}:${claims.connectionId}`);
      },
      async destroy() {},
    },
  });
  await once(worker.server, "listening");
  const port = (worker.server.address() as AddressInfo).port;
  const request = (body: unknown) => fetch(
    `http://[::1]:${port}/v1/viewer-cleanup`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const exact = viewerCleanupCapability("connection-cleanup-1");
  assert.equal((await request({
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    actorId: "user-1",
    threadId: "thread-1",
    sessionId: "browser-session-1",
    generation: 1,
    connectionId: "connection-cleanup-1",
    purpose: "disconnect",
    cleanupCapability: exact,
  })).status, 200);
  assert.deepEqual(cleaned, ["disconnect:connection-cleanup-1"]);
  assert.equal((await request({
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    actorId: "user-1",
    threadId: "thread-1",
    sessionId: "browser-session-1",
    generation: 1,
    connectionId: "connection-other",
    purpose: "disconnect",
    cleanupCapability: exact,
  })).status, 400);
  assert.equal((await request({
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    actorId: "user-1",
    threadId: "thread-1",
    sessionId: "browser-session-1",
    generation: 1,
    connectionId: "connection-cleanup-1",
    purpose: "disconnect",
    cleanupCapability: "unsigned",
  })).status, 400);
  assert.deepEqual(cleaned, ["disconnect:connection-cleanup-1"]);
  const authorityLoss = viewerCleanupCapability(
    "connection-cleanup-1",
    "authority_loss",
  );
  assert.equal((await request({
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    actorId: "user-1",
    threadId: "thread-1",
    sessionId: "browser-session-1",
    generation: 1,
    connectionId: "connection-cleanup-1",
    purpose: "authority_loss",
    cleanupCapability: authorityLoss,
  })).status, 200);
  assert.deepEqual(cleaned, [
    "disconnect:connection-cleanup-1",
    "authority_loss:connection-cleanup-1",
  ]);
  await worker.close();
});

test("AgentBrowserHostedWorkerEngine fail-closes a retained viewer before accepting a different proposed connection", async (t) => {
  const homePath = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-hosted-viewer-composition-"),
  );
  t.after(async () => {
    await rm(homePath, { recursive: true, force: true });
  });
  const adapter: DesktopBrowserEngineAdapter = {
    async acceptOperation(input) {
      return {
        sessionId: input.sessionId,
        operationId: input.operationId,
        grantGeneration: input.grantGeneration,
        acceptanceToken: `${input.operationId}:${input.grantGeneration}`,
      };
    },
    releaseOperation(_operation: DesktopBrowserAcceptedOperation) {},
    async open() {},
    async command() { throw new Error("not used"); },
    async close() {},
    async captureViewerFrame() {
      return { mediaType: "image/png", dataBase64: "iVBORw0KGgo=" };
    },
  };
  const config = workerConfig();
  const engine = new AgentBrowserHostedWorkerEngine(config, {
    createDesktopBrowserService(options) {
      return new DesktopBrowserService({
        ...options,
        homePath,
        engine: adapter,
        nativeAuthenticationHandoff: false,
      });
    },
  });
  const session = openingHostedSession();
  await engine.execute(
    {
      prepared: preparedOpen(),
      authority,
      session,
      gatewayProxy: hostedGatewayProxy(config),
    },
    {
      async acknowledgeDispatch() {},
      async persistCompletedResult() {},
    },
  );
  const connectionId = "hosted-composed-connection-1";
  const claims = viewerClaims("user-1", connectionId);

  const first = await engine.viewer({
    action: "connect",
    claims,
    connectionId,
  });
  await assert.rejects(engine.viewer({
    action: "connect",
    claims,
    connectionId,
  }), hasBrowserCode("BROWSER_SESSION_LOST"));
  assert.equal(
    (first as { connectionId?: string }).connectionId,
    connectionId,
  );

  await assert.rejects(
    engine.viewer({
      action: "connect",
      claims: viewerClaims("user-1", "cross-ticket-connection"),
      connectionId: "cross-ticket-connection",
    }),
    hasBrowserCode("BROWSER_SESSION_LOST"),
  );
  await assert.rejects(
    engine.viewer({
      action: "connect",
      claims,
      connectionId,
    }),
    hasBrowserCode("BROWSER_SESSION_LOST"),
  );
  await engine.destroy();
});

test("hosted worker lease expiry retries exact cleanup until the worker proves release", async () => {
  let now = new Date("2026-08-30T12:00:00.000Z");
  const timers: Array<{ handler: () => void; delay: number; cleared: boolean }> = [];
  let cleanupCalls = 0;
  const fakeService = {
    async initialize() {},
    async execute() { return null; },
    async connectViewer(input: { connectionId: string }) {
      return {
        version: "desktop_browser_viewer_state_v1" as const,
        available: true,
        threadId: "thread-1",
        projectId: "project-1",
        sessionId: "browser-session-1",
        generation: 1,
        connectionId: input.connectionId,
        sessionState: "ready" as const,
        takeoverRequested: true,
      };
    },
    async acceptViewerTakeover(input: { connectionId: string }) {
      return {
        version: "desktop_browser_viewer_state_v1" as const,
        available: true,
        threadId: "thread-1",
        projectId: "project-1",
        sessionId: "browser-session-1",
        generation: 1,
        connectionId: input.connectionId,
        sessionState: "human_control" as const,
        takeoverRequested: false,
        inputLeaseId: "lease-1",
        inputLeaseExpiresAt: new Date(now.getTime() + 5_000).toISOString(),
        nativeHandoffActive: false,
      };
    },
    async cleanupViewerConnection() {
      cleanupCalls += 1;
      if (cleanupCalls === 1) throw new Error("transient cleanup failure");
    },
    async close() {},
  };
  const fakeSetTimeout = ((handler: () => void, delay?: number) => {
    const record = { handler, delay: delay ?? 0, cleared: false };
    timers.push(record);
    return { unref() {} } as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const fakeClearTimeout = ((_handle: ReturnType<typeof setTimeout>) => {
    const active = [...timers].reverse().find((timer) => !timer.cleared);
    if (active) active.cleared = true;
  }) as typeof clearTimeout;
  const config = workerConfig();
  const engine = new AgentBrowserHostedWorkerEngine(config, {
    now: () => now,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    viewerRetirementLimit: 1,
    createDesktopBrowserService() {
      return fakeService as unknown as DesktopBrowserService;
    },
  });
  await engine.execute(
    {
      prepared: preparedOpen(),
      authority,
      session: openingHostedSession(),
      gatewayProxy: hostedGatewayProxy(config),
    },
    { async acknowledgeDispatch() {}, async persistCompletedResult() {} },
  );
  const claims = viewerClaims("user-1", "expiry-connection", now);
  await engine.viewer({ action: "connect", claims, connectionId: claims.connectionId });
  await assert.rejects(
    engine.viewerCleanup(
      viewerCleanupClaims("unadmitted-cleanup", "disconnect", now),
    ),
    hasBrowserCode("BROWSER_SERVICE_UNAVAILABLE"),
  );
  assert.equal(cleanupCalls, 0);
  await engine.viewer({ action: "accept", claims, connectionId: claims.connectionId });
  const leaseTimer = timers.find((timer) => timer.delay === 5_000);
  assert.ok(leaseTimer);
  leaseTimer.handler();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cleanupCalls, 1);
  await assert.rejects(
    engine.viewer({
      action: "frame",
      claims,
      connectionId: claims.connectionId,
    }),
    hasBrowserCode("BROWSER_VIEWER_AUTHORITY_EXPIRED"),
  );
  await assert.rejects(
    engine.viewer({
      action: "input",
      claims,
      connectionId: claims.connectionId,
      leaseId: "lease-1",
      viewerInput: {
        version: "desktop_browser_viewer_input_v1",
        kind: "keyboard",
        phase: "down",
        key: "x",
        text: "x",
      },
    }),
    hasBrowserCode("BROWSER_VIEWER_AUTHORITY_EXPIRED"),
  );
  await assert.rejects(
    engine.viewer({
      action: "renew",
      claims,
      connectionId: claims.connectionId,
      leaseId: "lease-1",
    }),
    hasBrowserCode("BROWSER_VIEWER_AUTHORITY_EXPIRED"),
  );
  await assert.rejects(
    engine.viewer({
      action: "connect",
      claims,
      connectionId: claims.connectionId,
    }),
    hasBrowserCode("BROWSER_SESSION_LOST"),
  );
  const retry = timers.find((timer) => timer.delay === 1_000 && !timer.cleared);
  assert.ok(retry);
  now = new Date(now.getTime() + 61_000);
  const replacement = viewerClaims("user-1", "capacity-replacement", now);
  await engine.viewer({
    action: "connect",
    claims: replacement,
    connectionId: replacement.connectionId,
  });
  retry.handler();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cleanupCalls, 2);
  await assert.rejects(
    engine.viewer({
      action: "connect",
      claims: replacement,
      connectionId: replacement.connectionId,
    }),
    hasBrowserCode("BROWSER_SESSION_LOST"),
  );
  await engine.destroy();
});

test("hosted worker retires exact viewer identities, protects replacements, and fails closed at the bound", async () => {
  let now = new Date("2026-08-30T12:00:00.000Z");
  const connected: string[] = [];
  const fakeService = {
    async initialize() {},
    async execute() { return null; },
    async connectViewer(input: { connectionId: string }) {
      connected.push(input.connectionId);
      return {
        version: "desktop_browser_viewer_state_v1" as const,
        available: true,
        threadId: "thread-1",
        projectId: "project-1",
        sessionId: "browser-session-1",
        generation: 1,
        connectionId: input.connectionId,
        sessionState: "ready" as const,
        takeoverRequested: true,
      };
    },
    async cleanupViewerConnection() {},
    async close() {},
  };
  const config = workerConfig();
  const engine = new AgentBrowserHostedWorkerEngine(config, {
    now: () => now,
    viewerRetirementLimit: 2,
    createDesktopBrowserService() {
      return fakeService as unknown as DesktopBrowserService;
    },
  });
  const delayed = viewerClaims("user-1", "delayed-connection", now);
  await engine.viewerCleanup(viewerCleanupClaims("delayed-connection", "disconnect", now));
  await engine.execute(
    {
      prepared: preparedOpen(),
      authority,
      session: openingHostedSession(),
      gatewayProxy: hostedGatewayProxy(config),
    },
    { async acknowledgeDispatch() {}, async persistCompletedResult() {} },
  );
  await assert.rejects(
    engine.viewer({ action: "connect", claims: delayed, connectionId: delayed.connectionId }),
    hasBrowserCode("BROWSER_SESSION_LOST"),
  );

  const replacement = viewerClaims("user-1", "replacement-connection", now);
  await engine.viewer({
    action: "connect",
    claims: replacement,
    connectionId: replacement.connectionId,
  });
  await engine.viewer({
    action: "disconnect",
    claims: replacement,
    connectionId: replacement.connectionId,
  });
  await assert.rejects(
    engine.viewer({
      action: "connect",
      claims: replacement,
      connectionId: replacement.connectionId,
    }),
    hasBrowserCode("BROWSER_SESSION_LOST"),
  );
  assert.deepEqual(connected, ["replacement-connection"]);

  const bounded = viewerClaims("user-1", "bounded-connection", now);
  await assert.rejects(
    engine.viewer({ action: "connect", claims: bounded, connectionId: bounded.connectionId }),
    hasBrowserCode("BROWSER_SERVICE_UNAVAILABLE"),
  );

  now = new Date(now.getTime() + 61_000);
  const afterExpiry = viewerClaims("user-1", "after-expiry-connection", now);
  await engine.viewer({
    action: "connect",
    claims: afterExpiry,
    connectionId: afterExpiry.connectionId,
  });
  assert.deepEqual(connected, ["replacement-connection", "after-expiry-connection"]);
  await engine.destroy();
});

test("authority loss bypasses a full exact-retirement map and blocks replacement until signed expiry", async () => {
  let now = new Date("2026-08-30T12:00:00.000Z");
  let authorityLossCalls = 0;
  const fakeService = {
    async initialize() {},
    async execute() { return null; },
    async connectViewer(input: { connectionId: string }) {
      return {
        version: "desktop_browser_viewer_state_v1" as const,
        available: true,
        threadId: "thread-1",
        projectId: "project-1",
        sessionId: "browser-session-1",
        generation: 1,
        connectionId: input.connectionId,
        sessionState: "ready" as const,
        takeoverRequested: true,
      };
    },
    async cleanupViewerConnection() {},
    async loseViewerAuthority() { authorityLossCalls += 1; },
    async close() {},
  };
  const config = workerConfig();
  const engine = new AgentBrowserHostedWorkerEngine(config, {
    now: () => now,
    viewerRetirementLimit: 2,
    createDesktopBrowserService() {
      return fakeService as unknown as DesktopBrowserService;
    },
  });
  await engine.viewerCleanup(viewerCleanupClaims("already-retired", "disconnect", now));
  await engine.execute(
    {
      prepared: preparedOpen(),
      authority,
      session: openingHostedSession(),
      gatewayProxy: hostedGatewayProxy(config),
    },
    { async acknowledgeDispatch() {}, async persistCompletedResult() {} },
  );
  const live = viewerClaims("user-1", "live-at-capacity", now);
  await engine.viewer({ action: "connect", claims: live, connectionId: live.connectionId });

  await engine.viewerCleanup(viewerCleanupClaims("authority-loss", "authority_loss", now));
  assert.equal(authorityLossCalls, 1);
  const replacement = viewerClaims("user-1", "replacement-before-expiry", now);
  await assert.rejects(
    engine.viewer({
      action: "connect",
      claims: replacement,
      connectionId: replacement.connectionId,
    }),
    hasBrowserCode("BROWSER_SESSION_LOST"),
  );
  await assert.rejects(
    engine.viewerCleanup({
      ...viewerCleanupClaims("wrong-principal", "authority_loss", now),
      actorId: "other-user",
    }),
    hasBrowserCode("BROWSER_SESSION_LOST"),
  );
  assert.equal(authorityLossCalls, 1);

  now = new Date(now.getTime() + 61_000);
  const afterExpiry = viewerClaims("user-1", "replacement-after-expiry", now);
  await engine.viewer({
    action: "connect",
    claims: afterExpiry,
    connectionId: afterExpiry.connectionId,
  });
  await engine.destroy();
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

function preparedOpen() {
  const descriptor = defaultToolCatalog.getDescriptorRef("browser.open");
  assert.ok(descriptor);
  const activation = createToolActivationRefV1({
    descriptor,
    registryGeneration: "hosted-worker-composition-test",
    scopeFingerprint: fingerprintToolScopeV1({ hostedBrowserWorker: true }),
  });
  return parsePreparedToolCallV1({
    version: "v1",
    runId: "run-1",
    sessionId: "runtime-session-1",
    callId: "call-open-composition",
    activation,
    origin: {
      kind: "trusted_runtime",
      producerId: "test",
      adapterId: "test",
    },
    effectiveInput: {
      mode: "operator",
      target: { kind: "public_url", url: "https://example.com/" },
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

function openingHostedSession(): BrowserSessionV1 {
  const now = new Date().toISOString();
  return {
    version: "browser_session_v1",
    sessionId: "browser-session-1",
    threadId: "thread-1",
    mode: "operator",
    state: "opening",
    engineRevision: "v0.35.0",
    generation: 1,
    effectiveAllowlistRevision: "revision-1",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    hardExpiresAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
  };
}

function hostedGatewayProxy(config: ReturnType<typeof workerConfig>) {
  const proxyServer = `http://${config.gatewayHost}:${config.gatewayPort}`;
  return {
    version: "hosted_browser_gateway_proxy_binding_v1" as const,
    proxyServer,
    username: "viewer-composition-user",
    password: "viewer-composition-password",
    threadId: config.threadId,
    sessionId: config.sessionId,
    generation: config.generation,
    effectiveAllowlistRevision: config.effectiveAllowlistRevision,
    chromiumFlags: [`--proxy-server=${proxyServer}`],
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

function viewerTicket(
  actorId: string,
  connectionId = "connection-1",
  now = new Date(),
) {
  return issueHostedBrowserViewerTicket({
    privateKeyPem,
    now,
    claims: viewerClaims(actorId, connectionId, now),
  });
}

function viewerCleanupCapability(
  connectionId: string,
  purpose: "disconnect" | "authority_loss" = "disconnect",
) {
  const now = new Date();
  return issueHostedBrowserViewerCleanupCapability({
    privateKeyPem,
    now,
    claims: {
      version: HOSTED_BROWSER_VIEWER_CLEANUP_CAPABILITY_VERSION,
      audience: HOSTED_BROWSER_VIEWER_CLEANUP_AUDIENCE,
      action: "cleanup",
      purpose,
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      threadId: "thread-1",
      sessionId: "browser-session-1",
      generation: 1,
      actorId: "user-1",
      connectionId,
      nonce: `viewer-cleanup-${connectionId}`,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    },
  });
}

function viewerCleanupClaims(
  connectionId: string,
  purpose: "disconnect" | "authority_loss",
  now = new Date(),
) {
  return {
    version: HOSTED_BROWSER_VIEWER_CLEANUP_CAPABILITY_VERSION,
    audience: HOSTED_BROWSER_VIEWER_CLEANUP_AUDIENCE,
    action: "cleanup" as const,
    purpose,
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    threadId: "thread-1",
    sessionId: "browser-session-1",
    generation: 1,
    actorId: "user-1",
    connectionId,
    nonce: `viewer-cleanup-${connectionId}`,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  } as const;
}

function viewerClaims(
  actorId: string,
  connectionId: string,
  now = new Date(),
) {
  return {
    version: HOSTED_BROWSER_VIEWER_TICKET_VERSION,
    audience: HOSTED_BROWSER_VIEWER_AUDIENCE,
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    threadId: "thread-1",
    sessionId: "browser-session-1",
    generation: 1,
    actorId,
    connectionId,
    nonce: `viewer-ticket-${actorId}-${connectionId}`,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  } as const;
}

function hasBrowserCode(code: string) {
  return (error: unknown) =>
    Boolean(
      error &&
        typeof error === "object" &&
        (("code" in error &&
          (error as { code?: unknown }).code === code) ||
          (error instanceof Error && error.message === code)),
    );
}
