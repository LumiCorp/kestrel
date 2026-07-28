import assert from "node:assert/strict";

import {
  KESTREL_UNINSTALL_APPLY_RESULT_VERSION,
  KESTREL_UNINSTALL_COMPLETION_REPORT_VERSION,
  KESTREL_UNINSTALL_PLAN_VERSION,
  parseKestrelUninstallApplyResultV1,
  parseKestrelUninstallCompletionReportV1,
  parseKestrelUninstallPlanV1,
  parseKestrelUninstallScope,
  type KestrelUninstallPlanV1,
} from "../../src/uninstall/contracts.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest("runtime.hermetic", "uninstall scope accepts public aliases", () => {
  assert.equal(parseKestrelUninstallScope("current"), "current_component");
  assert.equal(parseKestrelUninstallScope("software"), "all_software");
  assert.equal(parseKestrelUninstallScope("complete"), "complete");
  assert.throws(() => parseKestrelUninstallScope("everything"), /scope/u);
});

contractTest("runtime.hermetic", "UninstallPlanV1 rejects unknown fields", () => {
  const plan = minimalPlan();
  assert.equal(parseKestrelUninstallPlanV1(plan).planId, "plan-test");
  assert.throws(
    () => parseKestrelUninstallPlanV1({ ...plan, extra: true }),
    /unsupported field 'extra'/u,
  );
  assert.throws(
    () =>
      parseKestrelUninstallPlanV1({
        ...plan,
        targets: [{ ...plan.targets[0]!, surprise: true }],
      }),
    /unsupported field 'surprise'/u,
  );
});

contractTest("runtime.hermetic", "UninstallPlanV1 preserves package manager command arrays", () => {
  const plan = minimalPlan();
  const parsed = parseKestrelUninstallPlanV1({
    ...plan,
    targets: [
      {
        ...plan.targets[0]!,
        kind: "cli_package",
        removal: "package_manager",
        command: ["/opt/homebrew/bin/pnpm", "remove", "--global", "@kestrel-agents/kestrel"],
      },
    ],
  });
  assert.deepEqual(parsed.targets[0]?.command, [
    "/opt/homebrew/bin/pnpm",
    "remove",
    "--global",
    "@kestrel-agents/kestrel",
  ]);
});

contractTest("runtime.hermetic", "UninstallApplyResultV1 strictly parses structured outcomes", () => {
  const result = {
    version: KESTREL_UNINSTALL_APPLY_RESULT_VERSION,
    planId: "plan-test",
    appliedAt: "2026-07-28T00:00:01.000Z",
    status: "partial",
    removedTargets: ["state.default_product_root"],
    skippedTargets: ["desktop.bundle.fixture"],
    blockers: [],
    finalTargets: [],
    kestrelOneDisconnects: [
      {
        connectionId: "connection-fixture",
        baseUrl: "https://kestrel.invalid",
        status: "failed",
        errorCode: "OFFLINE",
        message: "network unavailable",
      },
    ],
    deferredCompletions: [
      {
        executor: "desktop_helper",
        state: "scheduled",
        reportPath:
          "/private/var/tmp/com.kestrel.uninstall/plan-test/desktop-helper.json",
      },
    ],
  };
  assert.deepEqual(
    parseKestrelUninstallApplyResultV1(result),
    result,
  );
  assert.throws(
    () => parseKestrelUninstallApplyResultV1({ ...result, extra: true }),
    /unsupported field 'extra'/u,
  );
  assert.throws(
    () =>
      parseKestrelUninstallApplyResultV1({
        ...result,
        deferredCompletions: [
          { ...result.deferredCompletions[0], state: "unknown" },
        ],
      }),
    /deferred completion\.state is invalid/u,
  );
});

contractTest("runtime.hermetic", "uninstall completion reports are strict and versioned", () => {
  const report = {
    version: KESTREL_UNINSTALL_COMPLETION_REPORT_VERSION,
    executor: "cli_finalizer",
    planId: "plan-test",
    status: "partial",
    completedAt: "2026-07-28T00:00:02.000Z",
    removedTargets: [],
    failures: [
      {
        targetId: "cli.bundle.fixture",
        code: "UNINSTALL_TARGET_REMOVE_FAILED",
        message: "permission denied",
      },
    ],
    reportPath:
      "/private/var/tmp/com.kestrel.uninstall/plan-test/cli-finalizer.json",
  } as const;
  assert.deepEqual(parseKestrelUninstallCompletionReportV1(report), report);
  assert.throws(
    () =>
      parseKestrelUninstallCompletionReportV1({
        ...report,
        failures: [{ ...report.failures[0], secret: "must reject" }],
      }),
    /unsupported field 'secret'/u,
  );
});

function minimalPlan(): KestrelUninstallPlanV1 {
  return {
    version: KESTREL_UNINSTALL_PLAN_VERSION,
    planId: "plan-test",
    generatedAt: "2026-07-28T00:00:00.000Z",
    platform: "darwin",
    initiator: "cli",
    scope: "current_component",
    options: {
      disconnectKestrelOne: false,
      exportWorktreesDirectory: "",
      discardWorktrees: false,
    },
    targets: [
      {
        id: "cli.symlink.kestrel",
        kind: "cli_symlink",
        path: "/tmp/kestrel",
        verified: true,
        selected: true,
        removal: "unlink",
        fingerprint: "fingerprint",
        evidence: ["fixture"],
      },
    ],
    lifecycle: {
      state: "missing",
      blockers: [],
    },
    worktrees: {
      cleanDisposable: 0,
      retained: 0,
      blocked: 0,
      totalBytes: 0,
      entries: [],
    },
    kestrelOne: {
      disconnectSelected: false,
      environments: [],
    },
    confirmations: [{ kind: "plan_id", phrase: "plan-test" }],
    blockers: [],
  };
}
