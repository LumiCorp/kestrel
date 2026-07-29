import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseDesktopUpdatePromotionVersion,
  promoteDesktopUpdateRelease,
  type DesktopUpdateObjectHead,
  type DesktopUpdateObjectStore,
  uploadDesktopUpdateRelease,
} from "../../scripts/desktop-update-publisher.js";

class FakeStore implements DesktopUpdateObjectStore {
  readonly objects = new Map<string, DesktopUpdateObjectHead>();
  readonly textObjects = new Map<string, string>();
  readonly puts: Array<{
    key: string;
    cacheControl: string;
    condition: { ifNoneMatch: "*" } | { ifMatch: string };
  }> = [];

  async head(key: string): Promise<DesktopUpdateObjectHead | undefined> {
    return this.objects.get(key);
  }

  async getText(key: string): Promise<string | undefined> {
    return this.textObjects.get(key);
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
    if (input.body.kind === "text") {
      this.textObjects.set(input.key, input.body.value);
    }
  }
}

test("upload publishes only immutable release objects and metadata", async () => {
  const outDir = fixture();
  const store = new FakeStore();
  const result = await uploadDesktopUpdateRelease({
    outDir,
    version: "0.7.0",
    store,
  });
  assert.equal(
    store.puts.at(-1)?.key,
    "desktop/releases/0.7.0/arm64/latest-mac.yml",
  );
  assert.equal(
    store.puts.some(({ key }) => key.includes("/stable/")),
    false,
  );
  assert.deepEqual(
    result.uploaded.map((key) => path.posix.basename(key)).sort(),
    [
      "Kestrel-0.7.0-mac-arm64.dmg",
      "Kestrel-0.7.0-mac-arm64.dmg.blockmap",
      "Kestrel-0.7.0-mac-arm64.zip",
      "Kestrel-0.7.0-mac-arm64.zip.blockmap",
      "SHA256SUMS.txt",
      "latest-mac.yml",
    ].sort(),
  );
  assert.equal(store.puts[0]?.cacheControl, "public, max-age=31536000, immutable");
  assert.deepEqual(store.puts[0]?.condition, { ifNoneMatch: "*" });
  assert.equal(
    store.puts.at(-1)?.cacheControl,
    "public, max-age=31536000, immutable",
  );
  assert.deepEqual(store.puts.at(-1)?.condition, { ifNoneMatch: "*" });
  assert.match(
    store.textObjects.get(result.releaseMetadataKey) ?? "",
    /https:\/\/updates\.lumicorp\.ai\/desktop\/releases\/0\.7\.0\/arm64\/Kestrel-0\.7\.0-mac-arm64\.zip/u,
  );
});

test("upload retries identical immutable objects and refuses mismatches", async () => {
  const outDir = fixture();
  const store = new FakeStore();
  await uploadDesktopUpdateRelease({
    outDir,
    version: "0.7.0",
    store,
  });
  const retry = await uploadDesktopUpdateRelease({
    outDir,
    version: "0.7.0",
    store,
  });
  assert.equal(retry.skipped.length, 6);

  store.objects.set(
    "desktop/releases/0.7.0/arm64/Kestrel-0.7.0-mac-arm64.zip",
    { sha256: "wrong", size: 3 },
  );
  await assert.rejects(
    uploadDesktopUpdateRelease({
      outDir,
      version: "0.7.0",
      store,
    }),
    /Immutable Desktop artifact mismatch/u,
  );
});

test("promotion verifies the staged release before conditionally moving the channel", async () => {
  const outDir = fixture();
  const store = new FakeStore();
  await uploadDesktopUpdateRelease({
    outDir,
    version: "0.7.0",
    store,
  });
  const putCountBeforePromotion = store.puts.length;
  const promoted = await promoteDesktopUpdateRelease({
    version: "0.7.0",
    channel: "stable",
    store,
  });
  assert.equal(promoted.alreadyCurrent, false);
  assert.equal(
    store.puts.at(-1)?.key,
    "desktop/stable/arm64/latest-mac.yml",
  );
  assert.equal(
    store.puts.at(-1)?.cacheControl,
    "no-cache, no-store, max-age=0",
  );
  assert.deepEqual(store.puts.at(-1)?.condition, { ifNoneMatch: "*" });
  assert.equal(store.puts.length, putCountBeforePromotion + 1);

  const retry = await promoteDesktopUpdateRelease({
    version: "0.7.0",
    channel: "stable",
    store,
  });
  assert.equal(retry.alreadyCurrent, true);
  assert.equal(store.puts.length, putCountBeforePromotion + 1);
});

test("promotion refuses incomplete or mutated staged artifacts", async () => {
  const outDir = fixture();
  const store = new FakeStore();
  await uploadDesktopUpdateRelease({
    outDir,
    version: "0.7.0",
    store,
  });
  store.objects.set(
    "desktop/releases/0.7.0/arm64/Kestrel-0.7.0-mac-arm64.zip",
    { sha256: "wrong", size: 3 },
  );
  await assert.rejects(
    promoteDesktopUpdateRelease({
      version: "0.7.0",
      channel: "stable",
      store,
    }),
    /Unable to verify staged Desktop artifact/u,
  );
  assert.equal(
    store.puts.some(({ key }) => key === "desktop/stable/arm64/latest-mac.yml"),
    false,
  );
});

