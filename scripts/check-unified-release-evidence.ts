import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PUBLIC_PACKAGES = [
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
] as const;

const RUNTIME_PACKAGE = "@kestrel-agents/kestrel";
const INDEPENDENT_NPM_PACKAGES = PUBLIC_PACKAGES.filter(
  (name) => name !== RUNTIME_PACKAGE,
);
const FLY_ROLES = [
  "workspace-runtime",
  "environment-router",
  "preview-edge",
  "turn-worker",
  "control-worker",
  "runpod-worker",
] as const;
const DESKTOP_OTA_FROM_VERSIONS = ["0.7.0", "0.8.0"] as const;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/u;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/u;
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/=]+$/u;
const IMMUTABLE_PRODUCTION_IMAGE_PATTERN =
  /^(?:registry\.fly\.io|ghcr\.io)\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u;

interface PackageEvidence {
  distTags: Record<string, string>;
  integrity: string;
  name: string;
  version: string;
}

interface RuntimeCliEvidence {
  cli: { archiveSha256: string; platform: string; version: string };
  consumerSmokes: Array<{
    completedAt: string;
    platform: string;
    status: string;
    version: string;
  }>;
  version: string;
}

interface DesktopEvidence {
  artifacts: Array<{ sha256: string; type: string }>;
  gatekeeper: string;
  launchServices: string;
  notarization: string;
  ota: {
    stableAfterSha256: string;
    stableAfterVersion: string;
    stableBeforeSha256: string;
    stableBeforeVersion: string;
    transitions: Array<{
      completedAt: string;
      fromVersion: string;
      status: string;
      toVersion: string;
    }>;
  };
  signingIdentity: string;
  version: string;
}

interface ProductionEvidence {
  canaries: Array<{ completedAt: string; name: string; status: string }>;
  deployments: Record<
    "docs" | "kestrelOne",
    { deploymentId: string; status: string }
  >;
  fly: Array<{
    image: string;
    role: string;
    smoke: { completedAt: string; status: string };
  }>;
  migrations: { applied: string[]; preflightStatus: string };
}

interface ReleaseEvidenceV2 {
  compatibility: {
    npmPackages: PackageEvidence[];
    products: { desktop: string; kestrelOne: string };
  };
  desktop?: DesktopEvidence;
  phase: "candidate" | "cutover";
  production?: ProductionEvidence;
  releaseId: string;
  runtimeCli?: RuntimeCliEvidence;
  schemaVersion: "kestrel_release_evidence_v2";
  targets: {
    desktop: boolean;
    npmPackages: string[];
    production: boolean;
    runtimeCli: boolean;
  };
}

export function validateUnifiedReleaseEvidence(input: unknown): void {
  const evidence = parseReleaseEvidenceV2(input);
  const targetedPackages = new Set(evidence.targets.npmPackages);
  if (evidence.targets.runtimeCli) targetedPackages.add(RUNTIME_PACKAGE);

  for (const packageEvidence of evidence.compatibility.npmPackages) {
    const targeted = targetedPackages.has(packageEvidence.name);
    const stagingTag = `release-${packageEvidence.version}`;
    if (targeted && evidence.phase === "candidate") {
      assert.equal(
        packageEvidence.distTags[stagingTag],
        packageEvidence.version,
        `${packageEvidence.name} staging dist-tag mismatch`,
      );
    }
    if (targeted && evidence.phase === "cutover") {
      assert.equal(
        packageEvidence.distTags.latest,
        packageEvidence.version,
        `${packageEvidence.name} latest dist-tag mismatch`,
      );
    }
    if (!targeted) {
      assert.equal(
        packageEvidence.distTags.latest,
        packageEvidence.version,
        `${packageEvidence.name} compatibility baseline latest dist-tag mismatch`,
      );
      assert.equal(
        packageEvidence.distTags[stagingTag],
        undefined,
        `${packageEvidence.name} compatibility baseline must not have a staging dist-tag`,
      );
    }
  }

  validateRuntimeCliTarget(evidence);
  validateDesktopTarget(evidence);
  validateProductionTarget(evidence);
}

