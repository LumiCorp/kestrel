import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type EvaluationDisposition = "ruhroh" | "runtime_test";
type EvaluationParityStatus = "pending_execution" | "pending_independent_test" | "passed";

interface ReplacementTestEvidence {
  path: string;
  testName?: string | undefined;
  promptSuiteCase?: string | undefined;
}

export interface EvaluationOwnershipEntry {
  behaviorId: string;
  disposition: EvaluationDisposition;
  ruhrohScenarioId?: string | undefined;
  replacement?: string | undefined;
  replacementTests?: ReplacementTestEvidence[] | undefined;
  parityRecord?: string | undefined;
  parityStatus: EvaluationParityStatus;
}

interface EvaluationOwnershipLedger {
  version: string;
  behaviors: EvaluationOwnershipEntry[];
}

interface RuhrohInvocation {
  command: string;
  argsPrefix: string[];
  source: string;
}

export interface EvaluationOwnershipValidation {
  errors: string[];
  behaviorCount: number;
  ruhrohScenarioCount: number;
  runtimeTestCount: number;
  parityRecordCount: number;
}

const LEDGER_VERSION = "kestrel_evaluation_ownership_v1";
const LEDGER_PATH = path.join("evals", "migration", "ownership-ledger.json");
const SCENARIO_ROOT = path.join("evals", "scenarios");
const SUITE_ROOT = path.join("evals", "suites");
const SUITE_ID = "kestrel-0.6-live";
const TARGET_PATH = path.join("evals", "targets", "kestrel-reference.json");
const PARITY_RECORD_VERSION = "kestrel_ruhroh_parity_record_v1";
const PARITY_RECORD_ROOT = path.join("evals", "migration", "parity");
const PARITY_DIMENSIONS = ["outcome", "evidence", "cancellation", "failureClassification"] as const;
export const RUHROH_PACKAGE_NAME = "@kestrel-agents/ruhroh";
export const RUHROH_RELEASE_VERSION = "0.6.0-beta.0";
export const RUHROH_RELEASE_SHA256 = "f8c68df2605d658796387430a7475f7b9c8ee92c5c1d5d1a7c8c635a6022f89f";

