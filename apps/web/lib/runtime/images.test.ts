import assert from "node:assert/strict";
import test from "node:test";
import { assertEnvironmentRuntimeImage } from "./images";

test("Environment Runtime images accept legacy digests and fixed production tags", () => {
  assert.doesNotThrow(() =>
    assertEnvironmentRuntimeImage(
      "workspace-runtime",
      `ghcr.io/lumicorp/kestrel-workspace-runtime@sha256:${"a".repeat(64)}`,
    ),
  );
  assert.doesNotThrow(() =>
    assertEnvironmentRuntimeImage(
      "environment-router",
      "ghcr.io/lumicorp/kestrel-environment-router:production-42-3",
    ),
  );
});

test("Environment Runtime images reject mutable and cross-role references", () => {
  for (const image of [
    "ghcr.io/lumicorp/kestrel-workspace-runtime:latest",
    "ghcr.io/lumicorp/kestrel-workspace-runtime:production-0-1",
    "ghcr.io/lumicorp/kestrel-environment-router:production-42-3",
  ]) {
    assert.throws(() => assertEnvironmentRuntimeImage("workspace-runtime", image));
  }
});
