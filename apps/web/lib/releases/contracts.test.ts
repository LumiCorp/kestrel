import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFlyImageMatchesRole,
  classifyFlyImageReleaseEnvironment,
  flyImageReleaseManifestV1Schema,
  isFlyImageReleaseMachineVerified,
} from "./contracts";

const revision = "a".repeat(40);
const digest = "b".repeat(64);

test("release manifests require unique changed roles from the bundle revision", () => {
  const component = {
    role: "workspace-runtime" as const,
    image: `registry.fly.io/kestrel-one-runner@sha256:${digest}`,
    sourceRevision: revision,
    inputFingerprint: `sha256:${"c".repeat(64)}`,
    smoke: {
      status: "passed" as const,
      command: "workspace image smoke",
      completedAt: "2026-08-03T12:00:00.000Z",
    },
  };
  const base = {
    version: 1 as const,
    bundleRevision: revision,
    trigger: "main" as const,
    migrationChanged: false,
    validation: {
      status: "passed" as const,
      commands: ["pnpm validate"],
      completedAt: "2026-08-03T12:00:00.000Z",
    },
  };
  assert.equal(
    flyImageReleaseManifestV1Schema.safeParse({
      ...base,
      components: [component],
    }).success,
    true,
  );
  assert.equal(
    flyImageReleaseManifestV1Schema.safeParse({
      ...base,
      components: [component, component],
    }).success,
    false,
  );
  assert.equal(
    flyImageReleaseManifestV1Schema.safeParse({
      ...base,
      components: [{ ...component, sourceRevision: "d".repeat(40) }],
    }).success,
    false,
  );
});

test("release images are bound to the registry app owned by their role", () => {
  assert.doesNotThrow(() =>
    assertFlyImageMatchesRole(
      "preview-edge",
      `registry.fly.io/kestrel-preview-edge@sha256:${digest}`,
    ),
  );
  assert.throws(
    () =>
      assertFlyImageMatchesRole(
        "workspace-runtime",
        `registry.fly.io/kestrel-preview-edge@sha256:${digest}`,
      ),
    /must use registry app 'kestrel-one-runner'/u,
  );
});

test("release environment classification waits only for provisionable environments", () => {
  assert.equal(
    classifyFlyImageReleaseEnvironment({ status: "ready", archived: false }),
    "deployable",
  );
  assert.equal(
    classifyFlyImageReleaseEnvironment({
      status: "provisioning",
      archived: false,
    }),
    "waiting",
  );
  assert.equal(
    classifyFlyImageReleaseEnvironment({ status: "failed", archived: false }),
    "skip",
  );
  assert.equal(
    classifyFlyImageReleaseEnvironment({ status: "ready", archived: true }),
    "skip",
  );
  assert.equal(
    classifyFlyImageReleaseEnvironment({ status: null, archived: false }),
    "skip",
  );
});

test("global release verification requires the requested digest on a running Machine", () => {
  const image = `registry.fly.io/kestrel-one-turn-worker@sha256:${digest}`;
  assert.equal(
    isFlyImageReleaseMachineVerified({ state: "started", image }, image),
    true,
  );
  assert.equal(
    isFlyImageReleaseMachineVerified({ state: "stopped", image }, image),
    false,
  );
  assert.equal(
    isFlyImageReleaseMachineVerified(
      { state: "started", image },
      `registry.fly.io/kestrel-one-turn-worker@sha256:${"d".repeat(64)}`,
    ),
    false,
  );
});
