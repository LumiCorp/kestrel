import assert from "node:assert/strict";
import test from "node:test";
import {
  platformImagePublicationSchema,
  runtimeRolloutContractSchema,
} from "./contracts";

test("Workspace data migrations require exceptional maintenance mode", () => {
  assert.equal(
    runtimeRolloutContractSchema.safeParse({
      version: 1,
      mode: "rolling",
      workspaceDataMigrationRevision: "workspace-data-v4",
    }).success,
    false,
  );
  assert.equal(
    runtimeRolloutContractSchema.safeParse({
      version: 1,
      mode: "maintenance",
      workspaceDataMigrationRevision: "workspace-data-v4",
    }).success,
    true,
  );
});

test("platform publications require immutable images and changed-image smoke evidence", () => {
  const valid = {
    sourceRevision: "a".repeat(40),
    routerImage: `registry.fly.io/kestrel-one-runner@sha256:${"b".repeat(64)}`,
    runtimeImage: `registry.fly.io/kestrel-one-runner@sha256:${"c".repeat(64)}`,
    rollout: {
      version: 1,
      mode: "rolling",
      workspaceDataMigrationRevision: null,
    },
    smoke: {
      router: {
        status: "passed",
        command: "router-smoke",
        completedAt: "2026-08-06T12:00:00.000Z",
      },
    },
  } as const;
  assert.equal(platformImagePublicationSchema.safeParse(valid).success, true);
  assert.equal(
    platformImagePublicationSchema.safeParse({
      ...valid,
      routerImage: "registry.fly.io/kestrel-one-runner:latest",
    }).success,
    false,
  );
  assert.equal(
    platformImagePublicationSchema.safeParse({ ...valid, smoke: {} }).success,
    false,
  );
});
