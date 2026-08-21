import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { RunTurnAttachment } from "../../src/kestrel/contracts/orchestration.js";
import {
  cleanupMaterializedRunTurnAttachments,
  materializeRunTurnAttachments,
} from "../../src/runtime/attachments/materialize.js";

function attachment(
  overrides: Partial<RunTurnAttachment> = {},
): RunTurnAttachment {
  const bytes = Buffer.from("opaque attachment bytes");
  return {
    attachmentId: "attachment-1",
    threadId: "thread-1",
    filename: "archive.bin",
    mimeType: "application/octet-stream",
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    kind: "file",
    representationStatus: "metadata_only",
    metadataOnlyReason: "No automatic interpreter is available.",
    data: bytes.toString("base64"),
    ...overrides,
  };
}

test("materializes opaque originals in a read-only per-run root", async () => {
  const resolved = await materializeRunTurnAttachments([
    attachment({ filename: "../../archive.bin" }),
  ]);
  const materialized = resolved?.[0];
  assert.ok(materialized?.path);
  assert.equal(path.basename(materialized.path).includes(".."), false);
  assert.equal(materialized.sourceUrl, undefined);
  assert.equal(materialized.data, undefined);
  assert.equal((await stat(materialized.path)).mode & 0o777, 0o400);
  assert.equal((await stat(path.dirname(materialized.path))).mode & 0o777, 0o500);

  const filePath = materialized.path;
  await cleanupMaterializedRunTurnAttachments(resolved);
  await assert.rejects(access(filePath));
});

test("rejects corrupt originals before exposing them to the runner", async () => {
  await assert.rejects(
    materializeRunTurnAttachments([attachment({ sha256: "0".repeat(64) })]),
    /hash failed integrity validation/u,
  );
  await assert.rejects(
    materializeRunTurnAttachments([attachment({ sizeBytes: 1 })]),
    /size failed integrity validation/u,
  );
});

test("runner boundary repeats attachment count, uniqueness, and total limits", async () => {
  await assert.rejects(
    materializeRunTurnAttachments(Array.from({ length: 21 }, (_, index) =>
      attachment({ attachmentId: `attachment-${index}`, sizeBytes: 0, data: "", sha256: createHash("sha256").digest("hex") })
    )),
    /at most 20/u,
  );
  await assert.rejects(
    materializeRunTurnAttachments([attachment(), attachment()]),
    /unique/u,
  );
  await assert.rejects(
    materializeRunTurnAttachments(Array.from({ length: 6 }, (_, index) =>
      attachment({ attachmentId: `large-${index}`, sizeBytes: index === 5 ? 1 : 100 * 1024 * 1024 })
    )),
    /total at most 500 MiB/u,
  );
});

test("invalid UTF-8 degrades to metadata-only while preserving the original", async () => {
  const bytes = Buffer.from([0xff, 0xfe]);
  const resolved = await materializeRunTurnAttachments([
    attachment({
      filename: "malformed.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      kind: "text",
      representationStatus: "extracted_text",
      metadataOnlyReason: undefined,
      data: bytes.toString("base64"),
    }),
  ]);
  assert.equal(resolved?.[0]?.kind, "file");
  assert.equal(resolved?.[0]?.representationStatus, "metadata_only");
  assert.match(resolved?.[0]?.metadataOnlyReason ?? "", /staged read-only/u);
  await cleanupMaterializedRunTurnAttachments(resolved);
});

test("malformed image content degrades to metadata-only while preserving the original", async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const resolved = await materializeRunTurnAttachments([
    attachment({
      filename: "malformed.png",
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      kind: "image",
      representationStatus: "native_image",
      data: bytes.toString("base64"),
    }),
  ]);
  assert.equal(resolved?.[0]?.kind, "file");
  assert.equal(resolved?.[0]?.representationStatus, "metadata_only");
  assert.match(resolved?.[0]?.metadataOnlyReason ?? "", /could not be decoded safely/u);
  await cleanupMaterializedRunTurnAttachments(resolved);
});

test("remote materialization rejects private and loopback destinations", async () => {
  await assert.rejects(materializeRunTurnAttachments([
    attachment({ data: undefined, sourceUrl: "https://127.0.0.1/attachment" }),
  ]), /non-public address/u);
});
