import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { HostedBrowserUploadWorkerClient } from "./upload-worker-client";

const privateKey = generateKeyPairSync("ed25519").privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

function transferInput(body: Readable) {
  return {
    routerUrl: "https://router.example.test",
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    userId: "user-1",
    threadId: "thread-1",
    runId: "run-1",
    sessionId: "browser-session-1",
    appName: "kestrel-env-test",
    machineId: "machine-1",
    operationId: "call-upload-1",
    capability: "operation-capability",
    sizeBytes: 8,
    sha256: "a".repeat(64),
    body,
  };
}

test("hosted upload transfer preserves typed worker failures and destroys an unfinished source", async () => {
  const source = Readable.from(Buffer.from("12345678"));
  const client = new HostedBrowserUploadWorkerClient({
    environmentPrivateKeyPem: privateKey,
    fetchImpl: (async () => Response.json({
      error: { code: "BROWSER_TARGET_STALE" },
    }, { status: 409 })) as unknown as typeof fetch,
  });
  await assert.rejects(client.transfer(transferInput(source)), /BROWSER_TARGET_STALE/u);
  assert.equal(source.destroyed, true);
});

test("hosted upload transfer destroys its source after a successful or early response", async () => {
  for (const response of [
    Response.json({ staged: true, operationId: "call-upload-1" }),
    Response.json({ error: { code: "BROWSER_SERVICE_UNAVAILABLE" } }, { status: 503 }),
  ]) {
    const source = Readable.from(Buffer.from("12345678"));
    const client = new HostedBrowserUploadWorkerClient({
      environmentPrivateKeyPem: privateKey,
      fetchImpl: (async () => response) as unknown as typeof fetch,
    });
    await client.transfer(transferInput(source)).catch(() => {});
    assert.equal(source.destroyed, true);
  }
});
