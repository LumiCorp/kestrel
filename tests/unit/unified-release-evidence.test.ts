import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_PACKAGES,
  validateUnifiedReleaseEvidence,
} from "../../scripts/check-unified-release-evidence.js";

const checksum = "b".repeat(64);
const timestamp = "2026-08-24T16:00:00.000Z";
const runtimePackage = "@kestrel-agents/kestrel";
const packageVersions = new Map(
  PUBLIC_PACKAGES.map((name, index) => [name, `1.${index}.0`]),
);
packageVersions.set(runtimePackage, "2.4.0");
const flyRoles = [
  "workspace-runtime",
  "environment-router",
  "preview-edge",
  "turn-worker",
  "control-worker",
  "runpod-worker",
  "browser-worker",
];
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("accepts Runtime/CLI-only candidate and cutover evidence", () => {
  const candidate = runtimeCandidate();
  assert.doesNotThrow(() => validateUnifiedReleaseEvidence(candidate));
  const cutover = asCutover(candidate);
  assert.doesNotThrow(() => validateUnifiedReleaseEvidence(cutover));
});

test("accepts one independently targeted npm package", () => {
  const evidence = baselineEvidence();
  evidence.targets.npmPackages = ["@kestrel-agents/files"];
  targetCandidatePackage(evidence, "@kestrel-agents/files");
  assert.doesNotThrow(() => validateUnifiedReleaseEvidence(evidence));
});

test("accepts Desktop-only candidate and cutover at an independent version", () => {
  const candidate = desktopCandidate();
  assert.notEqual(
    candidate.desktop?.version,
    packageVersions.get(runtimePackage),
  );
  assert.doesNotThrow(() => validateUnifiedReleaseEvidence(candidate));
  const cutover = asCutover(candidate);
  assert.ok(cutover.desktop);
  cutover.desktop.ota.stableAfterSha256 = "c".repeat(64);
  cutover.desktop.ota.stableAfterVersion = cutover.desktop.version;
  cutover.desktop.ota.transitions = desktopTransitions(cutover.desktop.version);
  assert.doesNotThrow(() => validateUnifiedReleaseEvidence(cutover));
});

test("accepts a mixed cutover with distinct Runtime, package, Desktop, and Kestrel One versions", () => {
  const evidence = asCutover(runtimeCandidate());
  evidence.targets.npmPackages = ["@kestrel-agents/protocol"];
  evidence.targets.desktop = true;
  evidence.targets.production = true;
  targetCutoverPackage(evidence, "@kestrel-agents/protocol");
  evidence.compatibility.products.desktop = "7.1.0";
  evidence.compatibility.products.kestrelOne = "8.3.0";
  evidence.desktop = desktopSection("7.1.0");
  evidence.desktop.ota.stableAfterSha256 = "c".repeat(64);
  evidence.desktop.ota.stableAfterVersion = "7.1.0";
  evidence.desktop.ota.transitions = desktopTransitions("7.1.0");
  evidence.production = productionSection();
  assert.doesNotThrow(() => validateUnifiedReleaseEvidence(evidence));
});

test("requires production proof only for a production cutover", () => {
  const nonProduction = asCutover(runtimeCandidate());
  assert.doesNotThrow(() => validateUnifiedReleaseEvidence(nonProduction));

  const productionCandidate = baselineEvidence();
  productionCandidate.targets.production = true;
  assert.doesNotThrow(() =>
    validateUnifiedReleaseEvidence(productionCandidate),
  );

  const productionCutover = asCutover(productionCandidate);
  assert.throws(
    () => validateUnifiedReleaseEvidence(productionCutover),
    /production cutover evidence is required/u,
  );
  productionCutover.production = productionSection();
  assert.doesNotThrow(() => validateUnifiedReleaseEvidence(productionCutover));
});

test("rejects legacy v1 and unknown schema shapes", () => {
  assert.throws(
    () =>
      validateUnifiedReleaseEvidence({ phase: "candidate", version: "1.0.0" }),
    /unknown field: version|missing field: schemaVersion/u,
  );
  const evidence = runtimeCandidate();
  evidence.schemaVersion = "kestrel_release_evidence_v1";
  assert.throws(
    () => validateUnifiedReleaseEvidence(evidence),
    /unsupported release evidence schema/u,
  );
});

test("rejects unknown, duplicate, and Runtime npm targets", () => {
  for (const targets of [
    ["@kestrel-agents/unknown"],
    ["@kestrel-agents/files", "@kestrel-agents/files"],
    [runtimePackage],
  ]) {
    const evidence = baselineEvidence();
    evidence.targets.npmPackages = targets;
    assert.throws(
      () => validateUnifiedReleaseEvidence(evidence),
      /unknown|unique|runtimeCli/u,
    );
  }
});

test("requires at least one target and every target's section", () => {
  const empty = baselineEvidence();
  empty.targets.production = false;
  assert.throws(
    () => validateUnifiedReleaseEvidence(empty),
    /at least one release target/u,
  );

  const runtime = runtimeCandidate();
  runtime.runtimeCli = undefined;
  assert.throws(
    () => validateUnifiedReleaseEvidence(runtime),
    /Runtime\/CLI evidence is required/u,
  );

  const desktop = desktopCandidate();
  desktop.desktop = undefined;
  assert.throws(
    () => validateUnifiedReleaseEvidence(desktop),
    /Desktop evidence is required/u,
  );
});

