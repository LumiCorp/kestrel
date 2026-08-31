import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

import { BROWSER_ARTIFACT_AUTHORIZATION_VERSION } from "../../../../src/browser/contracts.js";
import {
  HostedBrowserArtifactAuthority,
  type HostedBrowserArtifactFilePort,
  type HostedBrowserArtifactFileV1,
} from "./artifact-authority";

const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const pngSha = createHash("sha256").update(png).digest("hex");
const origin = {
  organizationId: "org-1",
  environmentId: "env-1",
  projectId: "project-1",
  threadId: "thread-1",
  runId: "run-1",
  turnId: "turn-1",
  userId: "user-1",
};

test("hosted screenshot upload is single-use and canonicalizes a ready Thread file", async () => {
  const fixture = createFixture();
  const instruction = await fixture.authority.prepareScreenshotUpload({
    origin,
    sessionId: "browser-session-1",
    generation: 2,
    callId: "call-capture-1",
    byteLength: png.byteLength,
    sha256: pngSha,
  });
  assert.match(instruction.artifactId, /^file-browser-[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(instruction), /data:image|iVBOR/u);

  await fixture.authority.upload({
    token: instruction.capability,
    fileId: instruction.artifactId,
    body: stream(png),
    contentLength: png.byteLength,
  });
  await assert.rejects(fixture.authority.upload({
    token: instruction.capability,
    fileId: instruction.artifactId,
    body: stream(png),
    contentLength: png.byteLength,
  }), /already used/u);

  const authorized = await fixture.authority.authorize({
    version: BROWSER_ARTIFACT_AUTHORIZATION_VERSION,
    runId: origin.runId,
    threadId: origin.threadId,
    callId: "call-capture-1",
    toolName: "browser.capture",
    sessionId: "browser-session-1",
    artifactId: instruction.artifactId,
    artifactKind: "browser-screenshot",
    artifactUrl: "https://attacker.invalid/screenshot.png",
    origin,
    generation: 2,
  });
  assert.deepEqual(authorized, {
    version: "browser_authorized_artifact_v1",
    id: instruction.artifactId,
    title: "Browser screenshot",
    kind: "browser-screenshot",
    url: `/api/files/${instruction.artifactId}/content`,
    mediaType: "image/png",
    bytes: png.byteLength,
    sha256: pngSha,
  });
  assert.doesNotMatch(JSON.stringify(authorized), /capability|Bearer|attacker/u);
});

test("hosted screenshot upload rejects expiry, target mismatch, length mismatch, and hash mismatch", async () => {
  const fixture = createFixture();
  const instruction = await fixture.authority.prepareScreenshotUpload({
    origin,
    sessionId: "browser-session-1",
    generation: 1,
    callId: "call-capture-1",
    byteLength: png.byteLength,
    sha256: pngSha,
  });
  await assert.rejects(fixture.authority.upload({
    token: instruction.capability,
    fileId: `${instruction.artifactId}0`,
    body: stream(png),
    contentLength: png.byteLength,
  }), /AUTHORITY_INVALID/u);
  await assert.rejects(fixture.authority.upload({
    token: instruction.capability,
    fileId: instruction.artifactId,
    body: stream(png),
    contentLength: png.byteLength - 1,
  }), /AUTHORITY_INVALID/u);

  const badHash = await fixture.authority.prepareScreenshotUpload({
    origin,
    sessionId: "browser-session-1",
    generation: 1,
    callId: "call-capture-bad-hash",
    byteLength: png.byteLength,
    sha256: "b".repeat(64),
  });
  await assert.rejects(fixture.authority.upload({
    token: badHash.capability,
    fileId: badHash.artifactId,
    body: stream(png),
    contentLength: png.byteLength,
  }), /hash mismatch/u);

  fixture.setNow(new Date("2026-08-30T12:01:01.000Z"));
  await assert.rejects(fixture.authority.upload({
    token: instruction.capability,
    fileId: instruction.artifactId,
    body: stream(png),
    contentLength: png.byteLength,
  }), /expired/u);
});

test("hosted screenshot authority rejects oversize and cross-scope canonicalization", async () => {
  const fixture = createFixture();
  await assert.rejects(fixture.authority.prepareScreenshotUpload({
    origin,
    sessionId: "browser-session-1",
    generation: 1,
    callId: "call-capture-1",
    byteLength: 100 * 1024 * 1024 + 1,
    sha256: pngSha,
  }), /TOO_LARGE/u);
  const instruction = await fixture.authority.prepareScreenshotUpload({
    origin,
    sessionId: "browser-session-1",
    generation: 1,
    callId: "call-capture-1",
    byteLength: png.byteLength,
    sha256: pngSha,
  });
  await fixture.authority.upload({
    token: instruction.capability,
    fileId: instruction.artifactId,
    body: stream(png),
    contentLength: png.byteLength,
  });
  const base = {
    version: BROWSER_ARTIFACT_AUTHORIZATION_VERSION,
    runId: origin.runId,
    threadId: origin.threadId,
    callId: "call-capture-1",
    toolName: "browser.capture" as const,
    sessionId: "browser-session-1",
    artifactId: instruction.artifactId,
    artifactKind: "browser-screenshot" as const,
    origin,
    generation: 1,
  };
  assert.equal(await fixture.authority.authorize({
    ...base,
    origin: { ...origin, organizationId: "org-2" },
  }), undefined);
  assert.equal(await fixture.authority.authorize({
    ...base,
    callId: "call-capture-other",
  }), undefined);
});

test("hosted Browser download promotion returns and authorizes one ordinary Thread artifact", async () => {
  const fixture = createFixture();
  const bytes = Buffer.from("download bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const input = {
    origin,
    operationId: "call-download-1",
    sessionId: "browser-session-1",
    generation: 1,
    pendingDownloadId: "download-1",
    filename: "report.txt",
    declaredMediaType: "text/plain",
    sizeBytes: bytes.byteLength,
    sha256,
  };
  await fixture.authority.stageDownload({ ...input, body: Readable.from(bytes) });
  const artifact = await fixture.authority.commitDownload(input);
  assert.deepEqual(artifact, {
    version: "browser_authorized_artifact_v1",
    id: "file-browser-download-1",
    title: "report.txt",
    kind: "browser-download",
    mediaType: "text/plain",
    bytes: bytes.byteLength,
    sha256,
  });
  const authorization = {
    version: BROWSER_ARTIFACT_AUTHORIZATION_VERSION,
    runId: origin.runId,
    threadId: origin.threadId,
    callId: input.operationId,
    toolName: "browser.download",
    sessionId: input.sessionId,
    artifactId: artifact.id,
    artifactKind: "browser-download",
    origin,
    generation: 1,
  } as const;
  assert.deepEqual(await fixture.authority.authorize(authorization), {
    ...artifact,
    url: `/api/files/${artifact.id}/content`,
  });
  assert.equal(await fixture.authority.authorize({
    ...authorization,
    callId: "call-download-other",
  }), undefined);
});

function createFixture() {
  const files = new Map<string, HostedBrowserArtifactFileV1>();
  let now = new Date("2026-08-30T12:00:00.000Z");
  const port: HostedBrowserArtifactFilePort = {
    async initialize(input) {
      if (files.has(input.fileId)) throw new Error("duplicate");
      const file: HostedBrowserArtifactFileV1 = {
        id: input.fileId,
        organizationId: input.organizationId,
        uploaderUserId: input.userId,
        filename: input.filename,
        declaredMediaType: input.declaredMediaType,
        detectedMediaType: null,
        sizeBytes: input.sizeBytes,
        sha256: null,
        lifecycleState: "draft",
      };
      files.set(file.id, file);
      return file;
    },
    async upload(input) {
      const file = await port.read(input);
      if (file.lifecycleState !== "draft") throw new Error("already used");
      file.lifecycleState = "failed";
      const bytes = await read(input.body);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== input.contentLength) throw new Error("length mismatch");
      if (digest !== input.expectedSha256) throw new Error("hash mismatch");
      file.detectedMediaType = "image/png";
      file.sha256 = digest;
      file.lifecycleState = "ready";
      return file;
    },
    async read(input) {
      const file = files.get(input.fileId);
      if (
        !file ||
        file.organizationId !== input.organizationId ||
        file.uploaderUserId !== input.userId ||
        input.threadId !== origin.threadId
      ) throw new Error("not found");
      return file;
    },
    async stageDownload(input) {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes.byteLength, input.sizeBytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), input.sha256);
    },
    async commitDownload(input) {
      const existing = files.get("file-browser-download-1");
      if (existing) return existing;
      const file: HostedBrowserArtifactFileV1 = {
        id: "file-browser-download-1",
        organizationId: input.organizationId,
        uploaderUserId: input.userId,
        filename: input.filename,
        declaredMediaType: input.declaredMediaType,
        detectedMediaType: input.declaredMediaType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        lifecycleState: "ready",
      };
      files.set(file.id, file);
      return file;
    },
    async readDownloadPromotion(input) {
      if (
        input.operationId !== "call-download-1" ||
        input.fileId !== "file-browser-download-1" ||
        input.sessionId !== "browser-session-1" ||
        input.generation !== 1
      ) return;
      return files.get(input.fileId);
    },
  };
  return {
    authority: new HostedBrowserArtifactAuthority({
      files: port,
      privateKeyPem,
      now: () => now,
    }),
    setNow(value: Date) { now = value; },
  };
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function read(body: ReadableStream<Uint8Array> | null): Promise<Buffer> {
  assert.ok(body);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}