function parseReleaseEvidenceV2(input: unknown): ReleaseEvidenceV2 {
  assertRecord(input, "release evidence");
  assertExactKeys(
    input,
    [
      "schemaVersion",
      "releaseId",
      "phase",
      "targets",
      "compatibility",
      "runtimeCli",
      "desktop",
      "production",
    ],
    ["runtimeCli", "desktop", "production"],
    "release evidence",
  );
  assert.equal(
    input.schemaVersion,
    "kestrel_release_evidence_v2",
    "unsupported release evidence schema",
  );
  assertNonEmpty(input.releaseId, "release ID");
  assert.ok(
    input.phase === "candidate" || input.phase === "cutover",
    "release phase is invalid",
  );

  assertRecord(input.targets, "release targets");
  assertExactKeys(
    input.targets,
    ["runtimeCli", "npmPackages", "desktop", "production"],
    [],
    "release targets",
  );
  assertBoolean(input.targets.runtimeCli, "Runtime/CLI target");
  assertBoolean(input.targets.desktop, "Desktop target");
  assertBoolean(input.targets.production, "production target");
  assertStringArray(input.targets.npmPackages, "npm package targets");
  assert.equal(
    new Set(input.targets.npmPackages).size,
    input.targets.npmPackages.length,
    "npm package targets must be unique",
  );
  for (const name of input.targets.npmPackages) {
    assert.ok(
      name !== RUNTIME_PACKAGE,
      `${RUNTIME_PACKAGE} must be targeted through runtimeCli`,
    );
    assert.ok(
      (INDEPENDENT_NPM_PACKAGES as readonly string[]).includes(name),
      `unknown npm package target: ${name}`,
    );
  }
  assert.ok(
    input.targets.runtimeCli ||
      input.targets.npmPackages.length > 0 ||
      input.targets.desktop ||
      input.targets.production,
    "at least one release target is required",
  );

  assertRecord(input.compatibility, "compatibility inventory");
  assertExactKeys(
    input.compatibility,
    ["npmPackages", "products"],
    [],
    "compatibility inventory",
  );
  const npmPackages = parsePackageInventory(input.compatibility.npmPackages);
  assertRecord(input.compatibility.products, "product compatibility inventory");
  assertExactKeys(
    input.compatibility.products,
    ["desktop", "kestrelOne"],
    [],
    "product compatibility inventory",
  );
  assertSemver(
    input.compatibility.products.desktop,
    "Desktop compatibility version",
  );
  assertSemver(
    input.compatibility.products.kestrelOne,
    "Kestrel One compatibility version",
  );

  const evidence: ReleaseEvidenceV2 = {
    schemaVersion: input.schemaVersion,
    releaseId: input.releaseId,
    phase: input.phase,
    targets: input.targets as unknown as ReleaseEvidenceV2["targets"],
    compatibility: {
      npmPackages,
      products: input.compatibility
        .products as unknown as ReleaseEvidenceV2["compatibility"]["products"],
    },
  };
  if (input.runtimeCli !== undefined)
    evidence.runtimeCli = parseRuntimeCli(input.runtimeCli);
  if (input.desktop !== undefined)
    evidence.desktop = parseDesktop(input.desktop);
  if (input.production !== undefined)
    evidence.production = parseProduction(input.production);
  return evidence;
}

function parsePackageInventory(value: unknown): PackageEvidence[] {
  assert.ok(
    Array.isArray(value),
    "compatibility npm packages must be an array",
  );
  assertExactNames(
    value,
    PUBLIC_PACKAGES,
    (entry) => {
      assertRecord(entry, "npm package evidence");
      return asString(entry.name, "npm package name");
    },
    "compatibility npm packages",
  );
  return value.map((entry) => {
    assertRecord(entry, "npm package evidence");
    assertExactKeys(
      entry,
      ["name", "version", "integrity", "distTags"],
      [],
      "npm package evidence",
    );
    const name = asString(entry.name, "npm package name");
    assertSemver(entry.version, `${name} version`);
    assert.match(
      asString(entry.integrity, `${name} integrity`),
      INTEGRITY_PATTERN,
    );
    assertRecord(entry.distTags, `${name} dist-tags`);
    for (const [tag, version] of Object.entries(entry.distTags)) {
      assertNonEmpty(tag, `${name} dist-tag name`);
      assertSemver(version, `${name} dist-tag ${tag}`);
    }
    return entry as unknown as PackageEvidence;
  });
}

