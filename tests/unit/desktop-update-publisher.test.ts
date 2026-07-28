import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  publishDesktopUpdate,
  type DesktopUpdateObjectHead,
  type DesktopUpdateObjectStore,
} from "../../scripts/desktop-update-publisher.js";

class FakeStore implements DesktopUpdateObjectStore {
  readonly objects = new Map<string, DesktopUpdateObjectHead>();
  readonly puts: Array<{
    key: string;
    cacheControl: string;
    condition: { ifNoneMatch: "*" } | { ifMatch: string };
  }> = [];

  async head(key: string): Promise<DesktopUpdateObjectHead | undefined> {
    return this.objects.get(key);
  }

  async put(input: {
    key: string;
    body:
      | { kind: "file"; path: string; size: number }
      | { kind: "text"; value: string };
    cacheControl: string;
    sha256: string;
    condition: { ifNoneMatch: "*" } | { ifMatch: string };
  }): Promise<void> {
    const size = input.body.kind === "file"
      ? input.body.size
      : Buffer.byteLength(input.body.value);
    this.puts.push({
      key: input.key,
      cacheControl: input.cacheControl,
      condition: input.condition,
    });
    this.objects.set(input.key, {
      etag: `"etag-${this.puts.length}"`,
      sha256: input.sha256,
      size,
    });
  }
}

test("publisher uploads manifest artifacts and promotes channel metadata last", async () => {
  const outDir = fixture();
  const store = new FakeStore();
  const result = await publishDesktopUpdate({
    outDir,
    version: "0.7.0",
    channel: "stable",
    store,
  });
  assert.equal(store.puts.at(-1)?.key, "desktop/stable/arm64/latest-mac.yml");
  assert.deepEqual(
    result.uploaded.map((key) => path.posix.basename(key)).sort(),
    [
      "Kestrel-0.7.0-mac-arm64.dmg",
      "Kestrel-0.7.0-mac-arm64.dmg.blockmap",
      "Kestrel-0.7.0-mac-arm64.zip",
      "Kestrel-0.7.0-mac-arm64.zip.blockmap",
      "SHA256SUMS.txt",
    ].sort(),
  );
  assert.equal(store.puts[0]?.cacheControl, "public, max-age=31536000, immutable");
  assert.deepEqual(store.puts[0]?.condition, { ifNoneMatch: "*" });
  assert.equal(store.puts.at(-1)?.cacheControl, "no-cache, no-store, max-age=0");
  assert.deepEqual(store.puts.at(-1)?.condition, { ifNoneMatch: "*" });
});

test("publisher retries identical immutable objects and refuses mismatches", async () => {
  const outDir = fixture();
  const store = new FakeStore();
  await publishDesktopUpdate({
    outDir,
    version: "0.7.0",
    channel: "candidate",
    store,
  });
  const retry = await publishDesktopUpdate({
    outDir,
    version: "0.7.0",
    channel: "candidate",
    store,
  });
  assert.equal(retry.skipped.length, 5);
  assert.deepEqual(store.puts.at(-1)?.condition, { ifMatch: '"etag-6"' });

  store.objects.set(
    "desktop/releases/0.7.0/arm64/Kestrel-0.7.0-mac-arm64.zip",
    { sha256: "wrong", size: 3 },
  );
  await assert.rejects(
    publishDesktopUpdate({
      outDir,
      version: "0.7.0",
      channel: "candidate",
      store,
    }),
    /Immutable Desktop artifact mismatch/u,
  );
});

test("publisher requires manifest files, a ZIP, and an independent DMG", async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "desktop-publish-missing-"));
  writeFileSync(
    path.join(outDir, "latest-mac.yml"),
    "version: 0.7.0\nfiles:\n  - url: Kestrel-0.7.0-mac-arm64.zip\n",
  );
  writeFileSync(path.join(outDir, "Kestrel-0.7.0-mac-arm64.zip"), "zip");
  await assert.rejects(
    publishDesktopUpdate({
      outDir,
      version: "0.7.0",
      channel: "stable",
      store: new FakeStore(),
    }),
    /manual-install DMG is missing/u,
  );
});

function fixture(): string {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "desktop-publish-"));
  writeFileSync(
    path.join(outDir, "latest-mac.yml"),
    [
      "version: 0.7.0",
      "files:",
      "  - url: Kestrel-0.7.0-mac-arm64.zip",
      "    sha512: test",
      "    size: 3",
      "path: Kestrel-0.7.0-mac-arm64.zip",
      "sha512: test",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(outDir, "Kestrel-0.7.0-mac-arm64.zip"), "zip");
  writeFileSync(path.join(outDir, "Kestrel-0.7.0-mac-arm64.dmg"), "dmg");
  writeFileSync(path.join(outDir, "Kestrel-0.7.0-mac-arm64.zip.blockmap"), "zip-blockmap");
  writeFileSync(path.join(outDir, "Kestrel-0.7.0-mac-arm64.dmg.blockmap"), "dmg-blockmap");
  return outDir;
}
