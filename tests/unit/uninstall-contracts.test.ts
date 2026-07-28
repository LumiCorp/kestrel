import assert from "node:assert/strict";

import {
  KESTREL_UNINSTALL_PLAN_VERSION,
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