export async function validateEvaluationOwnershipLedger(
  root = process.cwd(),
): Promise<EvaluationOwnershipValidation> {
  const errors: string[] = [];
  const rootPackage = await readJson<{ devDependencies?: Record<string, unknown> }>(
    path.join(root, "package.json"),
  );
  if (rootPackage.devDependencies?.[RUHROH_PACKAGE_NAME] !== RUHROH_RELEASE_VERSION) {
    errors.push(`${RUHROH_PACKAGE_NAME} must be pinned exactly to ${RUHROH_RELEASE_VERSION}`);
  }
  const ledger = await readJson<EvaluationOwnershipLedger>(path.join(root, LEDGER_PATH));
  if (ledger.version !== LEDGER_VERSION) {
    errors.push(`ownership ledger version must be ${LEDGER_VERSION}`);
  }
  if (!Array.isArray(ledger.behaviors)) {
    return {
      errors: ["ownership ledger behaviors must be an array"],
      behaviorCount: 0,
      ruhrohScenarioCount: 0,
      runtimeTestCount: 0,
      parityRecordCount: 0,
    };
  }

  const duplicateBehaviorIds = duplicates(ledger.behaviors.map((entry) => entry.behaviorId));
  for (const behaviorId of duplicateBehaviorIds) {
    errors.push(`duplicate ownership behaviorId: ${behaviorId}`);
  }

  const expectedRuhrohIds: string[] = [];
  const expectedParityRecords: string[] = [];
  for (const entry of ledger.behaviors) {
    if (entry.disposition === "ruhroh") {
      if (entry.parityStatus === "pending_independent_test") {
        errors.push(`${entry.behaviorId} Ruhroh disposition cannot use pending_independent_test`);
      }
      if (entry.ruhrohScenarioId === undefined || entry.ruhrohScenarioId.trim().length === 0) {
        errors.push(`${entry.behaviorId} is missing ruhrohScenarioId`);
        continue;
      }
      if (entry.replacementTests !== undefined) {
        errors.push(`${entry.behaviorId} Ruhroh disposition cannot declare replacementTests`);
      }
      expectedRuhrohIds.push(entry.ruhrohScenarioId);
      const scenarioPath = path.join(root, SCENARIO_ROOT, entry.ruhrohScenarioId, "scenario.json");
      const instructionPath = path.join(root, SCENARIO_ROOT, entry.ruhrohScenarioId, "instruction.md");
      if (!existsSync(scenarioPath)) {
        errors.push(`${entry.behaviorId} is missing declarative Ruhroh scenario: ${toPosix(path.relative(root, scenarioPath))}`);
        continue;
      }
      if (!existsSync(instructionPath)) {
        errors.push(`${entry.behaviorId} is missing Ruhroh instruction: ${toPosix(path.relative(root, instructionPath))}`);
      }
      const scenario = await readJson<{ id?: unknown; version?: unknown; userPromptPath?: unknown }>(scenarioPath);
      if (scenario.id !== entry.ruhrohScenarioId) {
        errors.push(`${entry.behaviorId} scenario id does not match ${entry.ruhrohScenarioId}`);
      }
      if (scenario.version !== "ruhroh_scenario_v2") {
        errors.push(`${entry.behaviorId} must use ruhroh_scenario_v2`);
      }
      if (scenario.userPromptPath !== "instruction.md") {
        errors.push(`${entry.behaviorId} must use instruction.md as userPromptPath`);
      }
      if (entry.parityStatus === "passed") {
        if (entry.parityRecord === undefined || entry.parityRecord.trim().length === 0) {
          errors.push(`${entry.behaviorId} passed Ruhroh disposition must cite parityRecord`);
        } else {
          expectedParityRecords.push(entry.parityRecord);
          await validateParityRecord({
            root,
            entry,
            scenarioPath,
            instructionPath,
            errors,
          });
        }
      } else if (entry.parityRecord !== undefined) {
        errors.push(`${entry.behaviorId} pending Ruhroh disposition cannot cite parityRecord`);
      }
    } else {
      if (entry.parityStatus === "pending_execution") {
        errors.push(`${entry.behaviorId} runtime_test disposition cannot use pending_execution`);
      }
      if (entry.ruhrohScenarioId !== undefined) {
        errors.push(`${entry.behaviorId} runtime_test disposition cannot declare ruhrohScenarioId`);
      }
      if (entry.parityRecord !== undefined) {
        errors.push(`${entry.behaviorId} runtime_test disposition cannot declare parityRecord`);
      }
      if (entry.replacement === undefined || entry.replacement.trim().length === 0) {
        errors.push(`${entry.behaviorId} runtime_test disposition must name replacement coverage`);
      }
      if (entry.parityStatus === "passed" && (entry.replacementTests?.length ?? 0) === 0) {
        errors.push(`${entry.behaviorId} passed runtime_test disposition must cite replacementTests`);
      }
      for (const evidence of entry.replacementTests ?? []) {
        await validateReplacementTestEvidence(root, entry.behaviorId, evidence, errors);
      }
    }
  }

  const suite = await readJson<{ scenarioIds?: unknown; scenarioVersions?: unknown }>(
    path.join(root, SUITE_ROOT, SUITE_ID, "suite.json"),
  );
  const suiteScenarioIds = Array.isArray(suite.scenarioIds)
    ? suite.scenarioIds.filter((value): value is string => typeof value === "string").sort()
    : [];
  compareSets("Ruhroh suite scenario", [...expectedRuhrohIds].sort(), suiteScenarioIds, errors);
  if (isRecord(suite.scenarioVersions)) {
    for (const scenarioId of expectedRuhrohIds) {
      if (typeof suite.scenarioVersions[scenarioId] !== "string") {
        errors.push(`Ruhroh suite is missing scenario version for ${scenarioId}`);
      }
    }
  } else {
    errors.push("Ruhroh suite scenarioVersions must be an object");
  }

  const target = await readJson<{ targets?: unknown }>(path.join(root, TARGET_PATH));
  if (!Array.isArray(target.targets) || target.targets.length === 0) {
    errors.push("Ruhroh target config must define at least one target");
  } else {
    for (const [index, value] of target.targets.entries()) {
      if (!isRecord(value)) {
        errors.push(`Ruhroh target ${index} must be an object`);
        continue;
      }
      if (value.adapterId !== "kestrel-cli") {
        errors.push(`Ruhroh target ${index} must use the maintained kestrel-cli adapter`);
      }
      if (value.adapterCommand !== undefined) {
        errors.push(`Ruhroh target ${index} cannot copy or override the maintained adapter command`);
      }
    }
  }

  const evalFiles = await collectFiles(path.join(root, "evals"));
  for (const filePath of evalFiles) {
    if (path.basename(filePath) === "run.sh") {
      errors.push(`Kestrel evals cannot own adapter or evaluator executable: ${toPosix(path.relative(root, filePath))}`);
    }
  }

  const actualParityRecords = (await collectFiles(path.join(root, PARITY_RECORD_ROOT)))
    .filter((filePath) => filePath.endsWith(".json"))
    .map((filePath) => toPosix(path.relative(root, filePath)))
    .sort();
  compareSets(
    "Ruhroh parity record",
    expectedParityRecords.map(toPosix).sort(),
    actualParityRecords,
    errors,
  );

  return {
    errors,
    behaviorCount: ledger.behaviors.length,
    ruhrohScenarioCount: ledger.behaviors.filter((entry) => entry.disposition === "ruhroh").length,
    runtimeTestCount: ledger.behaviors.filter((entry) => entry.disposition === "runtime_test").length,
    parityRecordCount: expectedParityRecords.length,
  };
}

