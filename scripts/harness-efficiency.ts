import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareHarnessEfficiencyPairsV2,
  hashHarnessEfficiencyValue,
  parseHarnessEconomicsControlV1,
  parseHarnessEfficiencyResultV2,
  type HarnessEfficiencyResultV2,
} from "../src/economics/index.js";

type VariantName = "baseline" | "candidate";
type LaneName = "swe_verified" | "terminal_bench";

interface VariantSpec {
  sourceRoot: string;
  profileFile: string;
  profileId: string;
}

interface LaneSpec {
  lane: LaneName;
  dataset: string;
  taskIds: string[];
}

export interface HarnessEfficiencyExperimentSpecV1 {
  version: 1;
  baseline: VariantSpec;
  candidate: VariantSpec;
  lanes: LaneSpec[];
  trialCount: number;
  outputDirectory: string;
}

interface PlannedVariant extends VariantSpec {
  sourceRevision: string;
  profileHash: string;
  profile: Record<string, unknown>;
}

export interface HarnessEfficiencyPlanV1 {
  version: 1;
  schema: "kestrel.harness-efficiency-plan/v1";
  specHash: string;
  outputDirectory: string;
  pairCount: number;
  attemptCount: number;
  variants: Record<VariantName, PlannedVariant>;
  attempts: Array<{
    pairId: string;
    trial: number;
    lane: LaneName;
    dataset: string;
    taskId: string;
    order: [VariantName, VariantName];
    commands: Record<VariantName, { cwd: string; command: string[]; profileFile: string; profileId: string }>;
  }>;
}

export function runHarnessEfficiency(argv: string[], output: Pick<NodeJS.WriteStream, "write"> = process.stdout): number {
  const { command, specPath } = parseCommand(argv);
  const spec = parseExperimentSpec(JSON.parse(readFileSync(specPath, "utf8")), path.dirname(path.resolve(specPath)));
  const plan = createPlan(spec);
  if (command === "plan") {
    output.write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }
  if (command === "compare") return comparePlan(plan, output);
  return executePlan(plan, output);
}

export function parseExperimentSpec(value: unknown, baseDirectory = process.cwd()): HarnessEfficiencyExperimentSpecV1 {
  const record = requireRecord(value, "spec");
  rejectUnknown(record, new Set(["version", "baseline", "candidate", "lanes", "trialCount", "outputDirectory"]), "spec");
  if (record.version !== 1) throw new Error("Efficiency experiment spec version must be 1.");
  const lanesValue = record.lanes;
  if (!Array.isArray(lanesValue) || lanesValue.length === 0) throw new Error("Efficiency experiment spec lanes must be non-empty.");
  const lanes = lanesValue.map((value, index) => parseLane(value, index));
  const trialCount = requirePositiveInteger(record.trialCount, "spec.trialCount");
  return {
    version: 1,
    baseline: parseVariant(record.baseline, "baseline", baseDirectory),
    candidate: parseVariant(record.candidate, "candidate", baseDirectory),
    lanes,
    trialCount,
    outputDirectory: resolvePath(requireString(record.outputDirectory, "spec.outputDirectory"), baseDirectory),
  };
}

export function createPlan(spec: HarnessEfficiencyExperimentSpecV1): HarnessEfficiencyPlanV1 {
  const baseline = planVariant(spec.baseline, "baseline");
  const candidate = planVariant(spec.candidate, "candidate");
  assertFrozenProfileFields(baseline.profile, candidate.profile);
  const attempts: HarnessEfficiencyPlanV1["attempts"] = [];
  let pairIndex = 0;
  for (const lane of spec.lanes) {
    for (const taskId of lane.taskIds) {
      for (let trial = 1; trial <= spec.trialCount; trial += 1) {
        const pairId = `${lane.lane}:${lane.dataset}:${taskId}:trial:${trial}`;
        const order: [VariantName, VariantName] = pairIndex % 2 === 0
          ? ["baseline", "candidate"]
          : ["candidate", "baseline"];
        pairIndex += 1;
        const commandFor = (variant: PlannedVariant): { cwd: string; command: string[]; profileFile: string; profileId: string } => ({
          cwd: variant.sourceRoot,
          command: lane.lane === "swe_verified"
            ? ["pnpm", "run", "bench:swe", "--", "run", "--dataset", lane.dataset, "--instance-id", taskId, "--output-root", path.join(spec.outputDirectory, variant === baseline ? "baseline" : "candidate")]
            : ["pnpm", "run", "bench:terminal:harbor", "--", taskId, "--dataset", lane.dataset],
          profileFile: variant.profileFile,
          profileId: variant.profileId,
        });
        attempts.push({
          pairId,
          trial,
          lane: lane.lane,
          dataset: lane.dataset,
          taskId,
          order,
          commands: { baseline: commandFor(baseline), candidate: commandFor(candidate) },
        });
      }
    }
  }
  return {
    version: 1,
    schema: "kestrel.harness-efficiency-plan/v1",
    specHash: hashHarnessEfficiencyValue(spec),
    outputDirectory: spec.outputDirectory,
    pairCount: attempts.length,
    attemptCount: attempts.length * 2,
    variants: { baseline, candidate },
    attempts,
  };
}