test("rejects evidence sections supplied for non-targets", () => {
  const runtime = baselineEvidence();
  runtime.targets.npmPackages = ["@kestrel-agents/files"];
  targetCandidatePackage(runtime, "@kestrel-agents/files");
  runtime.runtimeCli = runtimeSection();
  assert.throws(
    () => validateUnifiedReleaseEvidence(runtime),
    /Runtime\/CLI evidence supplied for a non-target/u,
  );

  const desktop = runtimeCandidate();
  desktop.desktop = desktopSection("7.1.0");
  assert.throws(
    () => validateUnifiedReleaseEvidence(desktop),
    /Desktop evidence supplied for a non-target/u,
  );

  const production = runtimeCandidate();
  production.production = productionSection();
  assert.throws(
    () => validateUnifiedReleaseEvidence(production),
    /production evidence supplied for a non-target/u,
  );
});

test("rejects stale target tags and staged non-target baselines", () => {
  const candidate = runtimeCandidate();
  const runtime = packageEntry(candidate, runtimePackage);
  runtime.distTags[`release-${runtime.version}`] = "2.3.0";
  assert.throws(
    () => validateUnifiedReleaseEvidence(candidate),
    /staging dist-tag mismatch/u,
  );

  const baseline = runtimeCandidate();
  const files = packageEntry(baseline, "@kestrel-agents/files");
  files.distTags[`release-${files.version}`] = files.version;
  assert.throws(
    () => validateUnifiedReleaseEvidence(baseline),
    /baseline must not have a staging dist-tag/u,
  );
});

test("binds every Runtime/CLI version to the Runtime package", () => {
  const evidence = runtimeCandidate();
  assert.ok(evidence.runtimeCli);
  evidence.runtimeCli.cli.version = "9.9.9";
  assert.throws(
    () => validateUnifiedReleaseEvidence(evidence),
    /CLI archive version mismatch/u,
  );
});

test("rejects mutable production images", () => {
  const evidence = asCutover(baselineEvidence());
  evidence.targets.production = true;
  evidence.production = productionSection();
  evidence.production.fly[0]!.image = "registry.fly.io/kestrel-one:latest";
  assert.throws(
    () => validateUnifiedReleaseEvidence(evidence),
    /image is mutable/u,
  );
});

test("binds Browser worker evidence to the approved image repository", () => {
  const evidence = asCutover(baselineEvidence());
  evidence.targets.production = true;
  evidence.production = productionSection();
  const browser = evidence.production.fly.find(
    ({ role }) => role === "browser-worker",
  );
  assert.ok(browser);
  browser.image = `registry.fly.io/not-kestrel-browser@sha256:${checksum}`;
  assert.throws(
    () => validateUnifiedReleaseEvidence(evidence),
    /browser-worker image must use registry\.fly\.io\/kestrel-one-browser-worker/u,
  );
});

test("requires session-scoped Browser worker canary evidence", () => {
  const evidence = asCutover(baselineEvidence());
  evidence.targets.production = true;
  evidence.production = productionSection();
  evidence.production.canaries = evidence.production.canaries.filter(
    ({ name }) => name !== "browser-worker-session",
  );
  assert.throws(
    () => validateUnifiedReleaseEvidence(evidence),
    /Browser worker session canary evidence is required/u,
  );
});

test("rejects incorrect Desktop candidate pointers and cutover transitions", () => {
  const candidate = desktopCandidate();
  assert.ok(candidate.desktop);
  candidate.desktop.ota.stableAfterSha256 = "c".repeat(64);
  assert.throws(
    () => validateUnifiedReleaseEvidence(candidate),
    /candidate stable Desktop OTA metadata changed/u,
  );

  const cutover = asCutover(desktopCandidate());
  assert.ok(cutover.desktop);
  cutover.desktop.ota.stableAfterVersion = cutover.desktop.version;
  cutover.desktop.ota.transitions = desktopTransitions("9.9.9");
  assert.throws(
    () => validateUnifiedReleaseEvidence(cutover),
    /Desktop OTA target version mismatch/u,
  );
});

test("rejects incomplete compatibility inventory and unknown fields", () => {
  const incomplete = runtimeCandidate();
  incomplete.compatibility.npmPackages =
    incomplete.compatibility.npmPackages.filter(
      ({ name }) => name !== "@kestrel-agents/files",
    );
  assert.throws(
    () => validateUnifiedReleaseEvidence(incomplete),
    /incomplete or duplicated/u,
  );

  const unknown = runtimeCandidate() as Record<string, unknown>;
  unknown.version = "2.4.0";
  assert.throws(
    () => validateUnifiedReleaseEvidence(unknown),
    /unknown field: version/u,
  );
});

