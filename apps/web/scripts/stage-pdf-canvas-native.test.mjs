import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canvasNativePackageName,
  stagePdfCanvasNative,
} from "./stage-pdf-canvas-native.mjs";

test("selects the pinned native package for supported build platforms", () => {
  assert.equal(canvasNativePackageName({ platform: "darwin", arch: "arm64" }), "@napi-rs/canvas-darwin-arm64");
  assert.equal(canvasNativePackageName({ platform: "linux", arch: "x64", musl: false }), "@napi-rs/canvas-linux-x64-gnu");
  assert.equal(canvasNativePackageName({ platform: "linux", arch: "x64", musl: true }), "@napi-rs/canvas-linux-x64-musl");
  assert.throws(() => canvasNativePackageName({ platform: "aix", arch: "ppc64" }), /Unsupported PDF canvas build platform/u);
});

test("copies the current platform binding into a stable web-owned path", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-canvas-native-"));
  try {
    const destination = join(root, "canvas-native.node");
    const staged = await stagePdfCanvasNative({ destination });
    assert.deepEqual(await readFile(destination), await readFile(staged.nativeBinding));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
