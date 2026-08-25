import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { resolveHostedTurnAttachments } from "./attachment-resolver-client";

const privateKey = generateKeyPairSync("ed25519").privateKey.export({
  format: "pem",
  type: "pkcs8",
}).toString();

const expectedPart = {
  type: "data-kestrel-file",
  data: {
    fileId: "file-local-inline",
    filename: "local.md",
    mediaType: "text/markdown",
    sizeBytes: 5,
  },
};

function responseFetch(body: unknown): typeof fetch {
  return Object.assign(
    async () => Response.json(body),
    { preconnect() {} },
  );
}

test("hosted attachment resolution accepts the protocol inline-data transport", async () => {
  const attachments = await resolveHostedTurnAttachments({
    turnId: "turn-local-inline",
    parts: [expectedPart],
    appUrl: "http://127.0.0.1:43103",
    privateKey,
    fetchImpl: responseFetch({
      attachments: [{
        fileId: "file-local-inline",
        attachmentId: "file-local-inline",
        filename: "local.md",
        mimeType: "text/markdown",
        sizeBytes: 5,
        sha256: "a".repeat(64),
        kind: "text",
        representationStatus: "extracted_text",
        data: Buffer.from("local").toString("base64"),
      }],
    }),
  });

  assert.equal(attachments[0]?.data, Buffer.from("local").toString("base64"));
  assert.equal(attachments[0]?.sourceUrl, undefined);
});

test("hosted attachment resolution rejects missing and ambiguous transports", async () => {
  for (const transport of [
    {},
    {
      data: Buffer.from("local").toString("base64"),
      sourceUrl: "https://files.example.test/local.md",
      sourceUrlExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  ]) {
    await assert.rejects(
      resolveHostedTurnAttachments({
        turnId: "turn-local-inline",
        parts: [expectedPart],
        appUrl: "http://127.0.0.1:43103",
        privateKey,
        fetchImpl: responseFetch({
          attachments: [{
            fileId: "file-local-inline",
            attachmentId: "file-local-inline",
            filename: "local.md",
            mimeType: "text/markdown",
            sizeBytes: 5,
            sha256: "a".repeat(64),
            kind: "text",
            representationStatus: "extracted_text",
            ...transport,
          }],
        }),
      }),
      { name: "HostedAttachmentResolutionError" },
    );
  }
});
