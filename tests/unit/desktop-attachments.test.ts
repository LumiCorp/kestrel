import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DesktopAttachmentStore,
  DESKTOP_DRAFT_ATTACHMENT_RETENTION_MS,
} from "../../src/localCore/desktopAttachments.js";
import { resolveLocalCorePaths } from "../../src/localCore/home.js";


async function withStore(run: (store: DesktopAttachmentStore, home: string) => Promise<void>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-attachments-"));
  await run(new DesktopAttachmentStore(home), home);
}

test("Desktop attachment store validates, deduplicates, and resolves opaque thread-scoped attachments", async () => {
  await withStore(async (store, home) => {
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("image")]);
    const first = await store.import({ threadId: "thread-1", filename: "/private/example.png", mimeType: "image/png", data: png });
    const duplicate = await store.import({ threadId: "thread-1", filename: "copy.png", mimeType: "image/png", data: png });
    const text = await store.import({ threadId: "thread-1", filename: "main.ts", mimeType: "text/plain", data: Buffer.from("export const ok = true;\n") });

    assert.equal(first.filename, "example.png");
    assert.equal(first.sha256, duplicate.sha256);
    const blobDirectory = path.join(resolveLocalCorePaths(home).stateRootPath, "attachments", "blobs");
    assert.equal((await readdir(blobDirectory)).length, 2);

    const resolved = await store.resolve("thread-1", [first.attachmentId, text.attachmentId]);
    assert.equal(resolved[0]?.path, path.join(blobDirectory, first.sha256));
    assert.equal(resolved[1]?.text, "export const ok = true;\n");
    assert.equal((await store.list("thread-1"))[0]?.lifecycleState, "ready");
    await store.markSubmitted("thread-1", [first.attachmentId, text.attachmentId], "message-1");
    assert.equal((await store.list("thread-1"))[0]?.lifecycleState, "ready");
    assert.deepEqual((await store.list("thread-1"))[0]?.messageIds, ["message-1"]);
    assert.equal(JSON.stringify(await store.list("thread-1")).includes(home), false);
    await assert.rejects(store.resolve("thread-2", [first.attachmentId]), /unavailable for this thread/u);
  });
});

test("Desktop attachment store preserves unknown, malformed, spoofed, and binary content", async () => {
  await withStore(async (store) => {
    const archive = await store.import({ threadId: "thread-1", filename: "archive.zip", data: Buffer.from("PK") });
    const malformed = await store.import({ threadId: "thread-1", filename: "bad.txt", data: Buffer.from([0xff]) });
    const nul = await store.import({ threadId: "thread-1", filename: "nul.txt", data: Buffer.from("a\0b") });
    const spoofed = await store.import({ threadId: "thread-1", filename: "bad.png", mimeType: "image/jpeg", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
    assert.equal(archive.kind, "file");
    assert.equal(malformed.representationStatus, "metadata_only");
    assert.equal(nul.representationStatus, "metadata_only");
    assert.equal(spoofed.detectedMimeType, "image/png");
    await assert.rejects(store.import({ threadId: "thread-1", filename: "hash.txt", data: Buffer.from("hello"), sha256: "0".repeat(64) }), /hash/u);
  });
});

test("Desktop attachment store accepts each bounded image format by content signature", async () => {
  await withStore(async (store) => {
    const images = [
      ["image.png", "image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
      ["image.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xdb])],
      ["image.gif", "image/gif", Buffer.from("GIF89a")],
      ["image.webp", "image/webp", Buffer.from("RIFF0000WEBP")],
    ] as const;
    for (const [filename, mimeType, data] of images) {
      const attachment = await store.import({ threadId: "thread-1", filename, mimeType, data });
      assert.equal(attachment.mimeType, mimeType);
      assert.equal(attachment.kind, "image");
    }
  });
});

test("Desktop attachment store enforces count and duplicate-reference limits", async () => {
  await withStore(async (store) => {
    const ids: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      ids.push((await store.import({ threadId: "thread-1", filename: `${index}.bin`, data: Buffer.from([index]) })).attachmentId);
    }
    await assert.rejects(store.resolve("thread-1", ids), /at most 20/u);
    await assert.rejects(store.resolve("thread-1", [ids[0]!, ids[0]!]), /unique/u);
  });
});

test("Desktop attachment cleanup removes only expired unsubmitted references", async () => {
  await withStore(async (store) => {
    const old = new Date(Date.now() - DESKTOP_DRAFT_ATTACHMENT_RETENTION_MS - 1000);
    const expired = await store.import({ threadId: "thread-1", filename: "expired.txt", data: Buffer.from("expired"), now: old });
    const retained = await store.import({ threadId: "thread-1", filename: "retained.txt", data: Buffer.from("retained"), now: old });
    await store.resolve("thread-1", [retained.attachmentId]);
    await store.markSubmitted("thread-1", [retained.attachmentId], "message-1");

    assert.equal(await store.cleanup(), 1);
    assert.deepEqual((await store.list("thread-1")).map((entry) => entry.attachmentId), [retained.attachmentId]);
    assert.equal(await store.remove("thread-1", expired.attachmentId), false);
    await assert.rejects(store.remove("thread-1", retained.attachmentId), /attached to a message/u);
  });
});
