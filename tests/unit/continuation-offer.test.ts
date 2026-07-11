import test from "node:test";
import assert from "node:assert/strict";

import { normalizeContinuationOffer } from "../../src/runtime/continuationOffer.js";

function offer(requiredMode: string) {
  return {
    version: "continuation_offer_v1",
    kind: "implementation",
    objective: "Build the feature.",
    requiredToolClass: "sandboxed_only",
    requiredCapabilities: ["workspace.write"],
    requiredMode,
    sourceRunId: "run-1",
  };
}

test("normalizeContinuationOffer migrates legacy act required modes while emitting build names", () => {
  assert.equal(normalizeContinuationOffer(offer("act.safe"), "fallback-run")?.requiredMode, "build");
  assert.equal(normalizeContinuationOffer(offer("act.full_auto"), "fallback-run")?.requiredMode, "build");
  assert.equal(normalizeContinuationOffer(offer("build.guarded"), "fallback-run")?.requiredMode, "build");
  assert.equal(normalizeContinuationOffer(offer("build.auto"), "fallback-run")?.requiredMode, "build");
  assert.equal(normalizeContinuationOffer(offer("build"), "fallback-run")?.requiredMode, "build");
});

test("normalizeContinuationOffer preserves resumeMessage for backward compatibility", () => {
  const normalized = normalizeContinuationOffer(
    {
      ...offer("build"),
      resumeMessage: "Resume the implementation.",
    },
    "fallback-run",
  );

  assert.equal(normalized?.resumeMessage, "Resume the implementation.");
});
