import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

import {
  isPortListening,
  isValidPreviewInspectionPort,
} from "../src/previews.js";

test("preview inspection accepts the complete typed port range", () => {
  assert.equal(isValidPreviewInspectionPort(1024), true);
  assert.equal(isValidPreviewInspectionPort(43_104), true);
  assert.equal(isValidPreviewInspectionPort(43_105), true);
  assert.equal(isValidPreviewInspectionPort(65_535), true);
  assert.equal(isValidPreviewInspectionPort(1023), false);
  assert.equal(isValidPreviewInspectionPort(65_536), false);
  assert.equal(isValidPreviewInspectionPort(1024.5), false);
});

test("preview inspection distinguishes listening and closed ports", async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;

  try {
    assert.equal(await isPortListening(port), true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  assert.equal(await isPortListening(port), false);
});
