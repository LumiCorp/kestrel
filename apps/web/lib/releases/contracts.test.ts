import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateFlyImageForwardRecoveryEligibility,
  assertFlyImageMatchesRole,
  classifyFlyImageReleaseEnvironment,
  countResolvedFlyImageReleaseTargets,
  evaluateFlyImageReleaseAdmission,
  evaluateFlyImageMigrationAcknowledgementEligibility,
  flyImageReleaseManifestV2Schema,
  isFlyImageReleaseMachineVerified,
  selectFlyImageRollbackTargets,
} from "./contracts";

test("forward recovery eligibility is fully server-derived", () => {
  assert.deepEqual(
    evaluateFlyImageForwardRecoveryEligibility({
      activeStatus: "paused",
      admission: { ok: true },
      migrationReady: true,
      canaryValid: true,
    }),
    { ok: true },
  );
  assert.equal(
    evaluateFlyImageForwardRecoveryEligibility({
      activeStatus: "paused",
      admission: { ok: true },
      migrationReady: false,
      canaryValid: true,
    }).ok,
    false,
  );
  assert.equal(
    evaluateFlyImageForwardRecoveryEligibility({
      activeStatus: "paused",
      admission: { ok: true },
      migrationReady: true,
      canaryValid: false,
    }).ok,
    false,
  );
});

test("migration acknowledgement eligibility follows the endpoint contract", () => {
  assert.deepEqual(
    evaluateFlyImageMigrationAcknowledgementEligibility({
      status: "candidate",
      migrationChanged: true,
      migrationApprovedAt: null,
    }),
    { ok: true },
  );
  assert.equal(
    evaluateFlyImageMigrationAcknowledgementEligibility({
      status: "paused",
      migrationChanged: true,
      migrationApprovedAt: null,
    }).ok,
    false,
  );
  assert.equal(
    evaluateFlyImageMigrationAcknowledgementEligibility({
      status: "candidate",
      migrationChanged: false,
      migrationApprovedAt: null,
    }).ok,
    false,
  );
});

test("release progress counts configured stopped Workspaces as resolved", () => {
  assert.equal(
    countResolvedFlyImageReleaseTargets([
      { status: "completed" },
      { status: "configured_unverified" },
      { status: "applying" },
    ]),
    2,
  );
});

const revision = "a".repeat(40);
const digest = "b".repeat(64);

test("release manifests require unique changed roles from the bundle revision", () => {
  const component = {
    role: "workspace-runtime" as const,
    image: `ghcr.io/lumicorp/kestrel-workspace-runtime@sha256:${digest}`,
    sourceRevision: revision,
    inputFingerprint: `sha256:${"c".repeat(64)}`,
    smoke: {
      status: "passed" as const,
      command: "workspace image smoke",
      completedAt: "2026-08-03T12:00:00.000Z",
    },
  };
  const base = {
    version: 2 as const,
    controllerContractRevision: 1,
    bundleRevision: revision,
    trigger: "main" as const,
    migrationChanged: false,
    environmentGateway: { producedVersion: 3 },
    validation: {
      status: "passed" as const,
      commands: ["pnpm validate"],
      completedAt: "2026-08-03T12:00:00.000Z",
    },
  };
  assert.equal(
    flyImageReleaseManifestV2Schema.safeParse({
      ...base,
      components: [component],
    }).success,
    true,
  );
  assert.equal(
    flyImageReleaseManifestV2Schema.safeParse({
      ...base,
      components: [component, component],
    }).success,
    false,
  );
  assert.equal(
    flyImageReleaseManifestV2Schema.safeParse({
      ...base,
      components: [{ ...component, sourceRevision: "d".repeat(40) }],
    }).success,
    false,
  );
});

test("rollback selects only targets that may have mutated", () => {
  assert.deepEqual(
    selectFlyImageRollbackTargets([
      {
        targetKind: "global_app",
        componentRole: "preview-edge",
        environmentId: null,
        status: "completed",
        startedAt: new Date(),
        result: null,
      },
      {
        targetKind: "global_app",
        componentRole: "runpod-worker",
        environmentId: null,
        status: "pending",
        startedAt: null,
        result: null,
      },
      {
        targetKind: "environment",
        componentRole: null,
        environmentId: "environment-applied",
        status: "failed",
        startedAt: new Date(),
        result: { operationId: "operation-test" },
      },
      {
        targetKind: "environment",
        componentRole: null,
        environmentId: "environment-draining",
        status: "draining",
        startedAt: new Date(),
        result: null,
      },
    ]),
    {
      globalRoles: ["preview-edge"],
      environmentIds: ["environment-applied"],
    },
  );
});

