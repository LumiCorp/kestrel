import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PUBLIC_PACKAGES = [
  "@kestrel-agents/protocol",
  "@kestrel-agents/memory",
  "@kestrel-agents/workspace-skills",
  "@kestrel-agents/sdk",
  "@kestrel-agents/next",
  "@kestrel-agents/ai-sdk",
  "@kestrel-agents/observability",
  "@kestrel-agents/kestrel",
] as const;

const RUNTIME_PACKAGE = "@kestrel-agents/kestrel";

const FLY_ROLES = [
  "workspace-runtime",
  "environment-router",
  "preview-edge",
  "turn-worker",
  "runpod-worker",
] as const;

interface ReleaseEvidence {
  phase: "candidate" | "cutover";
  version: string;
  sourceSha: string;
  npm: {
    runtimeVersion: string;
    packages: Array<{
      distTags: Record<string, string>;
      gitHead?: string;
      integrity: string;
      name: string;
      version: string;
    }>;
    consumerSmokes: Array<{
      completedAt: string;
      platform: string;
      status: string;
      version: string;
    }>;
  };
  cli: {
    archiveSha256: string;
    platform: string;
    sourceSha: string;
    version: string;
  };
  desktop: {
    artifacts: Array<{ sha256: string; type: string }>;
    gatekeeper: string;
    launchServices: string;
    notarization: string;
    signingIdentity: string;
    sourceSha: string;
    version: string;
  };
  desktopOta: {
    afterSha256: string;
    afterVersion: string;
    beforeSha256: string;
    beforeVersion: string;
    expectedStableVersion: string;
  };
  deployments: {
    docs: DeploymentEvidence;
    kestrelOne: DeploymentEvidence;
  };
  migrations: {
    applied: string[];
    preflightStatus: string;
  };
  fly: Array<{
    image: string;
    role: string;
    smoke: { completedAt: string; status: string };
    sourceSha: string;
  }>;
  canaries: Array<{
    completedAt: string;
    name: string;
    status: string;
  }>;
}

interface DeploymentEvidence {
  deploymentId: string;
  revision: string;
  status: string;
}

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/u;
const IMMUTABLE_FLY_IMAGE_PATTERN =
  /^registry\.fly\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u;