async function validateParityRecord(input: {
  root: string;
  entry: EvaluationOwnershipEntry & { ruhrohScenarioId?: string | undefined };
  scenarioPath: string;
  instructionPath: string;
  errors: string[];
}): Promise<void> {
  const recordPath = path.resolve(input.root, input.entry.parityRecord!);
  const relativePath = toPosix(path.relative(input.root, recordPath));
  const allowedRoot = `${toPosix(PARITY_RECORD_ROOT)}/`;
  if (relativePath.startsWith(allowedRoot) === false || relativePath.endsWith(".json") === false) {
    input.errors.push(`${input.entry.behaviorId} parityRecord must stay under ${PARITY_RECORD_ROOT}: ${input.entry.parityRecord}`);
    return;
  }
  if (!existsSync(recordPath)) {
    input.errors.push(`${input.entry.behaviorId} parityRecord does not exist: ${input.entry.parityRecord}`);
    return;
  }

  let record: Record<string, unknown>;
  try {
    record = await readJson<Record<string, unknown>>(recordPath);
  } catch (error) {
    input.errors.push(`${input.entry.behaviorId} parityRecord is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (record.version !== PARITY_RECORD_VERSION) {
    input.errors.push(`${input.entry.behaviorId} parityRecord version must be ${PARITY_RECORD_VERSION}`);
  }
  if (record.behaviorId !== input.entry.behaviorId) {
    input.errors.push(`${input.entry.behaviorId} parityRecord behaviorId mismatch`);
  }
  if (record.ruhrohScenarioId !== input.entry.ruhrohScenarioId) {
    input.errors.push(`${input.entry.behaviorId} parityRecord Ruhroh scenario mismatch`);
  }
  if (record.status !== "passed") {
    input.errors.push(`${input.entry.behaviorId} parityRecord status must be passed`);
  }

  const fixture = isRecord(record.fixture) ? record.fixture : {};
  if (typeof fixture.legacyFixtureSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(fixture.legacyFixtureSha256)) {
    input.errors.push(`${input.entry.behaviorId} parityRecord must preserve the legacy fixture SHA-256`);
  }
  const digestChecks: Array<[string, string, unknown]> = [
    ["scenario", input.scenarioPath, fixture.scenarioSha256],
    ["instruction", input.instructionPath, fixture.instructionSha256],
  ];
  for (const [label, filePath, recordedDigest] of digestChecks) {
    const currentDigest = sha256(await readFile(filePath));
    if (recordedDigest !== currentDigest) {
      input.errors.push(`${input.entry.behaviorId} parityRecord ${label} hash is stale`);
    }
  }

  const comparison = isRecord(record.comparison) ? record.comparison : {};
  for (const dimension of PARITY_DIMENSIONS) {
    const result = isRecord(comparison[dimension]) ? comparison[dimension] : {};
    if (result.status !== "passed") {
      input.errors.push(`${input.entry.behaviorId} parityRecord ${dimension} parity must pass`);
    }
  }

  const runtimes = isRecord(record.runtimes) ? record.runtimes : {};
  const ruhroh = isRecord(runtimes.ruhroh) ? runtimes.ruhroh : {};
  if (ruhroh.package !== RUHROH_PACKAGE_NAME) {
    input.errors.push(`${input.entry.behaviorId} parityRecord must identify the Ruhroh package`);
  }
  if (ruhroh.version !== RUHROH_RELEASE_VERSION) {
    input.errors.push(`${input.entry.behaviorId} parityRecord must use Ruhroh ${RUHROH_RELEASE_VERSION}`);
  }
  if (ruhroh.source !== "installed-package") {
    input.errors.push(`${input.entry.behaviorId} parityRecord must come from an installed Ruhroh package, not a source checkout`);
  }
  if (ruhroh.packageArtifactSha256 !== RUHROH_RELEASE_SHA256) {
    input.errors.push(`${input.entry.behaviorId} parityRecord must identify the released Ruhroh artifact SHA-256`);
  }
  if (ruhroh.adapterId !== "kestrel-cli") {
    input.errors.push(`${input.entry.behaviorId} parityRecord must use the maintained kestrel-cli adapter`);
  }
  if (ruhroh.continuityLevel !== "native_session") {
    input.errors.push(`${input.entry.behaviorId} parityRecord must prove native_session continuity`);
  }
  if (typeof ruhroh.adapterVersion !== "string" || ruhroh.adapterVersion.length === 0) {
    input.errors.push(`${input.entry.behaviorId} parityRecord must record adapterVersion`);
  }

  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  const artifactNames = new Set(
    artifacts.filter(isRecord).map((artifact) => artifact.name).filter((name): name is string => typeof name === "string"),
  );
  for (const name of ["jobInput", "jobOutput", "eventLog", "transcript", "loopResult"]) {
    if (!artifactNames.has(name)) {
      input.errors.push(`${input.entry.behaviorId} parityRecord is missing ${name} artifact evidence`);
    }
  }
  for (const artifact of artifacts.filter(isRecord)) {
    if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
      input.errors.push(`${input.entry.behaviorId} parityRecord artifact has invalid sha256`);
    }
    if (!Number.isInteger(artifact.sizeBytes) || Number(artifact.sizeBytes) < 0) {
      input.errors.push(`${input.entry.behaviorId} parityRecord artifact has invalid sizeBytes`);
    }
  }
}

async function validateReplacementTestEvidence(
  root: string,
  behaviorId: string,
  evidence: ReplacementTestEvidence,
  errors: string[],
): Promise<void> {
  const resolvedPath = path.resolve(root, evidence.path);
  const relativePath = toPosix(path.relative(root, resolvedPath));
  if (relativePath.startsWith("../") || relativePath.startsWith("tests/") === false) {
    errors.push(`${behaviorId} replacement test must stay under tests/: ${evidence.path}`);
    return;
  }
  if (!existsSync(resolvedPath)) {
    errors.push(`${behaviorId} replacement test does not exist: ${evidence.path}`);
    return;
  }
  if ((evidence.testName === undefined) === (evidence.promptSuiteCase === undefined)) {
    errors.push(`${behaviorId} replacement test must declare exactly one of testName or promptSuiteCase`);
    return;
  }

  const source = await readFile(resolvedPath, "utf8");
  if (evidence.testName !== undefined && !source.includes(`test("${evidence.testName}"`)) {
    errors.push(`${behaviorId} replacement test name not found in ${evidence.path}: ${evidence.testName}`);
  }
  if (evidence.promptSuiteCase !== undefined && !source.includes(`name: "${evidence.promptSuiteCase}"`)) {
    errors.push(`${behaviorId} prompt-suite case not found in ${evidence.path}: ${evidence.promptSuiteCase}`);
  }
}

export function resolveRuhrohInvocation(
  root = process.cwd(),
): RuhrohInvocation {
  const installedRoot = path.join(root, "node_modules", "@kestrel-agents", "ruhroh");
  const installedModule = path.join(installedRoot, "dist", "cli.js");
  const installedManifest = path.join(installedRoot, "package.json");
  if (existsSync(installedModule) && existsSync(installedManifest)) {
    const packageJson = JSON.parse(readFileSync(installedManifest, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (packageJson.name !== RUHROH_PACKAGE_NAME || packageJson.version !== RUHROH_RELEASE_VERSION) {
      throw new Error(
        `Installed Ruhroh must be ${RUHROH_PACKAGE_NAME}@${RUHROH_RELEASE_VERSION}; found ${String(packageJson.name)}@${String(packageJson.version)}`,
      );
    }
    return invocationForPath(installedModule, `installed ${RUHROH_PACKAGE_NAME}@${RUHROH_RELEASE_VERSION}`);
  }
  throw new Error(
    `${RUHROH_PACKAGE_NAME}@${RUHROH_RELEASE_VERSION} is not installed. Run pnpm install --frozen-lockfile.`,
  );
}

export function runRuhrohValidation(
  root = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  const invocation = resolveRuhrohInvocation(root);
  const commands = [
    [
      "validate",
      "--scenario-dir",
      path.join(root, SCENARIO_ROOT),
      "--suite-dir",
      path.join(root, SUITE_ROOT),
      "--suite",
      SUITE_ID,
      "--json",
    ],
    ["validate-targets", path.join(root, TARGET_PATH), "--json"],
    [
      "run",
      "--scenario-dir",
      path.join(root, SCENARIO_ROOT),
      "--suite-dir",
      path.join(root, SUITE_ROOT),
      "--suite",
      SUITE_ID,
      "--target-config",
      path.join(root, TARGET_PATH),
      "--runs",
      "1",
      "--dry-run",
    ],
  ];

  for (const args of commands) {
    const result = spawnSync(invocation.command, [...invocation.argsPrefix, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    if (result.error !== undefined || result.status !== 0) {
      const output = [result.stdout, result.stderr].filter((value) => value.trim().length > 0).join("\n");
      throw new Error(
        `Ruhroh validation failed via ${invocation.source}: ${result.error?.message ?? `exit ${String(result.status)}`}\n${output}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const result = await validateEvaluationOwnershipLedger();
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      process.stderr.write(`[evals] ${error}\n`);
    }
    process.stderr.write(`[evals] ownership ledger failed with ${result.errors.length} issue(s)\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `[evals] ownership ledger covers ${result.behaviorCount} behaviors (${result.ruhrohScenarioCount} Ruhroh, ${result.runtimeTestCount} runtime-test replacements) with ${result.parityRecordCount} executed parity records\n`,
  );
  runRuhrohValidation();
  process.stdout.write("[evals] Ruhroh scenario, suite, and target validation passed\n");
}

function invocationForPath(filePath: string, source: string): RuhrohInvocation {
  if (!existsSync(filePath)) {
    throw new Error(`${source} does not exist: ${filePath}`);
  }
  if (/\.[cm]?js$/u.test(filePath)) {
    return { command: process.execPath, argsPrefix: [filePath], source };
  }
  return { command: filePath, argsPrefix: [], source };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function collectFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(filePath));
    } else if (entry.isFile()) {
      files.push(filePath);
    }
  }
  return files;
}

function compareSets(label: string, expected: string[], actual: string[], errors: string[]): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const item of expectedSet) {
    if (!actualSet.has(item)) {
      errors.push(`${label} missing: ${item}`);
    }
  }
  for (const item of actualSet) {
    if (!expectedSet.has(item)) {
      errors.push(`${label} is stale or unexpected: ${item}`);
    }
  }
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicatesFound = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicatesFound.add(value);
    }
    seen.add(value);
  }
  return [...duplicatesFound].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`validate-ruhroh-evals failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
