import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  assert.match(resolver, /storage\.signedReadUrl\(row\.objectKey, 900\)/u);
  assert.doesNotMatch(resolver, /organizationId: input\./u);
  assert.doesNotMatch(resolver, /fileIds: input\./u);
  assert.doesNotMatch(resolver, /threadId: input\./u);
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