function parseRuntimeCli(value: unknown): RuntimeCliEvidence {
  assertRecord(value, "Runtime/CLI evidence");
  assertExactKeys(
    value,
    ["version", "consumerSmokes", "cli"],
    [],
    "Runtime/CLI evidence",
  );
  assertSemver(value.version, "Runtime/CLI version");
  assert.ok(
    Array.isArray(value.consumerSmokes),
    "Runtime consumer smokes must be an array",
  );
  assertExactNames(
    value.consumerSmokes,
    ["darwin-arm64", "linux-x64"],
    (entry) => {
      assertRecord(entry, "Runtime consumer smoke");
      return asString(entry.platform, "Runtime consumer smoke platform");
    },
    "Runtime consumer platforms",
  );
  for (const smoke of value.consumerSmokes) {
    assertRecord(smoke, "Runtime consumer smoke");
    assertExactKeys(
      smoke,
      ["platform", "version", "status", "completedAt"],
      [],
      "Runtime consumer smoke",
    );
    assertSemver(
      smoke.version,
      `Runtime consumer smoke ${String(smoke.platform)} version`,
    );
    assertPassed(
      smoke.status,
      `Runtime consumer smoke ${String(smoke.platform)}`,
    );
    assertTimestamp(
      smoke.completedAt,
      `Runtime consumer smoke ${String(smoke.platform)}`,
    );
  }
  assertRecord(value.cli, "CLI archive evidence");
  assertExactKeys(
    value.cli,
    ["platform", "version", "archiveSha256"],
    [],
    "CLI archive evidence",
  );
  assert.equal(
    value.cli.platform,
    "darwin-arm64",
    "CLI archive platform mismatch",
  );
  assertSemver(value.cli.version, "CLI archive version");
  assert.match(
    asString(value.cli.archiveSha256, "CLI archive checksum"),
    CHECKSUM_PATTERN,
  );
  return value as unknown as RuntimeCliEvidence;
}

function parseDesktop(value: unknown): DesktopEvidence {
  assertRecord(value, "Desktop evidence");
  assertExactKeys(
    value,
    [
      "version",
      "artifacts",
      "signingIdentity",
      "notarization",
      "gatekeeper",
      "launchServices",
      "ota",
    ],
    [],
    "Desktop evidence",
  );
  assertSemver(value.version, "Desktop version");
  assertNonEmpty(value.signingIdentity, "Desktop signing identity");
  assertPassed(value.notarization, "Desktop notarization");
  assertPassed(value.gatekeeper, "Desktop Gatekeeper");
  assertPassed(value.launchServices, "Desktop LaunchServices");
  assert.ok(
    Array.isArray(value.artifacts),
    "Desktop artifacts must be an array",
  );
  assertExactNames(
    value.artifacts,
    ["dmg", "zip"],
    (entry) => {
      assertRecord(entry, "Desktop artifact");
      return asString(entry.type, "Desktop artifact type");
    },
    "Desktop artifacts",
  );
  for (const artifact of value.artifacts) {
    assertRecord(artifact, "Desktop artifact");
    assertExactKeys(artifact, ["type", "sha256"], [], "Desktop artifact");
    assert.match(
      asString(artifact.sha256, `${String(artifact.type)} checksum`),
      CHECKSUM_PATTERN,
    );
  }
  assertRecord(value.ota, "Desktop OTA evidence");
  assertExactKeys(
    value.ota,
    [
      "stableBeforeVersion",
      "stableAfterVersion",
      "stableBeforeSha256",
      "stableAfterSha256",
      "transitions",
    ],
    [],
    "Desktop OTA evidence",
  );
  assertSemver(value.ota.stableBeforeVersion, "Desktop stable before version");
  assertSemver(value.ota.stableAfterVersion, "Desktop stable after version");
  assert.match(
    asString(value.ota.stableBeforeSha256, "Desktop stable before checksum"),
    CHECKSUM_PATTERN,
  );
  assert.match(
    asString(value.ota.stableAfterSha256, "Desktop stable after checksum"),
    CHECKSUM_PATTERN,
  );
  assert.ok(
    Array.isArray(value.ota.transitions),
    "Desktop OTA transitions must be an array",
  );
  for (const transition of value.ota.transitions) {
    assertRecord(transition, "Desktop OTA transition");
    assertExactKeys(
      transition,
      ["fromVersion", "toVersion", "status", "completedAt"],
      [],
      "Desktop OTA transition",
    );
    assertSemver(transition.fromVersion, "Desktop OTA source version");
    assertSemver(transition.toVersion, "Desktop OTA target version");
    assertPassed(
      transition.status,
      `Desktop OTA ${String(transition.fromVersion)}`,
    );
    assertTimestamp(
      transition.completedAt,
      `Desktop OTA ${String(transition.fromVersion)}`,
    );
  }
  return value as unknown as DesktopEvidence;
}

