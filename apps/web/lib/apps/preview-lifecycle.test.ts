import test from "node:test";
import assert from "node:assert/strict";

import {
  summarizePreviewStatus,
  workspacePreviewUrl,
} from "./preview-lifecycle";

test("preview compatibility status never represents unknown liveness as available", () => {
  assert.equal(summarizePreviewStatus("active", "listening"), "available");
  assert.equal(
    summarizePreviewStatus("active", "not_listening"),
    "unavailable",
  );
  assert.equal(summarizePreviewStatus("active", "unknown"), "unknown");
  assert.equal(
    summarizePreviewStatus("provisioning", "unknown"),
    "provisioning",
  );
});

test("local previews use the loopback application while hosted previews retain their Edge URL", () => {
  const preview = {
    hostname: "p-opaque.preview.kestrelagents.dev",
    port: 48_123,
  };
  assert.equal(
    workspacePreviewUrl(preview, { KESTREL_ENVIRONMENT_RUNTIME: "local" }),
    "http://127.0.0.1:48123",
  );
  assert.equal(
    workspacePreviewUrl(preview, { KESTREL_ENVIRONMENT_RUNTIME: "fly" }),
    "https://p-opaque.preview.kestrelagents.dev",
  );
});
