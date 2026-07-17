import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SweWorkspacePatchStatus = "produced" | "empty" | "failed";

export interface SweWorkspacePatchChange {
  path: string;
  status: "A" | "M" | "D" | "T";
}

export interface SweWorkspacePatchStage {
  name: string;
  status: "passed" | "failed";
  message?: string | undefined;
}

export interface SweWorkspacePatchReport {
  schemaVersion: 1;
  status: SweWorkspacePatchStatus;
  sourceBaseCommit: string;
  baselineCommit: string;
  kestrelExitCode: number;
  patchBytes: number;
  patchSha256?: string | undefined;
  targetTreeSha?: string | undefined;
  changedPaths: SweWorkspacePatchChange[];
  excludedTransientPaths: string[];
  unsupportedPaths: string[];
  stages: SweWorkspacePatchStage[];
  validation: {
    applies: boolean;
    treeMatches: boolean;
  };
  failureStage?: string | undefined;
  failureMessage?: string | undefined;
}

export interface ExportSweWorkspacePatchInput {
  workspaceRoot: string;
  baselineRepo: string;
  sourceBaseCommit: string;
  baseCommit: string;
  patchPath: string;
  reportPath: string;
  kestrelExitCode: number;
  spawn?: typeof spawnSync;
}

export interface SweWorkspaceBaselineReport {
  schemaVersion: 1;
  status: "captured" | "failed";
  sourceBaseCommit: string;
  baselineCommit?: string | undefined;
  baselineTreeSha?: string | undefined;
  excludedTransientPaths: string[];
  unsupportedPaths: string[];
  stages: SweWorkspacePatchStage[];
  failureStage?: string | undefined;
  failureMessage?: string | undefined;
}

export interface CaptureSweWorkspaceBaselineInput {
  workspaceRoot: string;
  baselineRepo: string;
  sourceBaseCommit: string;
  reportPath: string;
  spawn?: typeof spawnSync;
}

interface GitContext {
  gitDir: string;
  workspaceRoot: string;
  indexPath: string;
}

interface WorkspaceInventory {
  candidatePaths: string[];
  excludedTransientPaths: string[];
  unsupportedPaths: string[];
}

const TRANSIENT_DIRECTORY_COMPONENTS = new Set([
  ".git",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".hypothesis",
  ".tox",
  ".nox",
  ".venv",
  "venv",
  "node_modules",
]);
const TRANSIENT_TOP_LEVEL_DIRECTORIES = new Set([".cache", "htmlcov"]);
const MAX_GIT_STDERR_BYTES = 16 * 1024 * 1024;
const PREPARED_BASELINE_REF = "refs/kestrel/swe-prepared-baseline";
const DETERMINISTIC_COMMIT_DATE = "2000-01-01T00:00:00Z";

class PatchExportFailure extends Error {
  constructor(readonly stage: string, message: string) {
    super(message);
  }
}

