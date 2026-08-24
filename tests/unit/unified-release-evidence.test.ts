import assert from "node:assert/strict";
import test from "node:test";
import { validateUnifiedReleaseEvidence } from "../../scripts/check-unified-release-evidence.js";

const checksum = "b".repeat(64);
const timestamp = "2026-08-04T16:00:00.000Z";
const packageNames = [
  "@kestrel-agents/protocol",
  "@kestrel-agents/conversation",
  "@kestrel-agents/files",
  "@kestrel-agents/memory",
  "@kestrel-agents/workspace-skills",
  "@kestrel-agents/sdk",
  "@kestrel-agents/next",
  "@kestrel-agents/ai-sdk",
  "@kestrel-agents/observability",
  "@kestrel-agents/kestrel",
];
const flyRoles = [
  "workspace-runtime",
  "environment-router",
  "preview-edge",
  "turn-worker",
  "control-worker",
  "runpod-worker",
];

test("accepts a complete immutable candidate evidence bundle", () => {
  assert.doesNotThrow(() => validateUnifiedReleaseEvidence(validEvidence()));
});

test("candidate evidence does not require production rollout results", () => {
  const evidence = validEvidence();
  Reflect.deleteProperty(evidence, "deployments");
  Reflect.deleteProperty(evidence, "migrations");
  Reflect.deleteProperty(evidence, "fly");
  Reflect.deleteProperty(evidence, "canaries");
  assert.doesNotThrow(() => validateUnifiedReleaseEvidence(evidence));
});

test("cutover evidence accepts immutable GHCR runtime images", () => {
  const evidence = cutoverEvidence();
  assert.ok(evidence.fly);
  evidence.fly[0]!.image = `ghcr.io/lumicorp/kestrel-workspace-runtime@sha256:${checksum}`;
  evidence.fly[1]!.image = `ghcr.io/lumicorp/kestrel-environment-router@sha256:${checksum}`;
  assert.doesNotThrow(() => validateUnifiedReleaseEvidence(evidence));
});

test("rejects package version mismatches", () => {
  const evidence = validEvidence();
  const packageEvidence = evidence.npm.packages[0];
  assert.ok(packageEvidence);
  packageEvidence.version = "0.7.0";
  assert.throws(() => validateUnifiedReleaseEvidence(evidence), /version mismatch/u);
});

test("rejects mutable Fly references", () => {
  const evidence = cutoverEvidence();
  assert.ok(evidence.fly);
  const flyEvidence = evidence.fly[0];
  assert.ok(flyEvidence);
  flyEvidence.image = "registry.fly.io/kestrel-one-runner:0.8.0";
  assert.throws(() => validateUnifiedReleaseEvidence(evidence), /image is mutable/u);
});

test("rejects a changed candidate stable OTA pointer", () => {
  const evidence = validEvidence();
  evidence.desktopOta.stableAfterSha256 = "c".repeat(64);
  assert.throws(() => validateUnifiedReleaseEvidence(evidence), /candidate stable Desktop OTA metadata changed/u);
});

test("requires both production deployments", () => {
  const evidence = cutoverEvidence();
  assert.ok(evidence.deployments);
  const incompleteDeployments = {
    ...evidence,
    deployments: { docs: evidence.deployments.docs },
  };
  assert.throws(
    () => validateUnifiedReleaseEvidence(incompleteDeployments),
    /deployments are incomplete or duplicated/u,
  );
});

test("requires latest to match only for cutover evidence", () => {
  const candidate = validEvidence();
  assert.doesNotThrow(() => validateUnifiedReleaseEvidence(candidate));
  candidate.phase = "cutover";
  assert.throws(() => validateUnifiedReleaseEvidence(candidate), /latest dist-tag mismatch/u);
  for (const packageEvidence of candidate.npm.packages) {
    packageEvidence.distTags.latest = packageEvidence.version;
  }
  candidate.desktopOta.stableAfterSha256 = "c".repeat(64);
  candidate.desktopOta.stableAfterVersion = candidate.version;
  candidate.desktopOta.transitions = ["0.7.0", "0.8.0"].map((fromVersion) => ({
    fromVersion,
    toVersion: candidate.version,
    status: "passed",
    completedAt: timestamp,
  }));
  assert.doesNotThrow(() => validateUnifiedReleaseEvidence(candidate));
});

test("requires Runtime to use the canonical suite version", () => {
  const evidence = validEvidence();
  const runtime = evidence.npm.packages.find(({ name }) => name === "@kestrel-agents/kestrel");
  assert.ok(runtime);
  runtime.version = "0.8.0";
  assert.throws(() => validateUnifiedReleaseEvidence(evidence), /kestrel version mismatch/u);
});

test("cutover requires both public Desktop OTA transitions", () => {
  const evidence = cutoverEvidence();
  evidence.desktopOta.transitions = [{
    fromVersion: "0.8.0",
    toVersion: evidence.version,
    status: "passed",
    completedAt: timestamp,
  }];
  assert.throws(() => validateUnifiedReleaseEvidence(evidence), /Desktop OTA transitions/u);
});

function cutoverEvidence() {
  const evidence = validEvidence();
  evidence.phase = "cutover";
  for (const packageEvidence of evidence.npm.packages) {
    packageEvidence.distTags.latest = evidence.version;
  }
  evidence.desktopOta.stableAfterSha256 = "c".repeat(64);
  evidence.desktopOta.stableAfterVersion = evidence.version;
  evidence.desktopOta.transitions = ["0.7.0", "0.8.0"].map((fromVersion) => ({
    fromVersion,
    toVersion: evidence.version,
    status: "passed",
    completedAt: timestamp,
  }));
  return evidence;
}

function validEvidence() {
  return {
    phase: "candidate" as "candidate" | "cutover",
    version: "0.8.5",
    npm: {
      packages: packageNames.map((name) => ({
        name,
        version: "0.8.5",
        integrity: "sha512-YWJjZA==",
        distTags: {
          "release-0.8.5": "0.8.5",
          latest: "0.7.0",
        },
      })),
      consumerSmokes: ["darwin-arm64", "linux-x64"].map((platform) => ({
        platform,
        version: "0.8.5",
        status: "passed",
        completedAt: timestamp,
      })),
    },
    cli: {
      platform: "darwin-arm64",
      version: "0.8.5",
      archiveSha256: checksum,
    },
    desktop: {
      version: "0.8.5",
      artifacts: ["dmg", "zip"].map((type) => ({ type, sha256: checksum })),
      signingIdentity: "Developer ID Application: Lumi",
      notarization: "passed",
      gatekeeper: "passed",
      launchServices: "passed",
    },
    desktopOta: {
      stableBeforeVersion: "0.7.0",
      stableAfterVersion: "0.7.0",
      stableBeforeSha256: checksum,
      stableAfterSha256: checksum,
      transitions: [] as Array<{
        completedAt: string;
        fromVersion: string;
        status: string;
        toVersion: string;
      }>,
    },
    deployments: {
      kestrelOne: { deploymentId: "dpl_one", status: "passed" },
      docs: { deploymentId: "dpl_docs", status: "passed" },
    },
    migrations: { preflightStatus: "passed", applied: ["0001_release"] },
    fly: flyRoles.map((role) => ({
      role,
      image: `registry.fly.io/kestrel-one@sha256:${checksum}`,
      smoke: { status: "passed", completedAt: timestamp },
    })),
    canaries: [
      { name: "kestrel-one-hosted", status: "passed", completedAt: timestamp },
      { name: "docs-production", status: "passed", completedAt: timestamp },
    ],
  };
}
