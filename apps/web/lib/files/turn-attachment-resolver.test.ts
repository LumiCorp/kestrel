import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  TURN_ATTACHMENT_DEPLOYMENT_CANARY_SHA256,
  TURN_ATTACHMENT_DEPLOYMENT_CANARY_TEXT,
  TURN_ATTACHMENT_DEPLOYMENT_CANARY_TURN_ID,
} from "@kestrel-agents/protocol";
import { resolveTurnAttachmentDeploymentCanary } from "./turn-attachment-deployment-canary";
import { resolveRunnerAttachmentSource } from "./turn-attachment-resolver";
import type { FileStorageProvider } from "./storage-provider";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (relativePath: string) =>
  fs.readFileSync(path.join(webRoot, relativePath), "utf8");

const resolver = read("lib/files/turn-attachment-resolver.ts");
const route = read(
  "app/internal/turn-worker/[turnId]/attachments/resolve/route.ts",
);

test("turn attachment resolver derives scope from the active durable turn", () => {
  assert.match(resolver, /threadTurnQueueState\.activeTurnId/u);
  assert.match(resolver, /schema\.threads\.organizationId/u);
  assert.match(resolver, /threadMessageFiles\.messageId/u);
  assert.match(resolver, /fileScopeGrants\.scopeType, "thread"/u);
  assert.match(resolver, /attachmentIdsFromMessageParts/u);
  assert.match(resolver, /ATTACHMENT_SET_INVALID/u);
  assert.match(resolver, /ATTACHMENT_UNAVAILABLE/u);
  assert.match(resolver, /ensureEffectiveFileAvailability/u);
  assert.match(resolver, /resolveRunnerAttachmentSource\(storage, row\.objectKey, 900\)/u);
  assert.doesNotMatch(resolver, /organizationId: input\./u);
  assert.doesNotMatch(resolver, /fileIds: input\./u);
  assert.doesNotMatch(resolver, /threadId: input\./u);
});

test("runner attachment sources inline bytes when a local signed URL is not trusted HTTPS", async () => {
  const local = await resolveRunnerAttachmentSource({
    signedReadUrl: async () => "http://127.0.0.1:59000/files/blob/original?signature=local",
    readBuffer: async () => Buffer.from("local attachment", "utf8"),
  }, "files/blob/original", 900);
  assert.deepEqual(local, {
    data: Buffer.from("local attachment", "utf8").toString("base64"),
  });

  const hosted = await resolveRunnerAttachmentSource({
    signedReadUrl: async () => "https://files.example.test/blob?signature=hosted",
    readBuffer: async () => {
      throw new Error("hosted source should not be buffered");
    },
  }, "files/blob/original", 900);
  assert.deepEqual(hosted, {
    sourceUrl: "https://files.example.test/blob?signature=hosted",
  });
});

test("turn attachment resolver is a no-store, ticket-bound service boundary", () => {
  assert.match(route, /verifyTurnAttachmentResolutionTicket/u);
  assert.match(route, /ticket\.turnId !== turnId/u);
  assert.match(route, /Cache-Control.*no-store/u);
  assert.match(route, /ATTACHMENT_ACCESS_UNAUTHORIZED/u);
  assert.match(route, /ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE/u);
  assert.match(route, /error\.fileId/u);
  assert.doesNotMatch(route, /request\.json\(/u);
  assert.doesNotMatch(route, /organizationId/u);
  assert.doesNotMatch(route, /sourceUrl.*console/u);
});

test("deployment canary mints one fixed harmless R2-backed attachment", async () => {
  let uploaded = Buffer.alloc(0);
  let signedKey = "";
  const storage: FileStorageProvider = {
    buildOriginalKey: ({ organizationId, blobId }) => `${organizationId}/${blobId}/original`,
    buildDerivativeKey: () => "unused",
    putStream: async ({ body }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      uploaded = Buffer.concat(chunks);
    },
    readBuffer: async () => Buffer.alloc(0),
    readStream: async () => { throw new Error("unused"); },
    delete: async () => {},
    exists: async () => true,
    signedReadUrl: async (key, expiresInSeconds) => {
      signedKey = key;
      assert.equal(expiresInSeconds, 300);
      return "https://r2.example.test/deployment-canary";
    },
  };

  const result = await resolveTurnAttachmentDeploymentCanary({
    storage,
    now: new Date("2026-08-23T20:00:00.000Z"),
  });

  assert.equal(result.turnId, TURN_ATTACHMENT_DEPLOYMENT_CANARY_TURN_ID);
  assert.deepEqual(uploaded, Buffer.from(TURN_ATTACHMENT_DEPLOYMENT_CANARY_TEXT, "utf8"));
  assert.equal(signedKey, "deployment-canary/turn-attachment-v1/original");
  assert.equal(result.attachments[0]?.sha256, TURN_ATTACHMENT_DEPLOYMENT_CANARY_SHA256);
  assert.equal(result.attachments[0]?.sourceUrl, "https://r2.example.test/deployment-canary");
  assert.equal(result.attachments[0]?.sourceUrlExpiresAt, "2026-08-23T20:05:00.000Z");
});