function executePlan(plan: HarnessEfficiencyPlanV1, output: Pick<NodeJS.WriteStream, "write">): number {
  assertCleanSource(plan.variants.baseline.sourceRoot, "baseline");
  assertCleanSource(plan.variants.candidate.sourceRoot, "candidate");
  mkdirSync(plan.outputDirectory, { recursive: true });
  writeFileSync(path.join(plan.outputDirectory, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  for (const pair of plan.attempts) {
    for (const variantName of pair.order) {
      const attemptDirectory = path.join(plan.outputDirectory, variantName, safeSegment(pair.pairId));
      const completionPath = path.join(attemptDirectory, "completed.json");
      if (existsSync(completionPath)) {
        output.write(`[bench:efficiency] resume ${variantName} ${pair.pairId}\n`);
        continue;
      }
      mkdirSync(attemptDirectory, { recursive: true });
      const planned = pair.commands[variantName];
      const startedAtMs = Date.now();
      output.write(`[bench:efficiency] run ${variantName} ${pair.pairId}\n`);
      const result = spawnSync(planned.command[0] as string, planned.command.slice(1), {
        cwd: planned.cwd,
        env: {
          ...process.env,
          KESTREL_BENCHMARK_PAIR_ID: pair.pairId,
          KESTREL_BENCHMARK_TRIAL: String(pair.trial),
          KESTREL_BENCHMARK_PROFILE_FILE: planned.profileFile,
          KESTREL_BENCHMARK_PROFILE_ID: planned.profileId,
        },
        stdio: "inherit",
      });
      const artifacts = copyNewResults(
        [planned.cwd, path.join(plan.outputDirectory, variantName)],
        startedAtMs,
        attemptDirectory,
        plan.variants[variantName].profile,
      );
      if (artifacts.length === 0) {
        if (!spawnPassed(result)) return result.status ?? 1;
        throw new Error(`Efficiency attempt '${variantName}:${pair.pairId}' completed without a v2 result artifact.`);
      }
      writeFileSync(completionPath, `${JSON.stringify({ pairId: pair.pairId, variant: variantName, artifacts }, null, 2)}\n`, "utf8");
    }
  }
  return comparePlan(plan, output);
}

function comparePlan(plan: HarnessEfficiencyPlanV1, output: Pick<NodeJS.WriteStream, "write">): number {
  const baseline = loadResults(path.join(plan.outputDirectory, "baseline"));
  const candidate = loadResults(path.join(plan.outputDirectory, "candidate"));
  const comparison = compareHarnessEfficiencyPairsV2({ baseline, candidate });
  mkdirSync(plan.outputDirectory, { recursive: true });
  writeFileSync(path.join(plan.outputDirectory, "comparison.v2.json"), `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
  const summary = [
    `Harness efficiency comparison: ${comparison.passed ? "PASSED" : "FAILED"}`,
    `Pairs: ${comparison.pairIds.length}`,
    `Acceptance: ${comparison.metrics.baseline.accepted}/${comparison.metrics.baseline.attempts} baseline; ${comparison.metrics.candidate.accepted}/${comparison.metrics.candidate.attempts} candidate`,
    `Tokens per accepted success: ${formatMetric(comparison.metrics.baseline.tokensPerAcceptedSuccess)} baseline; ${formatMetric(comparison.metrics.candidate.tokensPerAcceptedSuccess)} candidate`,
    `Cost per accepted success: ${formatMetric(comparison.metrics.baseline.costPerAcceptedSuccessUsd)} baseline; ${formatMetric(comparison.metrics.candidate.costPerAcceptedSuccessUsd)} candidate`,
    ...comparison.reasons.map((reason) => `- ${reason}`),
    "",
  ].join("\n");
  writeFileSync(path.join(plan.outputDirectory, "summary.txt"), summary, "utf8");
  output.write(summary);
  return comparison.passed ? 0 : 2;
}

function planVariant(spec: VariantSpec, label: VariantName): PlannedVariant {
  if (!existsSync(spec.sourceRoot) || !statSync(spec.sourceRoot).isDirectory()) throw new Error(`${label} source root does not exist: ${spec.sourceRoot}`);
  if (!existsSync(path.join(spec.sourceRoot, "package.json"))) throw new Error(`${label} source root is not a Kestrel checkout: ${spec.sourceRoot}`);
  const profile = loadProfile(spec.profileFile, spec.profileId);
  const control = profile.harnessEconomics;
  if (control === undefined) throw new Error(`${label} profile '${spec.profileId}' is missing harnessEconomics.`);
  const parsedControl = parseHarnessEconomicsControlV1(control);
  for (const modelProfile of parsedControl.modelProfiles) {
    if (modelProfile.price === undefined) throw new Error(`${label} model economics profile '${modelProfile.profileId}' is unpriced.`);
  }
  return {
    ...spec,
    sourceRevision: git(spec.sourceRoot, ["rev-parse", "HEAD"]),
    profileHash: hashHarnessEfficiencyValue(profile),
    profile,
  };
}

function assertFrozenProfileFields(baseline: Record<string, unknown>, candidate: Record<string, unknown>): void {
  const frozen = (profile: Record<string, unknown>): unknown => {
    const copy = structuredClone(profile);
    delete copy.harnessEconomics;
    delete copy.delegation;
    const stage = optionalRecord(copy.agentStageConfig);
    const byStage = optionalRecord(stage?.modelByStage);
    if (byStage !== undefined) {
      delete byStage["agent.maintenance"];
      delete byStage["delegation.child"];
    }
    return copy;
  };
  if (hashHarnessEfficiencyValue(frozen(baseline)) !== hashHarnessEfficiencyValue(frozen(candidate))) {
    throw new Error("Baseline and candidate profiles differ outside harnessEconomics, maintenance/child stage models, or delegation configuration.");
  }
}

function loadProfile(profileFile: string, profileId: string): Record<string, unknown> {
  if (!existsSync(profileFile)) throw new Error(`Profile file does not exist: ${profileFile}`);
  const parsed = JSON.parse(readFileSync(profileFile, "utf8")) as unknown;
  const record = optionalRecord(parsed);
  const values = Array.isArray(record?.profiles) ? record.profiles : [parsed];
  const selected = values.find((value) => optionalRecord(value)?.id === profileId);
  const profile = optionalRecord(selected);
  if (profile === undefined) throw new Error(`Profile '${profileId}' was not found in ${profileFile}.`);
  return structuredClone(profile);
}

function loadResults(root: string): HarnessEfficiencyResultV2[] {
  if (!existsSync(root)) throw new Error(`Efficiency results directory does not exist: ${root}`);
  const results: HarnessEfficiencyResultV2[] = [];
  for (const file of listFiles(root)) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { schema?: unknown };
      if (parsed.schema === "kestrel.harness-efficiency-result/v2") results.push(parseHarnessEfficiencyResultV2(parsed));
    } catch {
      // Non-result artifacts share this directory and are deliberately ignored.
    }
  }
  if (results.length === 0) throw new Error(`No v2 efficiency results found under ${root}.`);
  return results;
}

function copyNewResults(
  searchRoots: string[],
  startedAtMs: number,
  attemptDirectory: string,
  profile: Record<string, unknown>,
): string[] {
  const copied: string[] = [];
  const copiedSources = new Set<string>();
  for (const file of findNewEfficiencyResultCandidates(searchRoots, startedAtMs)) {
    try {
      const sourceRoot = searchRoots
        .map((root) => path.resolve(root))
        .find((root) => file === root || file.startsWith(`${root}${path.sep}`)) ?? path.dirname(file);
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { schema?: unknown; artifacts?: unknown };
      const result = parseHarnessEfficiencyResultV2(parsed);
      const target = path.join(attemptDirectory, `result-${copied.length + 1}.json`);
      cpSync(file, target);
      copiedSources.add(path.resolve(file));
      copied.push(target);
      for (const [index, artifact] of result.artifacts.entries()) {
        const source = path.isAbsolute(artifact.path) ? artifact.path : path.resolve(sourceRoot, artifact.path);
        if (!existsSync(source) || !statSync(source).isFile() || copiedSources.has(source)) continue;
        const extension = path.extname(source);
        const artifactTarget = path.join(attemptDirectory, `artifact-${safeSegment(artifact.kind)}-${index + 1}${extension}`);
        cpSync(source, artifactTarget);
        copiedSources.add(source);
        copied.push(artifactTarget);
      }
    } catch {
      continue;
    }
  }
  if (copied.length > 0) {
    const profilePath = path.join(attemptDirectory, "profile.normalized.json");
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    copied.push(profilePath);
  }
  return copied;
}

export function findNewEfficiencyResultCandidates(searchRoots: string[], startedAtMs: number): string[] {
  const candidates = new Set<string>();
  for (const root of [...new Set(searchRoots.map((value) => path.resolve(value)))]) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    for (const file of listFiles(root, new Set([".git", "node_modules", ".pnpm-store"]))) {
      if (!file.endsWith(".json") || statSync(file).mtimeMs < startedAtMs) continue;
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { schema?: unknown };
        if (parsed.schema === "kestrel.harness-efficiency-result/v2") candidates.add(path.resolve(file));
      } catch {
        // Other benchmark artifacts deliberately share these roots.
      }
    }
  }
  return [...candidates].sort();
}

function parseCommand(argv: string[]): { command: "plan" | "run" | "compare"; specPath: string } {
  const command = argv[0];
  if (command !== "plan" && command !== "run" && command !== "compare") throw new Error("Usage: pnpm bench:efficiency -- <plan|run|compare> --spec <file>");
  if (argv[1] !== "--spec" || argv[2] === undefined || argv.length !== 3) throw new Error("Usage: pnpm bench:efficiency -- <plan|run|compare> --spec <file>");
  return { command, specPath: path.resolve(argv[2]) };
}

function parseVariant(value: unknown, label: VariantName, baseDirectory: string): VariantSpec {
  const record = requireRecord(value, `spec.${label}`);
  rejectUnknown(record, new Set(["sourceRoot", "profileFile", "profileId"]), `spec.${label}`);
  return {
    sourceRoot: resolvePath(requireString(record.sourceRoot, `spec.${label}.sourceRoot`), baseDirectory),
    profileFile: resolvePath(requireString(record.profileFile, `spec.${label}.profileFile`), baseDirectory),
    profileId: requireString(record.profileId, `spec.${label}.profileId`),
  };
}

function parseLane(value: unknown, index: number): LaneSpec {
  const label = `spec.lanes[${index}]`;
  const record = requireRecord(value, label);
  rejectUnknown(record, new Set(["lane", "dataset", "taskIds"]), label);
  if (record.lane !== "swe_verified" && record.lane !== "terminal_bench") throw new Error(`${label}.lane is invalid.`);
  if (!Array.isArray(record.taskIds) || record.taskIds.length === 0) throw new Error(`${label}.taskIds must be non-empty.`);
  const taskIds = record.taskIds.map((taskId, taskIndex) => requireString(taskId, `${label}.taskIds[${taskIndex}]`));
  if (new Set(taskIds).size !== taskIds.length) throw new Error(`${label}.taskIds must be unique.`);
  return { lane: record.lane, dataset: requireString(record.dataset, `${label}.dataset`), taskIds };
}

function assertCleanSource(root: string, label: VariantName): void {
  if (git(root, ["status", "--porcelain"]).length > 0) throw new Error(`Decision run refused: ${label} source root has uncommitted changes.`);
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${root}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function listFiles(root: string, excluded = new Set<string>()): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(target, excluded));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function spawnPassed(result: SpawnSyncReturns<Buffer | string>): boolean {
  return result.error === undefined && result.status === 0;
}

function resolvePath(value: string, baseDirectory: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDirectory, value);
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/gu, "_");
}

function formatMetric(value: number | null): string {
  return value === null ? "unavailable" : String(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  const record = optionalRecord(value);
  if (record === undefined) throw new Error(`${field} must be an object.`);
  return record;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${field} must be a positive integer.`);
  return value as number;
}

function rejectUnknown(record: Record<string, unknown>, allowed: Set<string>, field: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`${field} contains unknown field '${unknown}'.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runHarnessEfficiency(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
