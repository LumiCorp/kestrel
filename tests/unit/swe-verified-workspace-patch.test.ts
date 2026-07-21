import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  captureSweVerifiedWorkspaceBaseline,
  exportSweVerifiedWorkspacePatch,
  type ExportSweWorkspacePatchInput,
} from "../../scripts/swe-verified-workspace-patch.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.process", "prepared workspace capture prevents image-preexisting files from entering the final patch", () => {
  const fixture = createFixture();
  try {
    const initialWorkspace = path.join(fixture.root, "prepared-image");
    copyWorkingTree(fixture.baselineRepo, initialWorkspace);
    writeFileSync(path.join(initialWorkspace, "prepared.generated"), "present before agent\n", "utf8");
    mkdirSync(path.join(initialWorkspace, "generated"), { recursive: true });
    writeFileSync(path.join(initialWorkspace, "generated", "version.py"), "generated before agent\n", "utf8");
    const baselineReport = captureSweVerifiedWorkspaceBaseline({
      workspaceRoot: initialWorkspace,
      baselineRepo: fixture.baselineRepo,
      sourceBaseCommit: fixture.baseCommit,
      reportPath: path.join(fixture.root, "baseline-report.json"),
    });
    assert.equal(baselineReport.status, "captured");
    assert.ok(baselineReport.baselineCommit);

    const finalWorkspace = path.join(fixture.root, "final-workspace");
    cpSync(initialWorkspace, finalWorkspace, { recursive: true, dereference: false });
    writeFileSync(path.join(finalWorkspace, "source.txt"), "agent change\n", "utf8");
    const report = exportSweVerifiedWorkspacePatch({
      workspaceRoot: finalWorkspace,
      baselineRepo: fixture.baselineRepo,
      sourceBaseCommit: fixture.baseCommit,
      baseCommit: baselineReport.baselineCommit as string,
      patchPath: path.join(fixture.root, "prepared.patch"),
      reportPath: path.join(fixture.root, "prepared-export-report.json"),
      kestrelExitCode: 0,
    });

    assert.equal(report.status, "produced", JSON.stringify(report, null, 2));
    assert.deepEqual(report.changedPaths, [{ path: "source.txt", status: "M" }]);
    const patch = readFileSync(path.join(fixture.root, "prepared.patch"), "utf8");
    assert.doesNotMatch(patch, /prepared\.generated|generated\/version\.py/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

contractTest("runtime.process", "workspace patch exporter reconstructs the final filesystem without workspace Git metadata", () => {
  const fixture = createFixture();
  try {
    const workspace = path.join(fixture.root, "workspace");
    copyWorkingTree(fixture.baselineRepo, workspace);
    writeFileSync(path.join(workspace, "source.txt"), "changed source\n", "utf8");
    unlinkSync(path.join(workspace, "deleted.txt"));
    writeFileSync(path.join(workspace, "intent.generated"), "ignored but intentional\n", "utf8");
    writeFileSync(path.join(workspace, "binary.dat"), Buffer.from([0, 1, 2, 255]));
    symlinkSync("source.txt", path.join(workspace, "source-link"));
    chmodSync(path.join(workspace, "script.sh"), 0o755);
    writeFileSync(path.join(workspace, ".pytest_cache", "tracked.txt"), "tracked cache change\n", "utf8");
    mkdirSync(path.join(workspace, "__pycache__"), { recursive: true });
    writeFileSync(path.join(workspace, "__pycache__", "generated.pyc"), Buffer.from([3, 4, 5]));

    const report = exportFixture(fixture, workspace, "complete");

    assert.equal(report.status, "produced");
    assert.equal(report.validation.applies, true);
    assert.equal(report.validation.treeMatches, true);
    assert.ok((report.patchSha256 ?? "").length > 0);
    assert.deepEqual(
      report.changedPaths,
      [
        { path: ".pytest_cache/tracked.txt", status: "M" },
        { path: "binary.dat", status: "A" },
        { path: "deleted.txt", status: "D" },
        { path: "intent.generated", status: "A" },
        { path: "script.sh", status: "M" },
        { path: "source-link", status: "A" },
        { path: "source.txt", status: "M" },
      ],
    );
    assert.ok(report.excludedTransientPaths.includes("__pycache__/"));
    assert.ok(report.excludedTransientPaths.includes(".pytest_cache/"));
    assert.equal(report.unsupportedPaths.length, 0);
    assert.deepEqual(report.stages.map((stage) => `${stage.name}:${stage.status}`), [
      "verify_baseline:passed",
      "inventory_workspace:passed",
      "stage_workspace:passed",
      "render_patch:passed",
      "validate_patch:passed",
    ]);

    const applied = path.join(fixture.root, "applied");
    runGit(["clone", "--quiet", fixture.baselineRepo, applied]);
    runGit(["-C", applied, "apply", "--index", path.join(fixture.root, "complete.patch")]);
    assert.equal(readFileSync(path.join(applied, "source.txt"), "utf8"), "changed source\n");
    assert.equal(existsSync(path.join(applied, "deleted.txt")), false);
    assert.equal(readFileSync(path.join(applied, "intent.generated"), "utf8"), "ignored but intentional\n");
    assert.deepEqual(readFileSync(path.join(applied, "binary.dat")), Buffer.from([0, 1, 2, 255]));
    assert.equal(lstatSync(path.join(applied, "source-link")).isSymbolicLink(), true);
    assert.equal((lstatSync(path.join(applied, "script.sh")).mode & 0o111) !== 0, true);
    assert.equal(existsSync(path.join(applied, "__pycache__", "generated.pyc")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

contractTest("runtime.process", "workspace patch exporter is deterministic across commits, branches, staging, and missing Git metadata", () => {
  const fixture = createFixture();
  try {
    const committedWorkspace = path.join(fixture.root, "committed");
    runGit(["clone", "--quiet", fixture.baselineRepo, committedWorkspace]);
    runGit(["-C", committedWorkspace, "switch", "-c", "agent-branch"]);
    writeFileSync(path.join(committedWorkspace, "source.txt"), "same final state\n", "utf8");
    writeFileSync(path.join(committedWorkspace, "new.txt"), "new file\n", "utf8");
    runGit(["-C", committedWorkspace, "add", "-A"]);
    runGit([
      "-C",
      committedWorkspace,
      "-c",
      "user.name=Agent",
      "-c",
      "user.email=agent@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "agent commit",
    ]);

    const resetWorkspace = path.join(fixture.root, "reset");
    runGit(["clone", "--quiet", fixture.baselineRepo, resetWorkspace]);
    writeFileSync(path.join(resetWorkspace, "source.txt"), "same final state\n", "utf8");
    writeFileSync(path.join(resetWorkspace, "new.txt"), "new file\n", "utf8");
    runGit(["-C", resetWorkspace, "add", "-A"]);
    runGit(["-C", resetWorkspace, "reset", "--quiet"]);

    const noGitWorkspace = path.join(fixture.root, "no-git");
    copyWorkingTree(fixture.baselineRepo, noGitWorkspace);
    writeFileSync(path.join(noGitWorkspace, "source.txt"), "same final state\n", "utf8");
    writeFileSync(path.join(noGitWorkspace, "new.txt"), "new file\n", "utf8");

    const damagedGitWorkspace = path.join(fixture.root, "damaged-git");
    cpSync(noGitWorkspace, damagedGitWorkspace, { recursive: true, dereference: false });
    writeFileSync(path.join(damagedGitWorkspace, ".git"), "not valid git metadata\n", "utf8");

    const committedReport = exportFixture(fixture, committedWorkspace, "committed");
    const resetReport = exportFixture(fixture, resetWorkspace, "reset");
    const noGitReport = exportFixture(fixture, noGitWorkspace, "no-git");
    const damagedGitReport = exportFixture(fixture, damagedGitWorkspace, "damaged-git");
    assert.equal(committedReport.status, "produced");
    assert.equal(resetReport.status, "produced");
    assert.equal(noGitReport.status, "produced");
    assert.equal(damagedGitReport.status, "produced");
    for (const report of [resetReport, noGitReport, damagedGitReport]) {
      assert.equal(committedReport.patchSha256, report.patchSha256);
      assert.equal(committedReport.targetTreeSha, report.targetTreeSha);
    }
    const expectedPatch = readFileSync(path.join(fixture.root, "committed.patch"));
    for (const name of ["reset", "no-git", "damaged-git"]) {
      assert.deepEqual(expectedPatch, readFileSync(path.join(fixture.root, `${name}.patch`)));
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

contractTest("runtime.process", "workspace patch exporter distinguishes empty workspaces from infrastructure failures", () => {
  const fixture = createFixture();
  try {
    const workspace = path.join(fixture.root, "workspace");
    copyWorkingTree(fixture.baselineRepo, workspace);
    const emptyReport = exportFixture(fixture, workspace, "empty");
    assert.equal(emptyReport.status, "empty");
    assert.equal(emptyReport.patchBytes, 0);
    assert.equal(emptyReport.validation.applies, true);
    assert.equal(emptyReport.validation.treeMatches, true);
    assert.equal(readFileSync(path.join(fixture.root, "empty.patch")).length, 0);

    const failedReport = exportSweVerifiedWorkspacePatch({
      workspaceRoot: workspace,
      baselineRepo: path.join(fixture.root, "missing-baseline"),
      sourceBaseCommit: fixture.baseCommit,
      baseCommit: fixture.baseCommit,
      patchPath: path.join(fixture.root, "failed.patch"),
      reportPath: path.join(fixture.root, "failed-report.json"),
      kestrelExitCode: 1,
    });
    assert.equal(failedReport.status, "failed");
    assert.equal(failedReport.failureStage, "validate_input");
    assert.equal(existsSync(path.join(fixture.root, "failed.patch")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

contractTest("runtime.process", "workspace patch exporter fails closed when patch validation fails", () => {
  const fixture = createFixture();
  try {
    const workspace = path.join(fixture.root, "workspace");
    copyWorkingTree(fixture.baselineRepo, workspace);
    writeFileSync(path.join(workspace, "source.txt"), "validation should fail\n", "utf8");

    const report = exportSweVerifiedWorkspacePatch({
      ...exportInput(fixture, workspace, "validation-failure"),
      spawn: ((command, args, options) => {
        if (command === "git" && Array.isArray(args) && args[0] === "apply" && args.includes("--check")) {
          return failedSpawn("injected validation failure");
        }
        return spawnSync(command, args, options as never) as SpawnSyncReturns<Buffer>;
      }) as typeof spawnSync,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.failureStage, "check_patch");
    assert.equal(report.stages.at(-1)?.status, "failed");
    assert.equal(existsSync(path.join(fixture.root, "validation-failure.patch")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

interface Fixture {
  root: string;
  baselineRepo: string;
  baseCommit: string;
  preparedCommit: string;
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-exporter-"));
  const baselineRepo = path.join(root, "baseline");
  mkdirSync(path.join(baselineRepo, ".pytest_cache"), { recursive: true });
  runGit(["init", "--quiet", baselineRepo]);
  writeFileSync(path.join(baselineRepo, ".gitignore"), "*.generated\n__pycache__/\n.pytest_cache/\n", "utf8");
  writeFileSync(path.join(baselineRepo, "source.txt"), "original source\n", "utf8");
  writeFileSync(path.join(baselineRepo, "deleted.txt"), "delete me\n", "utf8");
  writeFileSync(path.join(baselineRepo, "script.sh"), "#!/bin/sh\necho original\n", "utf8");
  writeFileSync(path.join(baselineRepo, ".pytest_cache", "tracked.txt"), "tracked cache\n", "utf8");
  runGit(["-C", baselineRepo, "add", "-f", "."]);
  runGit([
    "-C",
    baselineRepo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "baseline",
  ]);
  const baseCommit = runGit(["-C", baselineRepo, "rev-parse", "HEAD"]).stdout.toString("utf8").trim();
  const baselineReport = captureSweVerifiedWorkspaceBaseline({
    workspaceRoot: baselineRepo,
    baselineRepo,
    sourceBaseCommit: baseCommit,
    reportPath: path.join(root, "default-baseline-report.json"),
  });
  assert.equal(baselineReport.status, "captured", JSON.stringify(baselineReport, null, 2));
  assert.ok(baselineReport.baselineCommit);
  return { root, baselineRepo, baseCommit, preparedCommit: baselineReport.baselineCommit } as Fixture;
}

function copyWorkingTree(source: string, target: string): void {
  cpSync(source, target, {
    recursive: true,
    dereference: false,
    filter: (sourcePath) => path.basename(sourcePath) !== ".git",
  });
}

function exportFixture(fixture: Fixture, workspaceRoot: string, name: string) {
  return exportSweVerifiedWorkspacePatch(exportInput(fixture, workspaceRoot, name));
}

function exportInput(fixture: Fixture, workspaceRoot: string, name: string): ExportSweWorkspacePatchInput {
  return {
    workspaceRoot,
    baselineRepo: fixture.baselineRepo,
    sourceBaseCommit: fixture.baseCommit,
    baseCommit: fixture.preparedCommit,
    patchPath: path.join(fixture.root, `${name}.patch`),
    reportPath: path.join(fixture.root, `${name}-report.json`),
    kestrelExitCode: 0,
  };
}

function runGit(args: string[]): SpawnSyncReturns<Buffer> {
  const result = spawnSync("git", args, { encoding: "buffer" });
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  return result;
}

function failedSpawn(stderr: string): SpawnSyncReturns<Buffer> {
  return {
    pid: 123,
    output: [null, Buffer.from(""), Buffer.from(stderr)],
    stdout: Buffer.from(""),
    stderr: Buffer.from(stderr),
    status: 1,
    signal: null,
  };
}
