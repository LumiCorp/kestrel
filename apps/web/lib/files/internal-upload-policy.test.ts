import assert from "node:assert/strict";
import test from "node:test";

import {
  isReservedHostedBrowserFileId,
  matchesExpectedUploadMediaType,
} from "./internal-upload-policy";

test("hosted Browser file identities require the reserved exact shape", () => {
  assert.equal(
    isReservedHostedBrowserFileId(`file-browser-${"a".repeat(64)}`),
    true,
  );
  assert.equal(isReservedHostedBrowserFileId("file-browser-not-a-digest"), false);
  assert.equal(isReservedHostedBrowserFileId(`file-${"a".repeat(64)}`), false);
});

test("hosted Browser PNG verification requires the exact PNG signature", () => {
  assert.equal(matchesExpectedUploadMediaType(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    "image/png",
  ), true);
  assert.equal(matchesExpectedUploadMediaType(
    new TextEncoder().encode("not a png despite its declared media type"),
    "image/png",
  ), false);
  assert.equal(matchesExpectedUploadMediaType(
    new Uint8Array([0x89, 0x50, 0x4e]),
    "image/png",
  ), false);
});