test("CLI validates checked-in candidate and cutover fixtures", () => {
  for (const fixture of ["v2-candidate.json", "v2-cutover.json"]) {
    const fixturePath = path.join("tests/fixtures/release-evidence", fixture);
    const parsed = JSON.parse(
      readFileSync(path.join(repoRoot, fixturePath), "utf8"),
    ) as unknown;
    assert.doesNotThrow(() => validateUnifiedReleaseEvidence(parsed));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/check-unified-release-evidence.ts",
        fixturePath,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /targeted release evidence passed/u);
  }
});

function baselineEvidence() {
  return {
    schemaVersion: "kestrel_release_evidence_v2",
    releaseId: "release-2026-08-24-001",
    phase: "candidate" as "candidate" | "cutover",
    targets: {
      runtimeCli: false,
      npmPackages: [] as string[],
      desktop: false,
      production: false,
    },
    compatibility: {
      npmPackages: PUBLIC_PACKAGES.map((name) => ({
        name,
        version: packageVersions.get(name)!,
        integrity: "sha512-YWJjZA==",
        distTags: { latest: packageVersions.get(name)! } as Record<
          string,
          string
        >,
      })),
      products: { desktop: "7.1.0", kestrelOne: "8.3.0" },
    },
    runtimeCli: undefined as ReturnType<typeof runtimeSection> | undefined,
    desktop: undefined as ReturnType<typeof desktopSection> | undefined,
    production: undefined as ReturnType<typeof productionSection> | undefined,
  };
}

function runtimeCandidate() {
  const evidence = baselineEvidence();
  evidence.targets.runtimeCli = true;
  evidence.runtimeCli = runtimeSection();
  targetCandidatePackage(evidence, runtimePackage);
  return evidence;
}

function desktopCandidate() {
  const evidence = baselineEvidence();
  evidence.targets.desktop = true;
  evidence.desktop = desktopSection(evidence.compatibility.products.desktop);
  return evidence;
}

function asCutover<T extends ReturnType<typeof baselineEvidence>>(input: T): T {
  const evidence = structuredClone(input);
  evidence.phase = "cutover";
  if (evidence.targets.runtimeCli)
    targetCutoverPackage(evidence, runtimePackage);
  for (const name of evidence.targets.npmPackages)
    targetCutoverPackage(evidence, name);
  return evidence;
}

function targetCandidatePackage(
  evidence: ReturnType<typeof baselineEvidence>,
  name: string,
): void {
  const entry = packageEntry(evidence, name);
  entry.distTags.latest = previousVersion(entry.version);
  entry.distTags[`release-${entry.version}`] = entry.version;
}

function targetCutoverPackage(
  evidence: ReturnType<typeof baselineEvidence>,
  name: string,
): void {
  const entry = packageEntry(evidence, name);
  entry.distTags.latest = entry.version;
}

function packageEntry(
  evidence: ReturnType<typeof baselineEvidence>,
  name: string,
) {
  const entry = evidence.compatibility.npmPackages.find(
    (candidate) => candidate.name === name,
  );
  assert.ok(entry);
  return entry;
}

function previousVersion(version: string): string {
  const [major, minor] = version.split(".").map(Number);
  return `${major}.${Math.max(0, minor! - 1)}.0`;
}

function runtimeSection() {
  const version = packageVersions.get(runtimePackage)!;
  return {
    version,
    consumerSmokes: ["darwin-arm64", "linux-x64"].map((platform) => ({
      platform,
      version,
      status: "passed",
      completedAt: timestamp,
    })),
    cli: { platform: "darwin-arm64", version, archiveSha256: checksum },
  };
}

function desktopSection(version: string) {
  return {
    version,
    artifacts: ["dmg", "zip"].map((type) => ({ type, sha256: checksum })),
    signingIdentity: "Developer ID Application: Lumi",
    notarization: "passed",
    gatekeeper: "passed",
    launchServices: "passed",
    ota: {
      stableBeforeVersion: "6.9.0",
      stableAfterVersion: "6.9.0",
      stableBeforeSha256: checksum,
      stableAfterSha256: checksum,
      transitions: [] as ReturnType<typeof desktopTransitions>,
    },
  };
}

function desktopTransitions(toVersion: string) {
  return ["0.7.0", "0.8.0"].map((fromVersion) => ({
    fromVersion,
    toVersion,
    status: "passed",
    completedAt: timestamp,
  }));
}

function productionSection() {
  return {
    deployments: {
      kestrelOne: { deploymentId: "dpl_one", status: "passed" },
      docs: { deploymentId: "dpl_docs", status: "passed" },
    },
    migrations: { preflightStatus: "passed", applied: ["0001_release"] },
    fly: flyRoles.map((role) => ({
      role,
      image:
        role === "browser-worker"
          ? `registry.fly.io/kestrel-one-browser-worker@sha256:${checksum}`
          : `registry.fly.io/kestrel-one@sha256:${checksum}`,
      smoke: { status: "passed", completedAt: timestamp },
    })),
    canaries: [
      { name: "kestrel-one-hosted", status: "passed", completedAt: timestamp },
      { name: "docs-production", status: "passed", completedAt: timestamp },
      {
        name: "browser-worker-session",
        status: "passed",
        completedAt: timestamp,
      },
    ],
  };
}
