import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateUnifiedReleaseEvidence } from "../../scripts/check-unified-release-evidence.js";

const sourceSha = "a".repeat(40);
const checksum = "b".repeat(64);
const timestamp = "2026-08-04T16:00:00.000Z";
const packageNames = [
  "@kestrel-agents/protocol",
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
  "runpod-worker",
];
const evidenceDirectory = mkdtempSync(path.join(os.tmpdir(), "hydra-evidence-test-"));
const hydraArtifact = "hydra.json";
const hydraBytes = Buffer.from(JSON.stringify({
  version: "hydra_smoke_evidence_v1",
  sourceSha,
  startedAt: timestamp,
  completedAt: timestamp,
  status: "passed",
  local: {
    status: "passed",
    runtimes: ["codex", "claude"].map((runtimeId) => ({
      runtimeId,
      nativeVersion: "test",
      modelId: `${runtimeId}-model`,
      authenticationSource: "native-login",
      scenarios: [{ id: "local", status: "passed", durationMs: 1 }],
    })),
  },
  candidate: {
    status: "passed",
    origin: "https://candidate.example.test",
    deploymentRevision: sourceSha,
    runtimes: ["codex", "claude"].map((runtimeId) => ({
      runtimeId,
      modelId: `${runtimeId}-model`,
      scenarios: [{ id: "candidate", status: "passed", durationMs: 1 }],
    })),
  },
}));
writeFileSync(path.join(evidenceDirectory, hydraArtifact), hydraBytes);
test.after(() => rmSync(evidenceDirectory, { recursive: true, force: true }));

const validate = (evidence: unknown) =>
  validateUnifiedReleaseEvidence(evidence, { evidenceDirectory });

test("accepts a complete immutable candidate evidence bundle", () => {
  assert.doesNotThrow(() => validate(validEvidence()));
});

test("rejects package and source revision mismatches", () => {
  const evidence = validEvidence();
  const packageEvidence = evidence.npm.packages[0];
  assert.ok(packageEvidence);
  packageEvidence.version = "0.7.0";
  assert.throws(() => validate(evidence), /version mismatch/u);
});

test("rejects mutable Fly references", () => {
  const evidence = validEvidence();
  const flyEvidence = evidence.fly[0];
  assert.ok(flyEvidence);
  flyEvidence.image = "registry.fly.io/kestrel-one-runner:0.8.0";
  assert.throws(() => validate(evidence), /image is mutable/u);
});

test("rejects a changed stable OTA pointer", () => {
  const evidence = validEvidence();
  evidence.desktopOta.afterSha256 = "c".repeat(64);
  assert.throws(() => validate(evidence), /OTA metadata changed/u);
});

test("requires both exact-revision production deployments", () => {
  const evidence = validEvidence();
  const incompleteDeployments = {
    ...evidence,
    deployments: { docs: evidence.deployments.docs },
  };
  assert.throws(
    () => validate(incompleteDeployments),
    /deployments are incomplete or duplicated/u,
  );
});

test("requires latest to match only for cutover evidence", () => {
  const candidate = validEvidence();
  assert.doesNotThrow(() => validate(candidate));
  candidate.phase = "cutover";
  assert.throws(() => validate(candidate), /latest dist-tag mismatch/u);
  for (const packageEvidence of candidate.npm.packages) {
    packageEvidence.distTags.latest = packageEvidence.version;
  }
  assert.doesNotThrow(() => validate(candidate));
});

test("requires the explicit Runtime npm patch version", () => {
  const evidence = validEvidence();
  const runtime = evidence.npm.packages.find(({ name }) => name === "@kestrel-agents/kestrel");
  assert.ok(runtime);
  runtime.version = "0.8.0";
  assert.throws(() => validate(evidence), /kestrel version mismatch/u);
});

function validEvidence() {
  return {
    phase: "candidate" as "candidate" | "cutover",
    version: "0.8.0",
    sourceSha,
    npm: {
      runtimeVersion: "0.8.2",
      packages: packageNames.map((name) => ({
        name,
        version: name === "@kestrel-agents/kestrel" ? "0.8.2" : "0.8.0",
        gitHead: sourceSha,
        integrity: "sha512-YWJjZA==",
        distTags: {
          "release-0.8.0": name === "@kestrel-agents/kestrel" ? "0.8.2" : "0.8.0",
          latest: "0.7.0",
        },
      })),
      consumerSmokes: ["darwin-arm64", "linux-x64"].map((platform) => ({
        platform,
        version: "0.8.2",
        status: "passed",
        completedAt: timestamp,
      })),
    },
    cli: {
      platform: "darwin-arm64",
      version: "0.8.0",
      sourceSha,
      archiveSha256: checksum,
    },
    desktop: {
      version: "0.8.0",
      sourceSha,
      artifacts: ["dmg", "zip"].map((type) => ({ type, sha256: checksum })),
      signingIdentity: "Developer ID Application: Lumi",
      notarization: "passed",
      gatekeeper: "passed",
      launchServices: "passed",
    },
    desktopOta: {
      expectedStableVersion: "0.7.0",
      beforeVersion: "0.7.0",
      afterVersion: "0.7.0",
      beforeSha256: checksum,
      afterSha256: checksum,
    },
    deployments: {
      kestrelOne: { deploymentId: "dpl_one", revision: sourceSha, status: "passed" },
      docs: { deploymentId: "dpl_docs", revision: sourceSha, status: "passed" },
    },
    migrations: { preflightStatus: "passed", applied: ["0001_release"] },
    fly: flyRoles.map((role) => ({
      role,
      image: `registry.fly.io/kestrel-one@sha256:${checksum}`,
      sourceSha,
      smoke: { status: "passed", completedAt: timestamp },
    })),
    canaries: [
      { name: "kestrel-one-hosted", status: "passed", completedAt: timestamp },
      { name: "docs-production", status: "passed", completedAt: timestamp },
    ],
    hydra: {
      sourceSha,
      artifact: hydraArtifact,
      artifactSha256: createHash("sha256").update(hydraBytes).digest("hex"),
      status: "passed",
    },
  };
}
