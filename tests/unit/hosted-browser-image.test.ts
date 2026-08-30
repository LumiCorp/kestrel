import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  HOSTED_BROWSER_IMAGE_SMOKE_EFFECTIVE_ALLOWLIST_REVISION,
  runHostedBrowserImageSmokeControl,
} from "../../deploy/fly/kestrel-one-browser-worker/image-smoke-client.js";
import { verifyHostedBrowserCapabilitySignature } from "../../src/browser/hostedCapability.js";
import {
  BROWSER_RUNTIME_RELEASE_MANIFEST,
  HOSTED_BROWSER_WORKER_IMAGE_REPOSITORY,
} from "../../src/browser/runtimeReleaseManifest.js";

test("hosted Browser image build is pinned, nonroot, compiled, and runtime-fetch free", async () => {
  const [dockerfile, metadataSource, smoke, imageCatalogSource] =
    await Promise.all([
      readFile("deploy/fly/kestrel-one-browser-worker/Dockerfile", "utf8"),
      readFile(
        "deploy/fly/kestrel-one-browser-worker/image-build.json",
        "utf8",
      ),
      readFile("deploy/fly/kestrel-one-browser-worker/smoke.sh", "utf8"),
      readFile("deploy/fly/image-catalog.json", "utf8"),
    ]);
  const metadata = JSON.parse(metadataSource) as Record<string, unknown>;
  const imageCatalog = JSON.parse(imageCatalogSource) as {
    images: Array<{ role: string }>;
  };
  const hostedRelease = BROWSER_RUNTIME_RELEASE_MANIFEST.targets["linux-x64"];

  assert.equal(metadata.repository, HOSTED_BROWSER_WORKER_IMAGE_REPOSITORY);
  assert.equal(metadata.runtimeTarget, "linux-x64");
  assert.equal(
    metadata.publicationStatus,
    "blocked_pending_signed_runtime_assets",
  );
  assert.equal(
    imageCatalog.images.some((image) => image.role === "hosted-browser-worker"),
    false,
    "unsigned hosted Browser runtime assets must not enter the production publisher",
  );
  assert.match(dockerfile, /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}/mu);
  assert.match(dockerfile, /pnpm run build/u);
  assert.match(
    dockerfile,
    /CMD \["node", "\/app\/dist\/src\/browser\/hostedWorkerMain\.js"\]/u,
  );
  assert.match(dockerfile, /USER 10001:10001/u);
  assert.match(dockerfile, /org\.opencontainers\.image\.source/u);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision/u);
  assert.match(dockerfile, new RegExp(hostedRelease.engine.sha256, "u"));
  assert.match(dockerfile, new RegExp(hostedRelease.chrome.sha256, "u"));
  assert.doesNotMatch(dockerfile, /\bcurl\b|\bwget\b|agent-browser install/u);
  assert.match(smoke, /docker network create --internal/u);
  assert.match(
    smoke,
    /docker run --detach[\s\S]*?--read-only[\s\S]*?--tmpfs \/tmp:rw,noexec,nosuid[\s\S]*?"\$image"\)/u,
  );
  assert.match(smoke, /image-smoke-client\.ts" run/u);
  assert.match(smoke, /image-smoke-client\.ts" revision/u);
  assert.match(
    smoke,
    /--env "KESTREL_BROWSER_EFFECTIVE_ALLOWLIST_REVISION=\$effective_allowlist_revision"/u,
  );
  assert.match(smoke, /docker stop --time 10/u);
  assert.doesNotMatch(
    smoke,
    /import\("\/app\/dist\/src\/browser\/hostedWorkerRuntime\.js"\)/u,
  );
  assert.match(smoke, /agent-browser 0\.35\.0/u);
  assert.match(smoke, /Google Chrome for Testing 152\.0\.7977\.54/u);
});

test("hosted Browser image smoke drives exact open and close control operations", async () => {
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPem = keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const publicKeyPem = keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const requests: Array<{
    method: string;
    pathname: string;
    body: Record<string, unknown> | null;
  }> = [];
  let readySession: Record<string, unknown> | undefined;
  const fetchImpl = (async (request, init) => {
    const url = new URL(String(request));
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    requests.push({ method, pathname: url.pathname, body });
    if (method === "GET") return new Response(null, { status: 404 });
    assert.ok(body);
    const operationId = String(body.operationId ?? "");
    if (url.pathname.endsWith("/accept")) {
      const prepared = body.prepared as {
        callId: string;
        activation: { descriptor: { toolId: string } };
      };
      const authority = body.authority as {
        environmentId: string;
        projectId: string;
        userId: string;
        effectiveAllowlistRevision: string;
      };
      const claims = verifyHostedBrowserCapabilitySignature({
        token: String(body.capability),
        publicKeyPem,
        now: new Date("2026-08-30T12:00:00.000Z"),
      });
      assert.equal(claims.operationId, prepared.callId);
      assert.equal(claims.sessionId, "browser-image-smoke-session");
      assert.equal(claims.generation, 1);
      assert.equal(claims.organizationId, "browser-image-smoke-org");
      assert.equal(claims.environmentId, authority.environmentId);
      assert.equal(claims.projectId, authority.projectId);
      assert.equal(claims.userId, authority.userId);
      assert.equal(
        claims.effectiveAllowlistRevision,
        authority.effectiveAllowlistRevision,
      );
      assert.equal(
        claims.effectiveAllowlistRevision,
        HOSTED_BROWSER_IMAGE_SMOKE_EFFECTIVE_ALLOWLIST_REVISION,
      );
      if (prepared.activation.descriptor.toolId === "browser.open") {
        const openingSession = body.session as Record<string, unknown>;
        readySession = { ...openingSession, state: "ready" };
      }
      return Response.json({ accepted: true, operationId: prepared.callId });
    }
    if (url.pathname.endsWith("/invoke")) {
      if (operationId.endsWith("open")) {
        assert.ok(readySession);
        return Response.json({
          version: "browser_tool_result_v1",
          operation: "browser.open",
          outcome: "opened",
          session: readySession,
        });
      }
      return Response.json({
        version: "browser_tool_result_v1",
        operation: "browser.close",
        sessionId: "browser-image-smoke-session",
        state: "closed",
      });
    }
    if (url.pathname.endsWith("/commit")) {
      return Response.json({ committed: true, operationId });
    }
    return Response.json(
      { error: { code: "unexpected_request" } },
      { status: 500 },
    );
  }) as typeof fetch;

  await runHostedBrowserImageSmokeControl({
    baseUrl: "http://worker.test:43105",
    privateKeyPem,
    fetchImpl,
    now: new Date("2026-08-30T12:00:00.000Z"),
  });

  assert.deepEqual(
    requests.map(({ method, pathname }) => `${method} ${pathname}`),
    [
      "GET /",
      "POST /v1/operations/accept",
      "POST /v1/operations/invoke",
      "POST /v1/operations/commit",
      "POST /v1/operations/accept",
      "POST /v1/operations/invoke",
      "POST /v1/operations/commit",
    ],
  );
  const acceptedTools = requests
    .filter((request) => request.pathname.endsWith("/accept"))
    .map(
      (request) =>
        (
          request.body?.prepared as {
            activation: { descriptor: { toolId: string } };
          }
        ).activation.descriptor.toolId,
    );
  assert.deepEqual(acceptedTools, ["browser.open", "browser.close"]);
});
