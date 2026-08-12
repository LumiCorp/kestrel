import test from "node:test";
import assert from "node:assert/strict";

import { summarizePreviewStatus } from "./preview-lifecycle";

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
