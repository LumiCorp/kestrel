import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  applyKestrelUninstallPlan,
  createKestrelUninstallPlan,
  type KestrelUninstallCoordinatorOperations,
} from "../../src/uninstall/coordinator.js";
import type { ManagedTaskWorktreeInventoryEntry } from "../../src/workspace/ManagedTaskWorktreeService.js";
import type {
  KestrelUninstallBlocker,
  KestrelUninstallKestrelOneSummary,
  KestrelUninstallLifecycle,
  KestrelUninstallTarget,
  KestrelUninstallWorktreeSummary,
} from "../../src/uninstall/contracts.js";
import { contractTest } from "../helpers/contract-test.js";

const execFileAsync = promisify(execFile);

contractTest("runtime.hermetic", "uninstall apply rejects stale target fingerprints", async () => {
  let fingerprint = "first";
  const operations = baseOperations(() => [packageTarget({ fingerprint })]);
  const plan = await createKestrelUninstallPlan({
    initiator: "cli",
    scope: "current_component",
    platform: "darwin",
    operations,
  });

  fingerprint = "second";
  const result = await applyKestrelUninstallPlan({
    plan,
    confirmPlanId: plan.planId,
    operations,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.blockers[0]?.code, "UNINSTALL_PLAN_STALE");
});

contractTest("runtime.hermetic", "uninstall dry-run skips selected targets without removal", async () => {
  let removed = false;
  const operations = baseOperations(() => [packageTarget()]);
  operations.runPackageManager = async () => {
    removed = true;
  };
  const plan = await createKestrelUninstallPlan({
    initiator: "cli",
    scope: "current_component",
    platform: "darwin",
    operations,
  });

  const result = await applyKestrelUninstallPlan({
    plan,
    confirmPlanId: plan.planId,
    dryRun: true,
    operations,
  });

  assert.equal(result.status, "applied");
  assert.deepEqual(result.skippedTargets, ["cli.package.fixture"]);
  assert.equal(removed, false);
});

contractTest("runtime.hermetic", "uninstall apply delegates package removal and verifies final inventory", async () => {
  let removed = false;
  let command: string[] | undefined;
  const operations = baseOperations(() => removed ? [] : [packageTarget()]);
  operations.runPackageManager = async (input) => {
    command = input;
    removed = true;
  };
  const plan = await createKestrelUninstallPlan({
    initiator: "cli",
    scope: "current_component",
    platform: "darwin",
    operations,
  });

  const result = await applyKestrelUninstallPlan({
    plan,
    confirmPlanId: plan.planId,
    operations,
  });

  assert.equal(result.status, "applied");
  assert.deepEqual(command, ["/usr/local/bin/npm", "uninstall", "--global", "@kestrel-agents/kestrel"]);
  assert.deepEqual(result.removedTargets, ["cli.package.fixture"]);
  assert.deepEqual(result.finalTargets, []);
});

contractTest("runtime.hermetic", "uninstall apply propagates lifecycle blockers before destructive work", async () => {
  let removed = false;
  const blocker: KestrelUninstallBlocker = {
    code: "LOCAL_CORE_BUSY",
    message: "fixture busy blocker",
  };
  const operations = baseOperations(() => [packageTarget()]);
  operations.inspectLifecycle = async () => ({
    state: "busy",
    blockers: [blocker],
  });
  operations.runPackageManager = async () => {
    removed = true;
  };
  const plan = await createKestrelUninstallPlan({
    initiator: "cli",
    scope: "current_component",
    platform: "darwin",
    operations,
  });

  const result = await applyKestrelUninstallPlan({
    plan,
    confirmPlanId: plan.planId,
    operations,
  });

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockers, [blocker]);
  assert.equal(removed, false);
});

