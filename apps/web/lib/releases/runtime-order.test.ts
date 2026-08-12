import assert from "node:assert/strict";
import test from "node:test";
import { orderFlyImageReleaseTargets } from "./runtime";

function target(
  targetKey: string,
  targetKind: "global_app" | "environment",
  componentRole: "preview-edge" | "runpod-worker" | "turn-worker" | null,
  environmentId: string | null = null,
) {
  return { targetKey, targetKind, componentRole, environmentId };
}

test("Environment releases prove the canary before global mutations", () => {
  const canaryId = "environment-canary";
  const ordered = orderFlyImageReleaseTargets(
    [
      target("global:preview-edge", "global_app", "preview-edge"),
      target("global:runpod-worker", "global_app", "runpod-worker"),
      target("global:turn-worker", "global_app", "turn-worker"),
      target("environment:z", "environment", null, "environment-z"),
      target("environment:canary", "environment", null, canaryId),
    ],
    canaryId,
  );
  assert.deepEqual(
    ordered.map((item) => item.targetKey),
    [
      "environment:canary",
      "global:preview-edge",
      "global:runpod-worker",
      "environment:z",
      "global:turn-worker",
    ],
  );
});

test("global-only releases preserve their deterministic order", () => {
  const ordered = orderFlyImageReleaseTargets(
    [
      target("global:turn-worker", "global_app", "turn-worker"),
      target("global:runpod-worker", "global_app", "runpod-worker"),
      target("global:preview-edge", "global_app", "preview-edge"),
    ],
    null,
  );
  assert.deepEqual(
    ordered.map((item) => item.targetKey),
    ["global:preview-edge", "global:runpod-worker", "global:turn-worker"],
  );
});
