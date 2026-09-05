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
  const [
    dockerfile,
    entrypoint,
    metadataSource,
    smoke,
    imageCatalogSource,
    packageSource,
    stagingReadme,
  ] = await Promise.all([
    readFile("deploy/fly/kestrel-one-browser-worker/Dockerfile", "utf8"),
    readFile("deploy/fly/kestrel-one-browser-worker/entrypoint.sh", "utf8"),
    readFile("deploy/fly/kestrel-one-browser-worker/image-build.json", "utf8"),
    readFile("deploy/fly/kestrel-one-browser-worker/smoke.sh", "utf8"),
    readFile("deploy/fly/image-catalog.json", "utf8"),
    readFile("package.json", "utf8"),
    readFile(
      "deploy/fly/kestrel-one-browser-worker/runtime/linux-x64/README.md",
      "utf8",
    ),
  ]);
  const metadata = JSON.parse(metadataSource) as Record<string, unknown>;
  const imageCatalog = JSON.parse(imageCatalogSource) as {
    images: Array<{
      role: string;
      repository: string;
      dockerfile: string;
      prepare: string;
      smoke: string;
      rollout: string;
    }>;
  };
  const hostedRelease = BROWSER_RUNTIME_RELEASE_MANIFEST.targets["linux-x64"];

  assert.equal(metadata.repository, HOSTED_BROWSER_WORKER_IMAGE_REPOSITORY);
  assert.equal(metadata.runtimeTarget, "linux-x64");
  assert.equal(
    metadata.runtimeStagingCommand,
    "pnpm run browser:runtime:stage:hosted",
  );
  assert.equal("publicationStatus" in metadata, false);
  assert.match(packageSource, /"browser:runtime:stage:hosted"/u);
  assert.match(stagingReadme, /repository-owned patched agent-browser/u);
  assert.match(stagingReadme, /exact Chrome-for-Testing HTTPS asset/u);
  assert.doesNotMatch(
    `${metadataSource}\n${stagingReadme}`,
    /blocked_pending_signed_runtime_assets|trusted hosted Browser release key|signature receipt format/u,
  );
  assert.deepEqual(
    imageCatalog.images.find((image) => image.role === "browser-worker"),
    {
      role: "browser-worker",
      publisher: "fly",
      repository: HOSTED_BROWSER_WORKER_IMAGE_REPOSITORY,
      app: "kestrel-one-browser-worker",
      dockerfile: "deploy/fly/kestrel-one-browser-worker/Dockerfile",
      prepare: "browser:runtime:stage:hosted",
      smoke: "deploy/fly/kestrel-one-browser-worker/smoke.sh",
      rollout: "session",
    },
  );
  assert.match(dockerfile, /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}/mu);
  assert.match(dockerfile, /ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1/u);
  assert.match(dockerfile, /pnpm run build/u);
  assert.match(
    dockerfile,
    /ENTRYPOINT \["\/usr\/local\/bin\/kestrel-browser-worker-entrypoint"\]/u,
  );
  assert.doesNotMatch(dockerfile, /^USER /mu);
  assert.match(entrypoint, /policy drop/u);
  assert.match(entrypoint, /chain input/u);
  assert.match(entrypoint, /ct state established accept/u);
  assert.match(entrypoint, /ip saddr %s tcp dport 43105 ct state new accept/u);
  assert.match(entrypoint, /KESTREL_BROWSER_CONTROL_GATEWAY_HOST/u);
  assert.match(entrypoint, /udp dport 53 drop/u);
  assert.match(entrypoint, /tcp dport 53 drop/u);
  assert.match(entrypoint, /tcp dport %s accept/u);
  assert.match(entrypoint, /KESTREL_BROWSER_EGRESS_GATEWAY_ADDRESS/u);
  assert.match(entrypoint, /--reuid=10001/u);
  assert.match(entrypoint, /--regid=10001/u);
  assert.match(entrypoint, /--bounding-set=-all/u);
  assert.match(entrypoint, /--no-new-privs/u);
  assert.match(dockerfile, /org\.opencontainers\.image\.source/u);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision/u);
  assert.match(dockerfile, new RegExp(hostedRelease.engine.sha256, "u"));
  assert.match(dockerfile, new RegExp(hostedRelease.chrome.sha256, "u"));
  assert.doesNotMatch(dockerfile, /\bcurl\b|\bwget\b|agent-browser install/u);
  assert.match(smoke, /docker network create "\$network_name"/u);
  const workerRun = smoke.slice(
    smoke.indexOf('worker_container="$(docker run --detach'),
    smoke.indexOf("# A credential-free TCP relay"),
  );
  assert.doesNotMatch(workerRun, /--publish/u);
  assert.match(workerRun, /--cap-add NET_ADMIN/u);
  assert.match(workerRun, /KESTREL_BROWSER_EGRESS_GATEWAY_PORT=43109/u);
  assert.match(
    workerRun,
    /KESTREL_BROWSER_CONTROL_GATEWAY_HOST=gateway-machine-1\.vm\.browser-workers\.internal/u,
  );
  assert.match(smoke, /Gateway control relay/u);
  assert.match(smoke, /unauthorized private peer connected to worker port/u);
  assert.match(smoke, /await mustNotReach\(43105\)/u);
  assert.match(smoke, /await mustNotReach\(43107\)/u);
  assert.match(smoke, /steady-state Browser worker DNS unexpectedly succeeded/u);
  assert.match(
    smoke,
    /KESTREL_BROWSER_SMOKE_GATEWAY_ADDRESS, 43110/u,
  );
  assert.match(smoke, /direct connection unexpectedly reached/u);
  assert.match(smoke, /gateway did not challenge missing credentials/u);
  assert.match(smoke, /response\.writeHead\(407/u);
  assert.match(smoke, /proxy-authenticate/u);
  assert.match(smoke, /Gateway loss stays closed/u);
  assert.match(smoke, /--platform linux\/amd64/u);
  assert.match(smoke, /chrome="\$\{chrome%/u);
  assert.match(
    smoke,
    /docker run --detach[\s\S]*?--read-only[\s\S]*?--tmpfs \/tmp:rw,noexec,nosuid[\s\S]*?"\$image"\)/u,
  );
  assert.match(smoke, /image-smoke-client\.ts" run/u);
  assert.match(smoke, /close retained its owned runtime\/profile/u);
  assert.match(smoke, /close retained its owned daemon/u);
  assert.match(smoke, /!match\[1\]\.startsWith\("Z"\)/u);
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

test("hosted Browser image smoke reads the authenticated page before closing", async () => {
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
  let snapshotContent = '- StaticText "ready"';
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
      assert.equal(claims.sessionId, `browser-${"a".repeat(64)}`);
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
      if (operationId.endsWith("snapshot")) {
        return Response.json({ sessionId: readySession?.sessionId, content: snapshotContent });
      }
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
        sessionId: `browser-${"a".repeat(64)}`,
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
  assert.deepEqual(acceptedTools, ["browser.open", "browser.snapshot", "browser.close"]);
  const snapshotRequest = requests.find((request) =>
    (request.body?.prepared as { callId?: string } | undefined)?.callId === "browser-image-smoke-snapshot"
  );
  assert.equal((snapshotRequest?.body?.prepared as { effectiveInput: { cursor: unknown } }).effectiveInput.cursor, null);
  snapshotContent = '- StaticText "BROWSER_DESTINATION_BLOCKED"';
  await assert.rejects(runHostedBrowserImageSmokeControl({
    baseUrl: "http://worker.test:43105", privateKeyPem, fetchImpl,
    now: new Date("2026-08-30T12:00:00.000Z"),
  }), /did not read the authenticated fixture page/u);
});