contractTest("runtime.hermetic", "uninstall apply retries idempotently when a selected target is already gone", async () => {
  let inventoryPresent = true;
  let removed = 0;
  const operations = baseOperations(() => inventoryPresent ? [packageTarget()] : []);
  operations.runPackageManager = async () => {
    removed += 1;
    inventoryPresent = false;
  };
  const plan = await createKestrelUninstallPlan({
    initiator: "cli",
    scope: "current_component",
    platform: "darwin",
    operations,
  });
  assert.equal((await applyKestrelUninstallPlan({ plan, confirmPlanId: plan.planId, operations })).status, "applied");

  const retry = await applyKestrelUninstallPlan({ plan, confirmPlanId: plan.planId, operations });

  assert.equal(retry.status, "applied");
  assert.deepEqual(retry.skippedTargets, ["cli.package.fixture"]);
  assert.equal(removed, 1);
});

contractTest("runtime.hermetic", "uninstall apply reports Kestrel One disconnect failures as partial and nonblocking", async () => {
  const operations = baseOperations(() => []);
  operations.inspectKestrelOne = async (input) => ({
    disconnectSelected: input.disconnectSelected,
    environments: [
      {
        connectionId: "connection-offline",
        organizationId: "organization-fixture",
        baseUrl: "https://kestrel.invalid",
        status: "offline",
      },
    ],
  });
  operations.disconnectKestrelOne = async () => {
    throw new Error("network unavailable");
  };
  const plan = await createKestrelUninstallPlan({
    initiator: "cli",
    scope: "current_component",
    platform: "darwin",
    options: { disconnectKestrelOne: true },
    operations,
  });

  const result = await applyKestrelUninstallPlan({ plan, confirmPlanId: plan.planId, operations });

  assert.equal(result.status, "partial");
  assert.equal(result.blockers[0]?.code, "KESTREL_ONE_DISCONNECT_FAILED");
  assert.match(result.blockers[0]?.message ?? "", /connection-offline/u);
  assert.match(result.blockers[0]?.message ?? "", /network unavailable/u);
});

contractTest("runtime.hermetic", "uninstall apply treats scheduled CLI self-removal as nonblocking", async () => {
  const target: KestrelUninstallTarget = {
    id: "cli.bundle.fixture",
    kind: "cli_bundle",
    path: process.execPath,
    verified: true,
    selected: true,
    removal: "rm",
    fingerprint: "fixture",
    evidence: ["fixture running CLI bundle"],
  };
  let scheduled = false;
  const operations = baseOperations(() => [target]);
  operations.scheduleCliFinalizer = async () => {
    scheduled = true;
  };
  const plan = await createKestrelUninstallPlan({
    initiator: "cli",
    scope: "current_component",
    platform: "darwin",
    operations,
  });

  const result = await applyKestrelUninstallPlan({ plan, confirmPlanId: plan.planId, operations });

  assert.equal(scheduled, true);
  assert.equal(result.status, "partial", JSON.stringify(result.blockers, null, 2));
  assert.equal(result.blockers[0]?.code, "UNINSTALL_CLI_FINALIZER_SCHEDULED");
  assert.equal(
    result.blockers.some((blocker) => blocker.code === "UNINSTALL_FINAL_VERIFICATION_FAILED"),
    false,
  );
});

contractTest("runtime.hermetic", "uninstall apply defers Desktop helper targets without failing final verification", async () => {
  const target: KestrelUninstallTarget = {
    id: "desktop.bundle.fixture",
    kind: "desktop_bundle",
    path: "/Applications/Kestrel.app",
    verified: true,
    selected: true,
    removal: "trash",
    fingerprint: "fixture",
    evidence: ["fixture Desktop bundle"],
  };
  let removed = false;
  const operations = baseOperations(() => [target]);
  operations.trashPath = async () => {
    removed = true;
  };
  const plan = await createKestrelUninstallPlan({
    initiator: "desktop",
    scope: "current_component",
    platform: "darwin",
    operations,
  });

  const result = await applyKestrelUninstallPlan({
    plan,
    confirmPlanId: plan.planId,
    deferredTargetIds: [target.id],
    operations,
  });

  assert.equal(result.status, "applied", JSON.stringify(result.blockers, null, 2));
  assert.equal(removed, false);
  assert.deepEqual(result.skippedTargets, [target.id]);
});