export function validateUnifiedReleaseEvidence(input: unknown): void {
  assertRecord(input, "release evidence");
  const evidence = input as unknown as ReleaseEvidence;
  assert.ok(evidence.phase === "candidate" || evidence.phase === "cutover");
  assert.match(evidence.version, /^\d+\.\d+\.\d+$/u, "version must be numeric semver");
  assert.match(evidence.sourceSha, SHA_PATTERN, "sourceSha must be a full Git SHA");

  assertRecord(evidence.npm, "npm evidence");
  assert.match(
    evidence.npm.runtimeVersion,
    /^\d+\.\d+\.\d+$/u,
    "npm runtimeVersion must be numeric semver",
  );
  assertExactNames(
    evidence.npm.packages,
    PUBLIC_PACKAGES,
    (entry) => entry.name,
    "npm packages",
  );
  for (const packageEvidence of evidence.npm.packages) {
    const expectedVersion = packageEvidence.name === RUNTIME_PACKAGE
      ? evidence.npm.runtimeVersion
      : evidence.version;
    assert.equal(packageEvidence.version, expectedVersion, `${packageEvidence.name} version mismatch`);
    assert.match(packageEvidence.integrity, /^sha512-[A-Za-z0-9+/=]+$/u);
    if (packageEvidence.gitHead !== undefined) {
      assert.equal(packageEvidence.gitHead, evidence.sourceSha, `${packageEvidence.name} gitHead mismatch`);
    }
    assert.equal(
      packageEvidence.distTags[`release-${evidence.version}`],
      expectedVersion,
      `${packageEvidence.name} staging dist-tag mismatch`,
    );
    if (evidence.phase === "cutover") {
      assert.equal(
        packageEvidence.distTags.latest,
        expectedVersion,
        `${packageEvidence.name} latest dist-tag mismatch`,
      );
    }
  }
  assertExactNames(
    evidence.npm.consumerSmokes,
    ["darwin-arm64", "linux-x64"],
    (entry) => entry.platform,
    "npm consumer platforms",
  );
  for (const smoke of evidence.npm.consumerSmokes) {
    assert.equal(smoke.version, evidence.npm.runtimeVersion);
    assertPassed(smoke.status, `npm consumer smoke ${smoke.platform}`);
    assertTimestamp(smoke.completedAt, `npm consumer smoke ${smoke.platform}`);
  }

  assertRecord(evidence.cli, "CLI evidence");
  assert.equal(evidence.cli.platform, "darwin-arm64");
  assert.equal(evidence.cli.version, evidence.version);
  assert.equal(evidence.cli.sourceSha, evidence.sourceSha);
  assert.match(evidence.cli.archiveSha256, CHECKSUM_PATTERN);

  assertRecord(evidence.desktop, "Desktop evidence");
  assert.equal(evidence.desktop.version, evidence.version);
  assert.equal(evidence.desktop.sourceSha, evidence.sourceSha);
  assertNonEmpty(evidence.desktop.signingIdentity, "Desktop signing identity");
  assertPassed(evidence.desktop.notarization, "Desktop notarization");
  assertPassed(evidence.desktop.gatekeeper, "Desktop Gatekeeper");
  assertPassed(evidence.desktop.launchServices, "Desktop LaunchServices");
  assertExactNames(
    evidence.desktop.artifacts,
    ["dmg", "zip"],
    (entry) => entry.type,
    "Desktop artifacts",
  );
  for (const artifact of evidence.desktop.artifacts) {
    assert.match(artifact.sha256, CHECKSUM_PATTERN, `${artifact.type} checksum is invalid`);
  }

  assertRecord(evidence.desktopOta, "Desktop OTA evidence");
  assert.match(evidence.desktopOta.beforeSha256, CHECKSUM_PATTERN);
  assert.equal(
    evidence.desktopOta.afterSha256,
    evidence.desktopOta.beforeSha256,
    "stable Desktop OTA metadata changed",
  );
  assert.equal(evidence.desktopOta.beforeVersion, evidence.desktopOta.expectedStableVersion);
  assert.equal(evidence.desktopOta.afterVersion, evidence.desktopOta.expectedStableVersion);

  assertRecord(evidence.deployments, "deployment evidence");
  assertExactNames(
    Object.entries(evidence.deployments),
    ["docs", "kestrelOne"],
    ([name]) => name,
    "deployments",
  );
  for (const [name, deployment] of Object.entries(evidence.deployments)) {
    assertNonEmpty(deployment.deploymentId, `${name} deployment ID`);
    assert.equal(deployment.revision, evidence.sourceSha, `${name} deployment revision mismatch`);
    assertPassed(deployment.status, `${name} deployment`);
  }

  assertRecord(evidence.migrations, "migration evidence");
  assertPassed(evidence.migrations.preflightStatus, "migration preflight");
  assert.ok(Array.isArray(evidence.migrations.applied), "applied migrations must be an array");
  assert.equal(
    new Set(evidence.migrations.applied).size,
    evidence.migrations.applied.length,
    "applied migrations must be unique",
  );
  for (const migration of evidence.migrations.applied) {
    assertNonEmpty(migration, "applied migration identifier");
  }

  assertExactNames(evidence.fly, FLY_ROLES, (entry) => entry.role, "Fly roles");
  for (const component of evidence.fly) {
    assert.match(component.image, IMMUTABLE_FLY_IMAGE_PATTERN, `${component.role} image is mutable`);
    assert.equal(component.sourceSha, evidence.sourceSha, `${component.role} source revision mismatch`);
    assertPassed(component.smoke.status, `${component.role} smoke`);
    assertTimestamp(component.smoke.completedAt, `${component.role} smoke`);
  }

  assert.ok(Array.isArray(evidence.canaries) && evidence.canaries.length > 0, "hosted canary evidence is required");
  for (const canary of evidence.canaries) {
    assertNonEmpty(canary.name, "canary name");
    assertPassed(canary.status, `canary ${canary.name}`);
    assertTimestamp(canary.completedAt, `canary ${canary.name}`);
  }
}

function assertExactNames<T>(
  values: readonly T[],
  expected: readonly string[],
  select: (value: T) => string,
  label: string,
): void {
  assert.ok(Array.isArray(values), `${label} must be an array`);
  const names = values.map(select).sort();
  assert.deepEqual(names, [...expected].sort(), `${label} are incomplete or duplicated`);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `${label} must be an object`);
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  assert.ok(typeof value === "string" && value.trim().length > 0, `${label} is required`);
}

function assertPassed(value: unknown, label: string): void {
  assert.equal(value, "passed", `${label} must have passed`);
}

function assertTimestamp(value: unknown, label: string): void {
  assertNonEmpty(value, `${label} timestamp`);
  assert.equal(Number.isNaN(Date.parse(value)), false, `${label} timestamp is invalid`);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const evidencePath = process.argv[2];
  assertNonEmpty(evidencePath, "release evidence JSON path");
  const evidence = JSON.parse(readFileSync(path.resolve(evidencePath), "utf8")) as unknown;
  validateUnifiedReleaseEvidence(evidence);
  console.log(`unified release evidence passed (${(evidence as ReleaseEvidence).version})`);
}
