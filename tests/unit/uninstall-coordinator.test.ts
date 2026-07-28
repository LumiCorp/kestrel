import assert from "node:assert/strict";

import {
  applyKestrelUninstallPlan,
  createKestrelUninstallPlan,
  type KestrelUninstallCoordinatorOperations,
} from "../../src/uninstall/coordinator.js";
import type {
  KestrelUninstallBlocker,
  KestrelUninstallKestrelOneSummary,
  KestrelUninstallLifecycle,
  KestrelUninstallTarget,
  KestrelUninstallWorktreeSummary,
} from "../../src/uninstall/contracts.js";
import { contractTest } from "../helpers/contract-test.js";

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
  };
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