contractTest("runtime.hermetic", "uninstall apply recovers retained managed worktrees through injected operations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-uninstall-worktree-"));
  try {
    const exportRoot = path.join(root, "exports");
    let removed = false;
    let recovered: { exportRoot: string; ignoredFiles: string[] } | undefined;
    const operations = baseOperations(() => []);
    operations.inspectWorktrees = async () => removed ? emptyWorktrees() : retainedWorktrees();
    operations.listManagedWorktrees = async () => removed ? [] : [managedWorktreeEntry(path.join(root, "wt"))];
    operations.listGitFiles = async (_worktreeRoot, args) =>
      args.includes("--ignored") ? [] : ["untracked.txt"];
    operations.createRecoveryBundle = async (_entry, outputRoot, ignoredFiles) => {
      recovered = { exportRoot: outputRoot, ignoredFiles };
      await writeFile(path.join(outputRoot, "fixture-recovery"), "ok", "utf8");
    };
    operations.removeManagedWorktree = async () => {
      removed = true;
    };
    const plan = await createKestrelUninstallPlan({
      initiator: "cli",
      scope: "complete",
      platform: "darwin",
      options: { exportWorktreesDirectory: exportRoot },
      operations,
    });

    const result = await applyKestrelUninstallPlan({
      plan,
      confirmPlanId: plan.planId,
      deleteDataPhrase: "DELETE KESTREL DATA",
      operations,
    });

    assert.equal(result.status, "applied");
    assert.equal(removed, true);
    assert.deepEqual(recovered, { exportRoot: await realpath(exportRoot), ignoredFiles: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "uninstall apply blocks retained worktree deletion when ignored files lack discard confirmation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-uninstall-ignored-"));
  try {
    const operations = baseOperations(() => []);
    operations.inspectWorktrees = async () => retainedWorktrees();
    operations.listManagedWorktrees = async () => [managedWorktreeEntry(path.join(root, "wt"))];
    operations.listGitFiles = async (_worktreeRoot, args) =>
      args.includes("--ignored") ? ["ignored.bin"] : [];
    const plan = await createKestrelUninstallPlan({
      initiator: "cli",
      scope: "complete",
      platform: "darwin",
      options: { exportWorktreesDirectory: path.join(root, "exports") },
      operations,
    });

    const result = await applyKestrelUninstallPlan({
      plan,
      confirmPlanId: plan.planId,
      deleteDataPhrase: "DELETE KESTREL DATA",
      operations,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blockers[0]?.code, "UNINSTALL_WORKTREE_IGNORED_FILES_REQUIRE_DISCARD");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "uninstall recovery bundle captures commits patches untracked ignored metadata and checksums", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-uninstall-recovery-"));
  try {
    const sourceRepo = path.join(root, "repo");
    const worktreeRoot = path.join(root, "managed-worktree");
    const exportRoot = path.join(root, "exports");
    await mkdir(sourceRepo, { recursive: true });
    await git(sourceRepo, ["init"]);
    await git(sourceRepo, ["config", "user.email", "kestrel@example.invalid"]);
    await git(sourceRepo, ["config", "user.name", "Kestrel Test"]);
    await writeFile(path.join(sourceRepo, "tracked.txt"), "base\n", "utf8");
    await writeFile(path.join(sourceRepo, ".gitignore"), "ignored.bin\n", "utf8");
    await git(sourceRepo, ["add", "."]);
    await git(sourceRepo, ["commit", "-m", "base"]);
    const baseHead = (await git(sourceRepo, ["rev-parse", "HEAD"])).trim();
    await git(sourceRepo, ["worktree", "add", "-b", "kestrel-managed", worktreeRoot]);
    await writeFile(path.join(worktreeRoot, "committed.txt"), "committed\n", "utf8");
    await git(worktreeRoot, ["add", "committed.txt"]);
    await git(worktreeRoot, ["commit", "-m", "managed commit"]);
    await writeFile(path.join(worktreeRoot, "staged.txt"), "staged\n", "utf8");
    await git(worktreeRoot, ["add", "staged.txt"]);
    await writeFile(path.join(worktreeRoot, "tracked.txt"), "base\nunstaged\n", "utf8");
    await writeFile(path.join(worktreeRoot, "untracked.txt"), "untracked\n", "utf8");
    await writeFile(path.join(worktreeRoot, "ignored.bin"), "ignored-content\n", "utf8");

    let removed = false;
    const operations = baseOperations(() => []);
    operations.inspectWorktrees = async () => removed ? emptyWorktrees() : retainedWorktreesFor(worktreeRoot);
    operations.listManagedWorktrees = async () => removed ? [] : [managedWorktreeEntry(worktreeRoot, {
      sourceRepoRoot: sourceRepo,
      sourceWorkspaceRoot: sourceRepo,
      baseHead,
    })];
    operations.removeManagedWorktree = async (entry) => {
      await execFileAsync("git", [
        "-C",
        entry.binding.sourceRepoRoot,
        "worktree",
        "remove",
        "--force",
        "--force",
        entry.binding.worktreeRoot,
      ]);
      removed = true;
    };
    const plan = await createKestrelUninstallPlan({
      initiator: "cli",
      scope: "complete",
      platform: "darwin",
      options: {
        exportWorktreesDirectory: exportRoot,
        discardWorktrees: true,
      },
      operations,
    });

    const discardPhrase = plan.confirmations.find((entry) => entry.kind === "discard_worktrees")?.phrase;
    assert.ok(discardPhrase);
    const result = await applyKestrelUninstallPlan({
      plan,
      confirmPlanId: plan.planId,
      deleteDataPhrase: "DELETE KESTREL DATA",
      discardWorktreesPhrase: discardPhrase,
      operations,
    });

    assert.equal(result.status, "applied", JSON.stringify(result.blockers, null, 2));
    const bundleRoot = path.join(await realpath(exportRoot), `worktree-${sha256(worktreeRoot).slice(0, 16)}`);
    assert.equal((await git(sourceRepo, ["bundle", "verify", path.join(bundleRoot, "commits.bundle")])).includes("is okay"), true);
    assert.match(await readText(path.join(bundleRoot, "staged.patch")), /staged\.txt/u);
    assert.match(await readText(path.join(bundleRoot, "unstaged.patch")), /unstaged/u);
    assert.equal(await readText(path.join(bundleRoot, "untracked", "untracked.txt")), "untracked\n");
    const metadata = JSON.parse(await readText(path.join(bundleRoot, "metadata.json"))) as {
      ignored?: { count?: number; bytes?: number };
      untrackedCount?: number;
    };
    assert.equal(metadata.ignored?.count, 1);
    assert.equal(metadata.ignored?.bytes, "ignored-content\n".length);
    assert.equal(metadata.untrackedCount, 1);
    const checksums = JSON.parse(await readText(path.join(bundleRoot, "checksums.json"))) as Record<string, string>;
    assert.ok(checksums["metadata.json"]);
    assert.ok(checksums["restore.sh"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "uninstall inventory recognizes source shims, standalone bundles, package installs, and foreign shims", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-uninstall-inventory-"));
  const previousPnpmHome = process.env.PNPM_HOME;
  const previousHome = process.env.HOME;
  try {
    const pnpmHome = path.join(root, "pnpm");
    const home = path.join(root, "home");
    await mkdir(pnpmHome, { recursive: true });
    await mkdir(home, { recursive: true });
    process.env.PNPM_HOME = pnpmHome;
    process.env.HOME = home;

    await symlink(path.join(process.cwd(), "bin", "kestrel.js"), path.join(pnpmHome, "kestrel"));
    let plan = await createKestrelUninstallPlan({
      initiator: "cli",
      scope: "current_component",
      platform: "darwin",
      env: { ...process.env, PNPM_HOME: pnpmHome, HOME: home },
      operations: observationalOperations(),
    });
    assert.equal(plan.targets.find((target) => target.id === "cli.symlink.kestrel")?.kind, "cli_symlink");

    await rm(path.join(pnpmHome, "kestrel"), { force: true });
    const bundleRoot = path.join(root, "bundle");
    await mkdir(path.join(bundleRoot, "bin"), { recursive: true });
    await writeFile(path.join(bundleRoot, "bin", "kestrel"), "#!/usr/bin/env node\n", "utf8");
    await chmod(path.join(bundleRoot, "bin", "kestrel"), 0o755);
    await writeFile(path.join(bundleRoot, "kestrel-bundle.json"), JSON.stringify({
      version: "kestrel_cli_bundle_v1",
      package: "@kestrel-agents/kestrel",
      entrypoint: "bin/kestrel",
    }), "utf8");
    await symlink(path.join(bundleRoot, "bin", "kestrel"), path.join(pnpmHome, "kestrel"));
    plan = await createKestrelUninstallPlan({
      initiator: "cli",
      scope: "current_component",
      platform: "darwin",
      env: { ...process.env, PNPM_HOME: pnpmHome, HOME: home },
      operations: observationalOperations(),
    });
    assert.ok(plan.targets.some((target) => target.kind === "cli_bundle" && target.verified));

    await rm(path.join(pnpmHome, "kestrel"), { force: true });
    const npmRoot = path.join(root, "npm-root");
    const packageRoot = path.join(npmRoot, "@kestrel-agents", "kestrel");
    await mkdir(path.join(packageRoot, "bin"), { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "@kestrel-agents/kestrel",
      bin: { kestrel: "bin/kestrel" },
    }), "utf8");
    await writeFile(path.join(packageRoot, "bin", "kestrel"), "#!/usr/bin/env node\n", "utf8");
    await chmod(path.join(packageRoot, "bin", "kestrel"), 0o755);
    const npmBin = path.join(root, "npm");
    await writeFile(npmBin, `#!/usr/bin/env sh\nif [ "$1" = "root" ]; then echo "${npmRoot}"; exit 0; fi\nexit 0\n`, "utf8");
    await chmod(npmBin, 0o755);
    await symlink(path.join(packageRoot, "bin", "kestrel"), path.join(pnpmHome, "kestrel"));
    plan = await createKestrelUninstallPlan({
      initiator: "cli",
      scope: "current_component",
      platform: "darwin",
      env: { ...process.env, PNPM_HOME: pnpmHome, HOME: home, KESTREL_UNINSTALL_NPM_PATH: npmBin },
      operations: observationalOperations(),
    });
    assert.ok(plan.targets.some((target) => target.kind === "cli_package" && target.removal === "package_manager"));

    await rm(path.join(pnpmHome, "kestrel"), { force: true });
    const foreign = path.join(root, "foreign");
    await writeFile(foreign, "#!/usr/bin/env sh\n", "utf8");
    await chmod(foreign, 0o755);
    await symlink(foreign, path.join(pnpmHome, "kestrel"));
    plan = await createKestrelUninstallPlan({
      initiator: "cli",
      scope: "current_component",
      platform: "darwin",
      env: { ...process.env, PNPM_HOME: pnpmHome, HOME: home },
      operations: observationalOperations(),
    });
    assert.equal(plan.targets.find((target) => target.id === "cli.symlink.kestrel")?.verified, false);
    assert.ok(plan.blockers.some((blocker) => blocker.code === "UNINSTALL_TARGET_UNVERIFIED"));
  } finally {
    if (previousPnpmHome === undefined) delete process.env.PNPM_HOME;
    else process.env.PNPM_HOME = previousPnpmHome;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "uninstall apply unloads kcron through its exact target without shutting down Core", async () => {
  let unloaded = false;
  let shutdown = false;
  const operations = baseOperations(() => [{
    id: "kcron.launch_agent",
    kind: "kcron_launch_agent",
    path: "/tmp/com.kestrel.kcron.plist",
    verified: true,
    selected: true,
    removal: "unlink",
    fingerprint: "kcron",
    evidence: ["fixture"],
  }]);
  operations.unloadKcron = async () => {
    unloaded = true;
  };
  operations.shutdownLocalCore = async () => {
    shutdown = true;
  };
  operations.inventoryTargets = async () => unloaded ? [] : [{
    id: "kcron.launch_agent",
    kind: "kcron_launch_agent",
    path: "/tmp/com.kestrel.kcron.plist",
    verified: true,
    selected: true,
    removal: "unlink",
    fingerprint: "kcron",
    evidence: ["fixture"],
  }];
  const plan = await createKestrelUninstallPlan({
    initiator: "cli",
    scope: "current_component",
    platform: "darwin",
    operations,
  });

  const result = await applyKestrelUninstallPlan({ plan, confirmPlanId: plan.planId, operations });

  assert.equal(result.status, "applied");
  assert.equal(unloaded, true);
  assert.equal(shutdown, false);
});

contractTest("runtime.hermetic", "complete uninstall purges an empty Keychain service idempotently before data deletion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-uninstall-keychain-"));
  let purged = 0;
  let removedData = false;
  try {
    const dataPath = path.join(root, "data");
    await mkdir(dataPath, { recursive: true });
    const operations = baseOperations(() => removedData ? [keychainTarget()] : [keychainTarget(), dataTarget(dataPath)]);
    operations.purgeKeychain = async () => {
      purged += 1;
    };
    operations.removePath = async () => {
      removedData = true;
      await rm(dataPath, { recursive: true, force: true });
    };
    const plan = await createKestrelUninstallPlan({
      initiator: "cli",
      scope: "complete",
      platform: "darwin",
      operations,
    });

    const result = await applyKestrelUninstallPlan({
      plan,
      confirmPlanId: plan.planId,
      deleteDataPhrase: "DELETE KESTREL DATA",
      operations,
    });

    assert.equal(result.status, "applied", JSON.stringify(result.blockers, null, 2));
    assert.equal(purged, 1);
    assert.equal(removedData, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "complete uninstall reports custom Core homes but does not select them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-uninstall-custom-home-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = path.join(root, "home");
    await mkdir(process.env.HOME, { recursive: true });
    const customHome = path.join(root, "custom-core");
    await mkdir(customHome, { recursive: true });
    const plan = await createKestrelUninstallPlan({
      initiator: "cli",
      scope: "complete",
      platform: "darwin",
      env: { ...process.env, KESTREL_CORE_HOME: customHome, HOME: process.env.HOME },
      operations: observationalOperations(),
    });

    const customTarget = plan.targets.find((target) => target.id === "state.custom_core_home");
    assert.equal(customTarget?.selected, false);
    assert.equal(customTarget?.removal, "manual");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

function baseOperations(
  inventory: () => KestrelUninstallTarget[],
): KestrelUninstallCoordinatorOperations {
  return {
    now: () => new Date("2026-07-28T00:00:00.000Z"),
    inventoryTargets: async () => inventory(),
    inspectLifecycle: async (): Promise<KestrelUninstallLifecycle> => ({
      state: "missing",
      blockers: [],
    }),
    inspectWorktrees: async (): Promise<KestrelUninstallWorktreeSummary> => ({
      cleanDisposable: 0,
      retained: 0,
      blocked: 0,
      totalBytes: 0,
      entries: [],
    }),
    inspectKestrelOne: async (input): Promise<KestrelUninstallKestrelOneSummary> => ({
      disconnectSelected: input.disconnectSelected,
      environments: [],
    }),
    listManagedWorktrees: async () => [],
  };
}

function observationalOperations(): KestrelUninstallCoordinatorOperations {
  const operations = baseOperations(() => []);
  delete operations.inventoryTargets;
  return operations;
}

function packageTarget(input: { fingerprint?: string } = {}): KestrelUninstallTarget {
  return {
    id: "cli.package.fixture",
    kind: "cli_package",
    path: "/tmp/kestrel-package-fixture",
    verified: true,
    selected: true,
    removal: "package_manager",
    command: ["/usr/local/bin/npm", "uninstall", "--global", "@kestrel-agents/kestrel"],
    fingerprint: input.fingerprint ?? "fixture",
    evidence: ["fixture package manager target"],
  };
}

function keychainTarget(): KestrelUninstallTarget {
  return {
    id: "credentials.local_core_keychain_service",
    kind: "keychain_service",
    verified: true,
    selected: true,
    removal: "keychain_purge",
    fingerprint: "keychain",
    evidence: ["fixture"],
  };
}

function dataTarget(targetPath: string): KestrelUninstallTarget {
  return {
    id: "state.default_product_root",
    kind: "state_root",
    path: targetPath,
    verified: true,
    selected: true,
    removal: "rm",
    fingerprint: "data",
    evidence: ["fixture"],
  };
}

function emptyWorktrees(): KestrelUninstallWorktreeSummary {
  return {
    cleanDisposable: 0,
    retained: 0,
    blocked: 0,
    totalBytes: 0,
    entries: [],
  };
}

function retainedWorktrees(): KestrelUninstallWorktreeSummary {
  return retainedWorktreesFor("/tmp/kestrel-worktree-fixture");
}

function retainedWorktreesFor(worktreeRoot: string): KestrelUninstallWorktreeSummary {
  return {
    cleanDisposable: 0,
    retained: 1,
    blocked: 0,
    totalBytes: 42,
    entries: [
      {
        worktreeRoot,
        disposition: "retain_with_snapshot",
        dirty: true,
        aheadCommitCount: 1,
        storageBytes: 42,
        reasons: ["uncommitted_changes"],
      },
    ],
  };
}

function managedWorktreeEntry(
  worktreeRoot: string,
  input: {
    sourceRepoRoot?: string | undefined;
    sourceWorkspaceRoot?: string | undefined;
    baseHead?: string | undefined;
  } = {},
): ManagedTaskWorktreeInventoryEntry {
  const dirtyState = {
    dirty: true,
    porcelain: " M tracked.txt\n?? untracked.txt\n",
    checkedAt: "2026-07-28T00:00:00.000Z",
  };
  const sourceRepoRoot = input.sourceRepoRoot ?? path.dirname(worktreeRoot);
  const sourceWorkspaceRoot = input.sourceWorkspaceRoot ?? sourceRepoRoot;
  const baseHead = input.baseHead ?? "0".repeat(40);
  const binding = {
    status: "bound",
    sessionId: "session-fixture",
    sourceWorkspaceRoot,
    sourceRepoRoot,
    worktreeRoot,
    baseHead,
    lastObservedSourceHead: baseHead,
    scope: { kind: "sessionId", value: "session-fixture" },
    leaseId: "released-lease",
    leaseKind: "run",
    createdBySessionId: "session-fixture",
    dirtyState,
    triggeringTool: "managed_worktree.fan_in",
    boundAt: "2026-07-28T00:00:00.000Z",
  };
  return {
    binding,
    inspection: {
      status: "valid",
      binding,
      activeProcesses: [],
      dirtyState,
      storageBytes: 42,
      storageScanTruncated: false,
      aheadCommitCount: 1,
      staleBase: false,
      setup: {
        status: "completed",
        attempts: 1,
        approvedIgnoredFiles: [],
        completedStepIds: [],
        completedAt: "2026-07-28T00:00:00.000Z",
      },
      retention: {
        policy: "retain_until_explicit_cleanup",
        disposition: "retain_with_snapshot",
        reasons: ["uncommitted_changes"],
      },
    },
  } as unknown as ManagedTaskWorktreeInventoryEntry;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd });
  return `${stdout}${stderr}`;
}

async function readText(filePath: string): Promise<string> {
  return await readFile(filePath, "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
