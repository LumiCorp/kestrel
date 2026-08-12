import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateFlyReleaseDeploymentReadiness,
  LEGACY_RELEASE_COMPATIBILITY_BOOTSTRAP,
} from "./deployment-preflight";

test("production deploy blocks active mutation and incompatible stable routers", () => {
  assert.equal(
    evaluateFlyReleaseDeploymentReadiness({
      activeStatus: "deploying",
      stableAcceptedVersions: [2, 3],
      producedVersion: 3,
      bootstrap: undefined,
    }).ready,
    false,
  );
  const blocked = evaluateFlyReleaseDeploymentReadiness({
    activeStatus: "paused",
    stableAcceptedVersions: [2],
    producedVersion: 3,
    bootstrap: undefined,
  });
  assert.equal(blocked.ready, false);
  if (!blocked.ready) assert.equal(blocked.code, "RELEASE_COMPATIBILITY_BLOCKED");
});

test("legacy compatibility requires one explicit bridge and then expires", () => {
  assert.equal(
    evaluateFlyReleaseDeploymentReadiness({
      activeStatus: "paused",
      stableAcceptedVersions: null,
      producedVersion: 3,
      bootstrap: undefined,
    }).ready,
    false,
  );
  const bridge = evaluateFlyReleaseDeploymentReadiness({
      activeStatus: "paused",
      stableAcceptedVersions: null,
      producedVersion: 3,
      bootstrap: LEGACY_RELEASE_COMPATIBILITY_BOOTSTRAP,
    });
  assert.equal(bridge.ready, true);
  if (bridge.ready) assert.equal(bridge.mode, "legacy_bridge");
  assert.equal(
    evaluateFlyReleaseDeploymentReadiness({
      activeStatus: null,
      stableAcceptedVersions: [2, 3],
      producedVersion: 3,
      bootstrap: LEGACY_RELEASE_COMPATIBILITY_BOOTSTRAP,
    }).ready,
    false,
  );
});

test("paused compatible releases allow a production repair deployment", () => {
  assert.deepEqual(
    evaluateFlyReleaseDeploymentReadiness({
      activeStatus: "paused",
      stableAcceptedVersions: [2, 3],
      producedVersion: 3,
      bootstrap: undefined,
    }),
    { ready: true, mode: "enforced" },
  );
});