export function captureSweVerifiedWorkspaceBaseline(
  input: CaptureSweWorkspaceBaselineInput,
): SweWorkspaceBaselineReport {
  const spawn = input.spawn ?? spawnSync;
  mkdirSync(path.dirname(input.reportPath), { recursive: true });
  let tempRoot: string | undefined;
  let inventory: WorkspaceInventory = {
    candidatePaths: [],
    excludedTransientPaths: [],
    unsupportedPaths: [],
  };
  const stages: SweWorkspacePatchStage[] = [];
  try {
    assertDirectory(input.workspaceRoot, "workspace");
    assertDirectory(input.baselineRepo, "baseline repository");
    const sourceBaseCommit = runGit(
      spawn,
      ["-C", input.baselineRepo, "rev-parse", "--verify", `${input.sourceBaseCommit}^{commit}`],
      "verify_source_baseline",
    ).stdout.toString("utf8").trim();
    stages.push({ name: "verify_source_baseline", status: "passed" });

    tempRoot = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-baseline-"));
    const context: GitContext = {
      gitDir: path.join(input.baselineRepo, ".git"),
      workspaceRoot: input.workspaceRoot,
      indexPath: path.join(tempRoot, "baseline.index"),
    };
    runGitContext(spawn, context, ["read-tree", sourceBaseCommit], "initialize_baseline_index");
    runGitContext(spawn, context, ["add", "-u", "--", "."], "stage_baseline_tracked_files");
    inventory = inventoryWorkspace(input.workspaceRoot);
    if (inventory.unsupportedPaths.length > 0) {
      throw new PatchExportFailure(
        "inventory_baseline",
        `Unsupported filesystem entries: ${inventory.unsupportedPaths.join(", ")}`,
      );
    }
    stages.push({ name: "inventory_baseline", status: "passed" });
    if (inventory.candidatePaths.length > 0) {
      const pathspecPath = path.join(tempRoot, "pathspecs");
      writeFileSync(pathspecPath, `${inventory.candidatePaths.join("\0")}\0`, "utf8");
      runGitContext(
        spawn,
        context,
        ["add", "-f", `--pathspec-from-file=${pathspecPath}`, "--pathspec-file-nul"],
        "stage_baseline_workspace",
      );
    }
    const baselineTreeSha = runGitContext(spawn, context, ["write-tree"], "write_baseline_tree")
      .stdout.toString("utf8").trim();
    stages.push({ name: "stage_baseline", status: "passed" });
    const commitEnv = {
      ...gitContextEnv(context),
      GIT_AUTHOR_NAME: "Kestrel",
      GIT_AUTHOR_EMAIL: "kestrel@example.invalid",
      GIT_AUTHOR_DATE: DETERMINISTIC_COMMIT_DATE,
      GIT_COMMITTER_NAME: "Kestrel",
      GIT_COMMITTER_EMAIL: "kestrel@example.invalid",
      GIT_COMMITTER_DATE: DETERMINISTIC_COMMIT_DATE,
    };
    const baselineCommit = runGit(
      spawn,
      [
        "commit-tree",
        baselineTreeSha,
        "-p",
        sourceBaseCommit,
        "-m",
        "Kestrel SWE prepared workspace baseline",
      ],
      "commit_baseline_tree",
      commitEnv,
      input.workspaceRoot,
    ).stdout.toString("utf8").trim();
    runGit(
      spawn,
      ["update-ref", PREPARED_BASELINE_REF, baselineCommit],
      "publish_baseline_ref",
      commitEnv,
      input.workspaceRoot,
    );
    stages.push({ name: "publish_baseline", status: "passed" });
    const report: SweWorkspaceBaselineReport = {
      schemaVersion: 1,
      status: "captured",
      sourceBaseCommit,
      baselineCommit,
      baselineTreeSha,
      excludedTransientPaths: inventory.excludedTransientPaths,
      unsupportedPaths: inventory.unsupportedPaths,
      stages,
    };
    writeJsonAtomic(input.reportPath, report);
    return report;
  } catch (error) {
    const failure = error instanceof PatchExportFailure
      ? error
      : new PatchExportFailure("unexpected", error instanceof Error ? error.message : String(error));
    stages.push({ name: failure.stage, status: "failed", message: failure.message });
    const report: SweWorkspaceBaselineReport = {
      schemaVersion: 1,
      status: "failed",
      sourceBaseCommit: input.sourceBaseCommit,
      excludedTransientPaths: inventory.excludedTransientPaths,
      unsupportedPaths: inventory.unsupportedPaths,
      stages,
      failureStage: failure.stage,
      failureMessage: failure.message,
    };
    writeJsonAtomic(input.reportPath, report);
    return report;
  } finally {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

export function exportSweVerifiedWorkspacePatch(input: ExportSweWorkspacePatchInput): SweWorkspacePatchReport {
  const spawn = input.spawn ?? spawnSync;
  const baseReport = createBaseReport(input);
  rmSync(input.patchPath, { force: true });
  mkdirSync(path.dirname(input.patchPath), { recursive: true });
  mkdirSync(path.dirname(input.reportPath), { recursive: true });

  let tempRoot: string | undefined;
  let patchTempPath: string | undefined;
  let inventory: WorkspaceInventory = {
    candidatePaths: [],
    excludedTransientPaths: [],
    unsupportedPaths: [],
  };
  let changes: SweWorkspacePatchChange[] = [];
  const stages: SweWorkspacePatchStage[] = [];
  let targetTreeSha: string | undefined;
  try {
    assertDirectory(input.workspaceRoot, "workspace");
    assertDirectory(input.baselineRepo, "baseline repository");
    runGit(spawn, ["-C", input.baselineRepo, "rev-parse", "--verify", `${input.baseCommit}^{commit}`], "verify_baseline");

    tempRoot = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-patch-"));
    const exportRepo = path.join(tempRoot, "repo");
    runGit(
      spawn,
      ["clone", "--no-local", "--no-checkout", input.baselineRepo, exportRepo],
      "clone_baseline",
    );
    runGit(
      spawn,
      ["-C", exportRepo, "fetch", "--no-tags", input.baselineRepo, PREPARED_BASELINE_REF],
      "fetch_prepared_baseline",
    );
    runGit(spawn, ["-C", exportRepo, "rev-parse", "--verify", `${input.baseCommit}^{commit}`], "verify_export_baseline");
    stages.push({ name: "verify_baseline", status: "passed" });

    const gitDir = path.join(exportRepo, ".git");
    const indexPath = path.join(tempRoot, "export.index");
    const context = { gitDir, workspaceRoot: input.workspaceRoot, indexPath };
    runGitContext(spawn, context, ["read-tree", input.baseCommit], "initialize_export_index");
    runGitContext(spawn, context, ["add", "-u", "--", "."], "stage_tracked_changes");

    inventory = inventoryWorkspace(input.workspaceRoot);
    if (inventory.unsupportedPaths.length > 0) {
      throw new PatchExportFailure(
        "inventory_workspace",
        `Unsupported filesystem entries: ${inventory.unsupportedPaths.join(", ")}`,
      );
    }
    stages.push({ name: "inventory_workspace", status: "passed" });
    if (inventory.candidatePaths.length > 0) {
      const pathspecPath = path.join(tempRoot, "pathspecs");
      writeFileSync(pathspecPath, `${inventory.candidatePaths.join("\0")}\0`, "utf8");
      runGitContext(
        spawn,
        context,
        ["add", "-f", `--pathspec-from-file=${pathspecPath}`, "--pathspec-file-nul"],
        "stage_workspace_files",
      );
    }
    stages.push({ name: "stage_workspace", status: "passed" });

    targetTreeSha = runGitContext(spawn, context, ["write-tree"], "write_target_tree").stdout.toString("utf8").trim();
    changes = readChangedPaths(spawn, context, input.baseCommit);
    patchTempPath = path.join(path.dirname(input.patchPath), `.${path.basename(input.patchPath)}.${process.pid}.tmp`);
    rmSync(patchTempPath, { force: true });
    runGitContextToFile(
      spawn,
      context,
      [
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        input.baseCommit,
        "--",
      ],
      patchTempPath,
      "render_patch",
    );
    stages.push({ name: "render_patch", status: "passed" });

    const patch = readFileSync(patchTempPath);
    const baselineTreeSha = runGit(
      spawn,
      ["-C", exportRepo, "rev-parse", `${input.baseCommit}^{tree}`],
      "read_baseline_tree",
    ).stdout.toString("utf8").trim();
    const applies = true;
    let treeMatches = targetTreeSha === baselineTreeSha;
    if (patch.length > 0) {
      const validationContext = {
        gitDir,
        workspaceRoot: input.workspaceRoot,
        indexPath: path.join(tempRoot, "validation.index"),
      };
      runGitContext(spawn, validationContext, ["read-tree", input.baseCommit], "initialize_validation_index");
      runGitContext(
        spawn,
        validationContext,
        ["apply", "--cached", "--check", "--whitespace=nowarn", patchTempPath],
        "check_patch",
      );
      runGitContext(
        spawn,
        validationContext,
        ["apply", "--cached", "--whitespace=nowarn", patchTempPath],
        "apply_patch",
      );
      const appliedTreeSha = runGitContext(spawn, validationContext, ["write-tree"], "write_validated_tree")
        .stdout.toString("utf8").trim();
      treeMatches = appliedTreeSha === targetTreeSha;
      if (!treeMatches) {
        throw new PatchExportFailure(
          "validate_tree",
          `Applied patch tree ${appliedTreeSha} does not match exported tree ${targetTreeSha}.`,
        );
      }
    }
    stages.push({ name: "validate_patch", status: "passed" });

    renameSync(patchTempPath, input.patchPath);
    const report: SweWorkspacePatchReport = {
      ...baseReport,
      status: patch.length > 0 ? "produced" : "empty",
      patchBytes: patch.length,
      ...(patch.length > 0
        ? { patchSha256: createHash("sha256").update(patch).digest("hex") }
        : {}),
      targetTreeSha,
      changedPaths: changes,
      excludedTransientPaths: inventory.excludedTransientPaths,
      unsupportedPaths: inventory.unsupportedPaths,
      stages,
      validation: { applies, treeMatches },
    };
    writeJsonAtomic(input.reportPath, report);
    return report;
  } catch (error) {
    const failure = error instanceof PatchExportFailure
      ? error
      : new PatchExportFailure("unexpected", error instanceof Error ? error.message : String(error));
    stages.push({ name: failure.stage, status: "failed", message: failure.message });
    rmSync(input.patchPath, { force: true });
    const report: SweWorkspacePatchReport = {
      ...baseReport,
      status: "failed",
      ...(targetTreeSha !== undefined ? { targetTreeSha } : {}),
      changedPaths: changes,
      excludedTransientPaths: inventory.excludedTransientPaths,
      unsupportedPaths: inventory.unsupportedPaths,
      stages,
      failureStage: failure.stage,
      failureMessage: failure.message,
    };
    writeJsonAtomic(input.reportPath, report);
    return report;
  } finally {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
    if (patchTempPath !== undefined) {
      rmSync(patchTempPath, { force: true });
    }
  }
}

function createBaseReport(input: ExportSweWorkspacePatchInput): SweWorkspacePatchReport {
  return {
    schemaVersion: 1,
    status: "failed",
    sourceBaseCommit: input.sourceBaseCommit,
    baselineCommit: input.baseCommit,
    kestrelExitCode: input.kestrelExitCode,
    patchBytes: 0,
    changedPaths: [],
    excludedTransientPaths: [],
    unsupportedPaths: [],
    stages: [],
    validation: { applies: false, treeMatches: false },
  };
}

function inventoryWorkspace(workspaceRoot: string): WorkspaceInventory {
  const candidatePaths: string[] = [];
  const excludedTransientPaths: string[] = [];
  const unsupportedPaths: string[] = [];

  const visit = (relativeDirectory: string): void => {
    const absoluteDirectory = relativeDirectory.length === 0
      ? workspaceRoot
      : path.join(workspaceRoot, relativeDirectory);
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativePath = relativeDirectory.length === 0
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      const absolutePath = path.join(workspaceRoot, ...relativePath.split("/"));
      const fileStat = lstatSync(absolutePath);
      if (fileStat.isDirectory()) {
        if (isTransientDirectory(relativePath)) {
          excludedTransientPaths.push(`${relativePath}/`);
          continue;
        }
        visit(relativePath);
        continue;
      }
      if (fileStat.isFile() || fileStat.isSymbolicLink()) {
        if (isTransientFile(relativePath)) {
          excludedTransientPaths.push(relativePath);
        } else {
          candidatePaths.push(relativePath);
        }
        continue;
      }
      unsupportedPaths.push(relativePath);
    }
  };

  visit("");
  candidatePaths.sort();
  excludedTransientPaths.sort();
  unsupportedPaths.sort();
  return { candidatePaths, excludedTransientPaths, unsupportedPaths };
}

function isTransientDirectory(relativePath: string): boolean {
  const components = relativePath.split("/");
  if (components.some((component) => TRANSIENT_DIRECTORY_COMPONENTS.has(component))) {
    return true;
  }
  return components.length === 1 && TRANSIENT_TOP_LEVEL_DIRECTORIES.has(components[0] ?? "");
}

function isTransientFile(relativePath: string): boolean {
  const components = relativePath.split("/");
  const basename = components.at(-1) ?? "";
  if (basename.endsWith(".pyc") || basename.endsWith(".pyo")) {
    return true;
  }
  return components.length === 1 && (basename === ".coverage" || basename.startsWith(".coverage."));
}

function readChangedPaths(
  spawn: typeof spawnSync,
  context: GitContext,
  baseCommit: string,
): SweWorkspacePatchChange[] {
  const result = runGitContext(
    spawn,
    context,
    ["diff", "--cached", "--name-status", "-z", "--no-renames", baseCommit, "--"],
    "list_changed_paths",
  );
  const fields = result.stdout.toString("utf8").split("\0").filter((field) => field.length > 0);
  const changes: SweWorkspacePatchChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const rawStatus = fields[index] ?? "";
    const changedPath = fields[index + 1];
    const status = rawStatus[0];
    if (changedPath === undefined || (status !== "A" && status !== "M" && status !== "D" && status !== "T")) {
      throw new PatchExportFailure("parse_changed_paths", `Unexpected git name-status output: ${rawStatus}`);
    }
    changes.push({ path: changedPath, status });
  }
  return changes;
}

