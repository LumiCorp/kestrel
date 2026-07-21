import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  RUHROH_PACKAGE_NAME,
  RUHROH_RELEASE_SHA256,
  RUHROH_RELEASE_VERSION,
  resolveRuhrohInvocation,
  validateEvaluationOwnershipLedger,
} from "../../scripts/validate-ruhroh-evals.js";
import { contractTest } from "../helpers/contract-test.js";


const ROOT = process.cwd();

contractTest("runtime.hermetic", "evaluation ownership ledger covers Ruhroh scenarios and evidenced runtime replacements", async () => {
  const validation = await validateEvaluationOwnershipLedger(ROOT);

  assert.deepEqual(validation.errors, []);
  assert.equal(validation.behaviorCount, 16);
  assert.equal(validation.ruhrohScenarioCount, 8);
  assert.equal(validation.runtimeTestCount, 8);
  assert.equal(validation.parityRecordCount, 8);

  const ledger = JSON.parse(
    await readFile(path.join(ROOT, "evals", "migration", "ownership-ledger.json"), "utf8"),
  ) as {
    behaviors: Array<{
      disposition: "ruhroh" | "runtime_test";
      parityStatus: string;
      parityRecord?: string;
      replacementTests?: unknown[];
    }>;
  };
  const runtimeTests = ledger.behaviors.filter((entry) => entry.disposition === "runtime_test");
  const ruhrohScenarios = ledger.behaviors.filter((entry) => entry.disposition === "ruhroh");
  assert.equal(runtimeTests.every((entry) => entry.parityStatus === "passed"), true);
  assert.equal(runtimeTests.every((entry) => (entry.replacementTests?.length ?? 0) > 0), true);
  assert.equal(ruhrohScenarios.every((entry) => entry.parityStatus === "passed"), true);
  assert.equal(ruhrohScenarios.every((entry) => entry.parityRecord?.startsWith("evals/migration/parity/") === true), true);
});

contractTest("runtime.hermetic", "Ruhroh parity records prove all semantic dimensions through the maintained native-session adapter", async () => {
  const recordPaths = (await walk(path.join(ROOT, "evals", "migration", "parity")))
    .filter((filePath) => filePath.endsWith(".json"));
  assert.equal(recordPaths.length, 8);
  const packageArtifactHashes = new Set<string>();

  for (const recordPath of recordPaths) {
    const raw = await readFile(recordPath, "utf8");
    const record = JSON.parse(raw) as {
      version: string;
      behaviorId: string;
      status: string;
      fixture: { legacyFixtureSha256: string };
      runtimes: {
        ruhroh: {
          version: string;
          source: string;
          packageArtifactSha256: string;
          adapterId: string;
          adapterVersion: string;
          continuityLevel: string;
          evaluatorMode: string;
        };
      };
      contractProbes: {
        cancellation: {
          expected: { cancelled: boolean; failureClassification: string };
          ruhroh: { cancelled: boolean; failureClassification: string; outcome: string };
        };
      };
      comparison: Record<string, { status: string }>;
      artifacts: Array<{ name: string; sha256: string }>;
    };
    assert.equal(record.version, "kestrel_ruhroh_parity_record_v1");
    assert.equal(record.behaviorId, path.basename(recordPath, ".json"));
    assert.match(record.fixture.legacyFixtureSha256, /^[a-f0-9]{64}$/u);
    assert.equal(record.status, "passed");
    assert.equal(record.runtimes.ruhroh.version, RUHROH_RELEASE_VERSION);
    assert.equal(record.runtimes.ruhroh.source, "installed-package");
    assert.equal(record.runtimes.ruhroh.packageArtifactSha256, RUHROH_RELEASE_SHA256);
    packageArtifactHashes.add(record.runtimes.ruhroh.packageArtifactSha256);
    assert.equal(record.runtimes.ruhroh.adapterId, "kestrel-cli");
    assert.equal(record.runtimes.ruhroh.adapterVersion, "0.1.0");
    assert.equal(record.runtimes.ruhroh.continuityLevel, "native_session");
    assert.equal(record.runtimes.ruhroh.evaluatorMode, "deterministic-fixture-with-independent-semantic-comparison");
    assert.deepEqual(
      Object.fromEntries(Object.entries(record.comparison).map(([name, result]) => [name, result.status])),
      {
        outcome: "passed",
        evidence: "passed",
        cancellation: "passed",
        failureClassification: "passed",
      },
    );
    assert.equal(record.contractProbes.cancellation.expected.cancelled, true);
    assert.equal(record.contractProbes.cancellation.ruhroh.cancelled, true);
    assert.equal(record.contractProbes.cancellation.ruhroh.outcome, "failed");
    assert.equal(record.contractProbes.cancellation.expected.failureClassification, "cancelled");
    assert.equal(record.contractProbes.cancellation.ruhroh.failureClassification, "cancelled");
    assert.equal(record.artifacts.some((artifact) => artifact.name === "jobInput"), true);
    assert.equal(record.artifacts.some((artifact) => artifact.name === "eventLog"), true);
    assert.equal(record.artifacts.some((artifact) => artifact.name === "cancellation.loopResult"), true);
    assert.equal(record.artifacts.every((artifact) => /^[a-f0-9]{64}$/u.test(artifact.sha256)), true);
    assert.doesNotMatch(raw, /\/Users\/|\/private\/|kestrel-ruhroh-parity-/u);
  }
  assert.equal(packageArtifactHashes.size, 1);
});

contractTest("runtime.hermetic", "Kestrel installs the exact released Ruhroh evaluator", async () => {
  const rootPackage = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  assert.equal(rootPackage.devDependencies?.[RUHROH_PACKAGE_NAME], RUHROH_RELEASE_VERSION);

  const installedPackage = JSON.parse(
    await readFile(path.join(ROOT, "node_modules", "@kestrel-agents", "ruhroh", "package.json"), "utf8"),
  ) as { name?: string; version?: string };
  assert.equal(installedPackage.name, RUHROH_PACKAGE_NAME);
  assert.equal(installedPackage.version, RUHROH_RELEASE_VERSION);
  assert.equal(
    resolveRuhrohInvocation(ROOT).source,
    `installed ${RUHROH_PACKAGE_NAME}@${RUHROH_RELEASE_VERSION}`,
  );
});

contractTest("runtime.hermetic", "Kestrel eval targets reference Ruhroh's maintained adapter without copying it", async () => {
  const target = JSON.parse(
    await readFile(path.join(ROOT, "evals", "targets", "kestrel-reference.json"), "utf8"),
  ) as { targets: Array<{ adapterId?: string; adapterCommand?: string }> };
  assert.equal(target.targets.length, 1);
  assert.equal(target.targets[0]?.adapterId, "kestrel-cli");
  assert.equal(target.targets[0]?.adapterCommand, undefined);

  const evalFiles = await walk(path.join(ROOT, "evals"));
  assert.equal(evalFiles.some((filePath) => path.basename(filePath) === "run.sh"), false);
});

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(filePath));
    } else if (entry.isFile()) {
      files.push(filePath);
    }
  }
  return files;
}