function parseProduction(value: unknown): ProductionEvidence {
  assertRecord(value, "production evidence");
  assertExactKeys(
    value,
    ["deployments", "migrations", "fly", "canaries"],
    [],
    "production evidence",
  );
  assertRecord(value.deployments, "deployment evidence");
  assertExactKeys(
    value.deployments,
    ["docs", "kestrelOne"],
    [],
    "deployment evidence",
  );
  for (const [name, deployment] of Object.entries(value.deployments)) {
    assertRecord(deployment, `${name} deployment`);
    assertExactKeys(
      deployment,
      ["deploymentId", "status"],
      [],
      `${name} deployment`,
    );
    assertNonEmpty(deployment.deploymentId, `${name} deployment ID`);
    assertPassed(deployment.status, `${name} deployment`);
  }
  assertRecord(value.migrations, "migration evidence");
  assertExactKeys(
    value.migrations,
    ["preflightStatus", "applied"],
    [],
    "migration evidence",
  );
  assertPassed(value.migrations.preflightStatus, "migration preflight");
  assertStringArray(value.migrations.applied, "applied migrations");
  assert.equal(
    new Set(value.migrations.applied).size,
    value.migrations.applied.length,
    "applied migrations must be unique",
  );
  for (const migration of value.migrations.applied)
    assertNonEmpty(migration, "applied migration identifier");

  assert.ok(
    Array.isArray(value.fly),
    "production image roles must be an array",
  );
  assertExactNames(
    value.fly,
    FLY_ROLES,
    (entry) => {
      assertRecord(entry, "production image role");
      return asString(entry.role, "production image role name");
    },
    "production image roles",
  );
  for (const component of value.fly) {
    assertRecord(component, "production image role");
    assertExactKeys(
      component,
      ["role", "image", "smoke"],
      [],
      "production image role",
    );
    assert.match(
      asString(component.image, `${String(component.role)} image`),
      IMMUTABLE_PRODUCTION_IMAGE_PATTERN,
      `${String(component.role)} image is mutable`,
    );
    assertRecord(component.smoke, `${String(component.role)} smoke`);
    assertExactKeys(
      component.smoke,
      ["status", "completedAt"],
      [],
      `${String(component.role)} smoke`,
    );
    assertPassed(component.smoke.status, `${String(component.role)} smoke`);
    assertTimestamp(
      component.smoke.completedAt,
      `${String(component.role)} smoke`,
    );
  }

  assert.ok(
    Array.isArray(value.canaries) && value.canaries.length > 0,
    "hosted canary evidence is required",
  );
  const canaryNames = new Set<string>();
  for (const canary of value.canaries) {
    assertRecord(canary, "hosted canary");
    assertExactKeys(
      canary,
      ["name", "status", "completedAt"],
      [],
      "hosted canary",
    );
    const name = asString(canary.name, "canary name");
    assert.ok(!canaryNames.has(name), "canary names must be unique");
    canaryNames.add(name);
    assertPassed(canary.status, `canary ${name}`);
    assertTimestamp(canary.completedAt, `canary ${name}`);
  }
  return value as unknown as ProductionEvidence;
}

function validateRuntimeCliTarget(evidence: ReleaseEvidenceV2): void {
  if (!evidence.targets.runtimeCli) {
    assert.equal(
      evidence.runtimeCli,
      undefined,
      "Runtime/CLI evidence supplied for a non-target",
    );
    return;
  }
  assert.ok(evidence.runtimeCli, "Runtime/CLI evidence is required");
  const runtimePackage = evidence.compatibility.npmPackages.find(
    ({ name }) => name === RUNTIME_PACKAGE,
  );
  assert.ok(runtimePackage);
  assert.equal(
    evidence.runtimeCli.version,
    runtimePackage.version,
    "Runtime/CLI version mismatch",
  );
  assert.equal(
    evidence.runtimeCli.cli.version,
    runtimePackage.version,
    "CLI archive version mismatch",
  );
  for (const smoke of evidence.runtimeCli.consumerSmokes) {
    assert.equal(
      smoke.version,
      runtimePackage.version,
      `Runtime consumer smoke ${smoke.platform} version mismatch`,
    );
  }
}