function runGit(
  spawn: typeof spawnSync,
  args: string[],
  stage: string,
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): SpawnSyncReturns<Buffer> {
  const result = spawn("git", args, {
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      ...(env ?? {}),
    },
    ...(cwd !== undefined ? { cwd } : {}),
    encoding: "buffer",
    maxBuffer: MAX_GIT_STDERR_BYTES,
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new PatchExportFailure(stage, renderGitFailure(args, result));
  }
  return result;
}

function runGitContext(
  spawn: typeof spawnSync,
  context: GitContext,
  args: string[],
  stage: string,
): SpawnSyncReturns<Buffer> {
  return runGit(spawn, args, stage, gitContextEnv(context), context.workspaceRoot);
}

function runGitContextToFile(
  spawn: typeof spawnSync,
  context: GitContext,
  args: string[],
  outputPath: string,
  stage: string,
): void {
  const outputFd = openSync(outputPath, "wx");
  let result: SpawnSyncReturns<Buffer> | undefined;
  try {
    result = spawn("git", args, {
      env: { ...process.env, ...gitContextEnv(context) },
      cwd: context.workspaceRoot,
      stdio: ["ignore", outputFd, "pipe"],
      encoding: "buffer",
      maxBuffer: MAX_GIT_STDERR_BYTES,
    });
  } finally {
    closeSync(outputFd);
  }
  if (result === undefined) {
    throw new PatchExportFailure(stage, "git process did not return a result");
  }
  if (result.status !== 0 || result.error !== undefined) {
    throw new PatchExportFailure(stage, renderGitFailure(args, result));
  }
}

