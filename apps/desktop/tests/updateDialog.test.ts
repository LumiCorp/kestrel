import assert from "node:assert/strict";

import type { DesktopUpdateState } from "../src/contracts.js";
import {
  buildDesktopUpdateDialog,
  resolveDesktopUpdateDialogAction,
} from "../src/updateDialog.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

function state(
  phase: DesktopUpdateState["phase"],
): DesktopUpdateState {
  return {
    supported: phase !== "unsupported",
    phase,
    currentVersion: "0.6.0",
    targetVersion: "0.7.0",
    blockers: phase === "blocked"
      ? [{
          source: "desktop",
          code: "DESKTOP_EXECUTIONS_ACTIVE",
          message: "Desktop workspace executions are active.",
          count: 1,
        }]
      : [],
    message: `state: ${phase}`,
  };
}

contractTest(
  "desktop.hermetic",
  "native update dialog maps available updates to Download or Later",
  () => {
    const available = state("available");
    assert.deepEqual(buildDesktopUpdateDialog(available).buttons, [
      "Download",
      "Later",
    ]);
    assert.equal(resolveDesktopUpdateDialogAction(available, 0), "download");
    assert.equal(resolveDesktopUpdateDialogAction(available, 1), "later");
  },
);

contractTest(
  "desktop.hermetic",
  "native update dialog maps downloaded and blocked updates to install retry",
  () => {
    for (const phase of ["downloaded", "blocked"] as const) {
      const update = state(phase);
      assert.deepEqual(buildDesktopUpdateDialog(update).buttons, [
        "Restart and Install",
        "Later",
      ]);
      assert.equal(resolveDesktopUpdateDialogAction(update, 0), "install");
      assert.equal(resolveDesktopUpdateDialogAction(update, 1), "later");
    }
  },
);

contractTest(
  "desktop.hermetic",
  "informational update states dismiss without an action",
  () => {
    const idle = state("idle");
    assert.deepEqual(buildDesktopUpdateDialog(idle).buttons, ["OK"]);
    assert.equal(resolveDesktopUpdateDialogAction(idle, 0), "dismiss");
  },
);