function validateDesktopTarget(evidence: ReleaseEvidenceV2): void {
  if (!evidence.targets.desktop) {
    assert.equal(
      evidence.desktop,
      undefined,
      "Desktop evidence supplied for a non-target",
    );
    return;
  }
  assert.ok(evidence.desktop, "Desktop evidence is required");
  assert.equal(
    evidence.desktop.version,
    evidence.compatibility.products.desktop,
    "Desktop compatibility version mismatch",
  );
  const ota = evidence.desktop.ota;
  if (evidence.phase === "candidate") {
    assert.equal(
      ota.stableAfterSha256,
      ota.stableBeforeSha256,
      "candidate stable Desktop OTA metadata changed",
    );
    assert.equal(
      ota.stableAfterVersion,
      ota.stableBeforeVersion,
      "candidate stable Desktop OTA version changed",
    );
    return;
  }
  assert.equal(
    ota.stableAfterVersion,
    evidence.desktop.version,
    "cutover stable Desktop OTA version mismatch",
  );
  assertExactNames(
    ota.transitions,
    DESKTOP_OTA_FROM_VERSIONS,
    ({ fromVersion }) => fromVersion,
    "Desktop OTA transitions",
  );
  for (const transition of ota.transitions) {
    assert.equal(
      transition.toVersion,
      evidence.desktop.version,
      "Desktop OTA target version mismatch",
    );
  }
}

function validateProductionTarget(evidence: ReleaseEvidenceV2): void {
  if (!evidence.targets.production) {
    assert.equal(
      evidence.production,
      undefined,
      "production evidence supplied for a non-target",
    );
    return;
  }
  if (evidence.phase === "candidate") {
    assert.equal(
      evidence.production,
      undefined,
      "candidate production evidence is not allowed before cutover",
    );
    return;
  }
  assert.ok(evidence.production, "production cutover evidence is required");
}

function assertExactNames<T>(
  values: readonly T[],
  expected: readonly string[],
  select: (value: T) => string,
  label: string,
): void {
  assert.ok(Array.isArray(values), `${label} must be an array`);
  assert.deepEqual(
    values.map(select).sort(),
    [...expected].sort(),
    `${label} are incomplete or duplicated`,
  );
}

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  for (const key of Object.keys(value))
    assert.ok(allowedSet.has(key), `${label} has unknown field: ${key}`);
  for (const key of allowed) {
    if (!optionalSet.has(key))
      assert.ok(Object.hasOwn(value, key), `${label} is missing field: ${key}`);
  }
}

function assertStringArray(
  value: unknown,
  label: string,
): asserts value is string[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  for (const entry of value) assertNonEmpty(entry, `${label} entry`);
}

function assertBoolean(
  value: unknown,
  label: string,
): asserts value is boolean {
  assert.equal(typeof value, "boolean", `${label} must be a boolean`);
}

function assertNonEmpty(
  value: unknown,
  label: string,
): asserts value is string {
  assert.ok(
    typeof value === "string" && value.trim().length > 0,
    `${label} is required`,
  );
}

function asString(value: unknown, label: string): string {
  assertNonEmpty(value, label);
  return value;
}

function assertSemver(value: unknown, label: string): asserts value is string {
  assert.match(
    asString(value, label),
    SEMVER_PATTERN,
    `${label} must be numeric semver`,
  );
}

function assertPassed(value: unknown, label: string): void {
  assert.equal(value, "passed", `${label} must have passed`);
}

function assertTimestamp(value: unknown, label: string): void {
  assertNonEmpty(value, `${label} timestamp`);
  assert.equal(
    Number.isNaN(Date.parse(value)),
    false,
    `${label} timestamp is invalid`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const evidencePath = process.argv[2];
  assertNonEmpty(evidencePath, "release evidence JSON path");
  const evidence = JSON.parse(
    readFileSync(path.resolve(evidencePath), "utf8"),
  ) as unknown;
  validateUnifiedReleaseEvidence(evidence);
  assertRecord(evidence, "release evidence");
  console.log(
    `targeted release evidence passed (${String(evidence.releaseId)})`,
  );
}
