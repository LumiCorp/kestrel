import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { selectForeignRuntimeRecoveryRoute } from "./runtime-recovery-route";

const recoverySource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime-recovery.ts"),
  "utf8",
);

test("a recovery fork adopts a freshly probed Environment route", () => {
  const sourceEnvironmentId = "degraded-environment";
  const route = selectForeignRuntimeRecoveryRoute({
    targetRuntimeId: "codex",
    sourceRuntimeId: "codex",
    sourceSelectedModelId: "openai/gpt-5",
    resolution: {
      capabilityDigest: "fresh-capability-digest",
      environmentId: "replacement-environment",
      selectedModelId: "openai/gpt-5",
    },
  });

  assert.ok(route);
  assert.notEqual(route.environmentId, sourceEnvironmentId);
  assert.equal(route.environmentId, "replacement-environment");
  assert.equal(route.selectedModelId, "openai/gpt-5");
});

test("a recovery fork rejects Runtime or model changes", () => {
  const resolution = {
    capabilityDigest: "fresh-capability-digest",
    environmentId: "replacement-environment",
    selectedModelId: "openai/gpt-5",
  };
  assert.equal(
    selectForeignRuntimeRecoveryRoute({
      targetRuntimeId: "codex",
      sourceRuntimeId: "claude",
      sourceSelectedModelId: resolution.selectedModelId,
      resolution,
    }),
    null,
  );
  assert.equal(
    selectForeignRuntimeRecoveryRoute({
      targetRuntimeId: "codex",
      sourceRuntimeId: "codex",
      sourceSelectedModelId: "openai/gpt-5-mini",
      resolution,
    }),
    null,
  );
});

test("recovery persistence uses the target proof without rewriting source route", () => {
  assert.match(
    recoverySource,
    /environmentId: targetRoute\?\.environmentId \?\? sourceBinding\.environmentId/u,
  );
  assert.doesNotMatch(
    recoverySource,
    /runtimeResolution\.environmentId !== sourceBinding\.environmentId/u,
  );
  const sourceDegradation = recoverySource.slice(
    recoverySource.indexOf(".set({\n          status: \"degraded\""),
    recoverySource.indexOf("if (releaseExecution"),
  );
  assert.doesNotMatch(sourceDegradation, /environmentId/u);
});