function gitContextEnv(context: GitContext): NodeJS.ProcessEnv {
  return {
    GIT_DIR: context.gitDir,
    GIT_WORK_TREE: context.workspaceRoot,
    GIT_INDEX_FILE: context.indexPath,
    GIT_LITERAL_PATHSPECS: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
  };
}

function renderGitFailure(args: string[], result: SpawnSyncReturns<Buffer>): string {
  const detail = result.error?.message ?? result.stderr?.toString("utf8").trim() ?? "unknown git failure";
  return `git ${args.join(" ")} failed with status ${String(result.status)}: ${detail}`;
}

function assertDirectory(directoryPath: string, label: string): void {
  if (!(existsSync(directoryPath) && lstatSync(directoryPath).isDirectory())) {
    throw new PatchExportFailure("validate_input", `${label} does not exist or is not a directory: ${directoryPath}`);
  }
}

function writeJsonAtomic(reportPath: string, report: unknown): void {
  const tempPath = path.join(path.dirname(reportPath), `.${path.basename(reportPath)}.${process.pid}.tmp`);
  rmSync(tempPath, { force: true });
  writeFileSync(tempPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  renameSync(tempPath, reportPath);
}

type ExporterCliOptions =
  | ({ mode: "capture" } & CaptureSweWorkspaceBaselineInput)
  | ({ mode: "export" } & ExportSweWorkspacePatchInput);

function parseCliArgs(argv: string[]): ExporterCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new Error("Expected paired --flag value arguments.");
    }
    values.set(flag, value);
  }
  const requireValue = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (value === undefined || value.length === 0) {
      throw new Error(`Missing required argument: ${flag}`);
    }
    return value;
  };
  const mode = requireValue("--mode");
  const workspaceRoot = path.resolve(requireValue("--workspace-root"));
  const baselineRepo = path.resolve(requireValue("--baseline-repo"));
  const sourceBaseCommit = requireValue("--source-base-commit");
  const reportPath = path.resolve(requireValue("--report-path"));
  if (mode === "capture") {
    return {
      mode,
      workspaceRoot,
      baselineRepo,
      sourceBaseCommit,
      reportPath,
    };
  }
  if (mode !== "export") {
    throw new Error("--mode must be capture or export.");
  }
  const kestrelExitCode = Number(requireValue("--kestrel-exit-code"));
  if (!Number.isInteger(kestrelExitCode)) {
    throw new Error("--kestrel-exit-code must be an integer.");
  }
  return {
    mode,
    workspaceRoot,
    baselineRepo,
    sourceBaseCommit,
    baseCommit: requireValue("--base-commit"),
    patchPath: path.resolve(requireValue("--patch-path")),
    reportPath,
    kestrelExitCode,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const report = options.mode === "capture"
      ? captureSweVerifiedWorkspaceBaseline(options)
      : exportSweVerifiedWorkspacePatch(options);
    process.exitCode = report.status === "failed" ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