test("release admission rejects stale forward bundles and incompatible routers", () => {
  assert.deepEqual(
    evaluateFlyImageReleaseAdmission({
      trigger: "main",
      bundleRevision: "a".repeat(40),
      currentBuildRevision: "b".repeat(40),
      currentProducedVersion: 3,
      releaseProducedVersion: 3,
      routerAcceptedVersions: [2, 3],
    }),
    {
      ok: false,
      code: "RELEASE_BUILD_REVISION_MISMATCH",
      message: "Release revision does not match the serving Kestrel revision.",
    },
  );
  const blocked = evaluateFlyImageReleaseAdmission({
    trigger: "rollback",
    bundleRevision: "a".repeat(40),
    currentBuildRevision: "b".repeat(40),
    currentProducedVersion: 3,
    releaseProducedVersion: 3,
    routerAcceptedVersions: [2],
  });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.code, "RELEASE_COMPATIBILITY_BLOCKED");
  }
  assert.deepEqual(
    evaluateFlyImageReleaseAdmission({
      trigger: "rollback",
      bundleRevision: "a".repeat(40),
      currentBuildRevision: "b".repeat(40),
      currentProducedVersion: 3,
      releaseProducedVersion: 3,
      routerAcceptedVersions: [2, 3],
    }),
    { ok: true },
  );
});

test("release manifests bind gateway compatibility to the router component", () => {
  const router = {
    role: "environment-router" as const,
    image: `ghcr.io/lumicorp/kestrel-environment-router@sha256:${digest}`,
    sourceRevision: revision,
    inputFingerprint: `sha256:${"c".repeat(64)}`,
    smoke: {
      status: "passed" as const,
      command: "router image smoke",
      completedAt: "2026-08-03T12:00:00.000Z",
    },
    environmentGateway: { acceptedVersions: [2, 3] },
  };
  const manifest = {
    version: 2 as const,
    controllerContractRevision: 1,
    bundleRevision: revision,
    trigger: "main" as const,
    migrationChanged: false,
    environmentGateway: { producedVersion: 3 },
    validation: {
      status: "passed" as const,
      commands: ["pnpm validate"],
      completedAt: "2026-08-03T12:00:00.000Z",
    },
  };
  assert.equal(
    flyImageReleaseManifestV2Schema.safeParse({
      ...manifest,
      components: [router],
    }).success,
    true,
  );
  assert.equal(
    flyImageReleaseManifestV2Schema.safeParse({
      ...manifest,
      components: [{ ...router, environmentGateway: undefined }],
    }).success,
    false,
  );
  assert.equal(
    flyImageReleaseManifestV2Schema.safeParse({
      ...manifest,
      components: [
        { ...router, environmentGateway: { acceptedVersions: [3, 2] } },
      ],
    }).success,
    false,
  );
  assert.equal(
    flyImageReleaseManifestV2Schema.safeParse({
      ...manifest,
      components: [
        { ...router, environmentGateway: { acceptedVersions: [2, 2, 3] } },
      ],
    }).success,
    false,
  );
});

test("release images are bound to the exact repository owned by their role", () => {
  assert.doesNotThrow(() =>
    assertFlyImageMatchesRole(
      "workspace-runtime",
      `ghcr.io/lumicorp/kestrel-workspace-runtime@sha256:${digest}`,
    ),
  );
  assert.doesNotThrow(() =>
    assertFlyImageMatchesRole(
      "environment-router",
      `ghcr.io/lumicorp/kestrel-environment-router@sha256:${digest}`,
    ),
  );
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
    /must use repository 'ghcr\.io\/lumicorp\/kestrel-workspace-runtime'/u,
  );
  assert.throws(() =>
    assertFlyImageMatchesRole(
      "workspace-runtime",
      `ghcr.io/lumicorp/kestrel-environment-router@sha256:${digest}`,
    ),
  );
  assert.throws(() =>
    assertFlyImageMatchesRole(
      "workspace-runtime",
      "ghcr.io/lumicorp/kestrel-workspace-runtime:latest",
    ),
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

test("global release verification requires the requested digest and expected state", () => {
  const image = `registry.fly.io/kestrel-one-turn-worker@sha256:${digest}`;
  assert.equal(
    isFlyImageReleaseMachineVerified(
      { state: "started", image },
      image,
      "started",
    ),
    true,
  );
  assert.equal(
    isFlyImageReleaseMachineVerified(
      { state: "stopped", image },
      image,
      "stopped",
    ),
    true,
  );
  assert.equal(
    isFlyImageReleaseMachineVerified(
      { state: "started", image },
      `registry.fly.io/kestrel-one-turn-worker@sha256:${"d".repeat(64)}`,
      "started",
    ),
    false,
  );
  assert.equal(
    isFlyImageReleaseMachineVerified(
      { state: "stopped", image },
      image,
      "started",
    ),
    false,
  );
});
