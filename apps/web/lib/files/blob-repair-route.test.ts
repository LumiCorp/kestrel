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

const route = read(
  "app/api/organization/files/blobs/[blobId]/repair/route.ts",
);
const availability = read("lib/files/availability.ts");

test("blob repair requires organization-admin authority and exact blob scope", () => {
  assert.match(route, /requireOrganizationAdmin\(\)/u);
  assert.match(route, /paramsSchema\.parse\(await context\.params\)/u);
  assert.match(route, /blobId,/u);
  assert.match(route, /organizationId,/u);
  assert.match(route, /actorUserId: session\.user\.id/u);
  assert.match(route, /verifyRestoredFileBlob/u);
  assert.doesNotMatch(route, /requireActiveOrganization/u);
});

test("blob repair returns only stable redacted failure results", () => {
  assert.match(route, /ATTACHMENT_BLOB_REPAIR_INTEGRITY_FAILED/u);
  assert.match(route, /ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE/u);
  assert.match(route, /ATTACHMENT_BLOB_NOT_FOUND/u);
  assert.match(route, /Unable to verify the restored file blob\./u);
  assert.match(route, /cache-control.*no-store/u);
  assert.doesNotMatch(route, /objectKey/u);
  assert.doesNotMatch(route, /error\.message.*NextResponse/u);
});

test("blob repair preserves verifier-owned integrity, state, and audit boundaries", () => {
  assert.match(availability, /storage\.readBuffer\(blob\.objectKey\)/u);
  assert.match(availability, /bytes\.byteLength !== blob\.sizeBytes/u);
  assert.match(availability, /createHash\("sha256"\)/u);
  assert.match(availability, /availabilityStatus: "available"/u);
  assert.match(availability, /action: "restore_verified"/u);
  assert.match(availability, /category: "file_blobs"/u);
  assert.doesNotMatch(route, /update\(schema\.fileBlobs\)/u);
  assert.doesNotMatch(route, /scanStatus|lifecycleState|grant/u);
});