test("promotion conditionally replaces existing channel metadata by ETag", async () => {
  const outDir = fixture();
  const store = new FakeStore();
  await uploadDesktopUpdateRelease({
    outDir,
    version: "0.7.0",
    store,
  });
  store.objects.set("desktop/stable/arm64/latest-mac.yml", {
    etag: '"previous-etag"',
    sha256: "previous",
    size: 10,
  });
  store.textObjects.set(
    "desktop/stable/arm64/latest-mac.yml",
    "version: 0.6.0\n",
  );
  const result = await promoteDesktopUpdateRelease({
    version: "0.7.0",
    channel: "stable",
    store,
  });
  assert.equal(result.previousMetadataEtag, '"previous-etag"');
  assert.deepEqual(store.puts.at(-1)?.condition, {
    ifMatch: '"previous-etag"',
  });
});

test("upload requires manifest files, a ZIP, and an independent DMG", async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "desktop-publish-missing-"));
  writeFileSync(
    path.join(outDir, "latest-mac.yml"),
    [
      "version: 0.7.0",
      "files:",
      "  - url: Kestrel-0.7.0-mac-arm64.zip",
      `    sha512: ${sha512("zip")}`,
      "    size: 3",
      "path: Kestrel-0.7.0-mac-arm64.zip",
      `sha512: ${sha512("zip")}`,
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(outDir, "Kestrel-0.7.0-mac-arm64.zip"), "zip");
  await assert.rejects(
    uploadDesktopUpdateRelease({
      outDir,
      version: "0.7.0",
      store: new FakeStore(),
    }),
    /manual-install DMG is missing/u,
  );
});

test("upload rejects manifest integrity mismatches before writing objects", async (t) => {
  for (const scenario of [
    {
      name: "SHA-512 mismatch",
      fixtureOptions: { fileSha512: sha512("other") },
      error: /SHA-512 does not match/u,
    },
    {
      name: "size mismatch",
      fixtureOptions: { fileSize: 4 },
      error: /size does not match/u,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const store = new FakeStore();
      await assert.rejects(
        uploadDesktopUpdateRelease({
          outDir: fixture(scenario.fixtureOptions),
          version: "0.7.0",
          store,
        }),
        scenario.error,
      );
      assert.equal(store.puts.length, 0);
    });
  }
});

test("upload requires valid manifest integrity fields", async (t) => {
  for (const scenario of [
    {
      name: "missing file SHA-512",
      fixtureOptions: { omitFileSha512: true },
      error: /requires a SHA-512 digest/u,
    },
    {
      name: "malformed file SHA-512",
      fixtureOptions: { fileSha512: "test" },
      error: /invalid SHA-512 digest/u,
    },
    {
      name: "missing file size",
      fixtureOptions: { omitFileSize: true },
      error: /size must be a positive integer/u,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const store = new FakeStore();
      await assert.rejects(
        uploadDesktopUpdateRelease({
          outDir: fixture(scenario.fixtureOptions),
          version: "0.7.0",
          store,
        }),
        scenario.error,
      );
      assert.equal(store.puts.length, 0);
    });
  }
});

test("upload requires legacy metadata to agree with its files entry", async (t) => {
  for (const scenario of [
    {
      name: "legacy path is not a files entry",
      fixtureOptions: { legacyPath: "other.zip" },
      error: /legacy path must identify a files entry/u,
    },
    {
      name: "legacy SHA-512 differs",
      fixtureOptions: { legacySha512: sha512("other") },
      error: /legacy SHA-512 does not match/u,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const store = new FakeStore();
      await assert.rejects(
        uploadDesktopUpdateRelease({
          outDir: fixture(scenario.fixtureOptions),
          version: "0.7.0",
          store,
        }),
        scenario.error,
      );
      assert.equal(store.puts.length, 0);
    });
  }
});

test("promotion requires an explicit semantic version argument", () => {
  assert.equal(
    parseDesktopUpdatePromotionVersion(["--version", "0.7.0"]),
    "0.7.0",
  );
  assert.equal(
    parseDesktopUpdatePromotionVersion(["--", "--version", "0.7.1"]),
    "0.7.1",
  );
  assert.throws(
    () => parseDesktopUpdatePromotionVersion([]),
    /requires exactly/u,
  );
  assert.throws(
    () => parseDesktopUpdatePromotionVersion(["--version", "../0.7.0"]),
    /requires exactly/u,
  );
});

function fixture(options: {
  fileSha512?: string;
  fileSize?: number;
  legacyPath?: string;
  legacySha512?: string;
  omitFileSha512?: boolean;
  omitFileSize?: boolean;
} = {}): string {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "desktop-publish-"));
  const zipSha512 = sha512("zip");
  const fileSha512 = options.fileSha512 ?? zipSha512;
  const fileSize = options.fileSize ?? 3;
  const legacyPath = options.legacyPath
    ?? "Kestrel-0.7.0-mac-arm64.zip";
  const legacySha512 = options.legacySha512 ?? zipSha512;
  writeFileSync(
    path.join(outDir, "latest-mac.yml"),
    [
      "version: 0.7.0",
      "files:",
      "  - url: Kestrel-0.7.0-mac-arm64.zip",
      ...(options.omitFileSha512 ? [] : [`    sha512: ${fileSha512}`]),
      ...(options.omitFileSize ? [] : [`    size: ${fileSize}`]),
      `path: ${legacyPath}`,
      `sha512: ${legacySha512}`,
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(outDir, "Kestrel-0.7.0-mac-arm64.zip"), "zip");
  writeFileSync(path.join(outDir, "Kestrel-0.7.0-mac-arm64.dmg"), "dmg");
  writeFileSync(path.join(outDir, "Kestrel-0.7.0-mac-arm64.zip.blockmap"), "zip-blockmap");
  writeFileSync(path.join(outDir, "Kestrel-0.7.0-mac-arm64.dmg.blockmap"), "dmg-blockmap");
  return outDir;
}

function sha512(value: string): string {
  return createHash("sha512").update(value).digest("base64");
}
