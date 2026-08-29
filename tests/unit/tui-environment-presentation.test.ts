import test from "node:test";
import assert from "node:assert/strict";

import {
  describeTuiEnvironmentPreset,
  formatTuiAssemblyLabel,
  formatTuiEnvironmentLabel,
} from "../../cli/session/TuiEnvironmentPresentation.js";

test("TUI environment presentation maps every product environment identity", () => {
  assert.deepEqual(describeTuiEnvironmentPreset("cli_dev_local"), {
    label: "Developer workspace",
    detail:
      "Uses tools installed in the selected local workspace, subject to the active execution policy.",
  });
  assert.equal(formatTuiEnvironmentLabel("workspace_hosted"), "Developer workspace (hosted)");
  assert.equal(formatTuiEnvironmentLabel("cli_safe_local"), "Safe sandbox");
});

test("normal TUI environment and assembly labels never expose raw or unsupported identities", () => {
  assert.equal(formatTuiAssemblyLabel("cli_dev_local"), "Kestrel on Developer workspace");
  assert.equal(
    formatTuiAssemblyLabel("workspace_hosted"),
    "Kestrel on Developer workspace (hosted)",
  );
  assert.equal(formatTuiAssemblyLabel("cli_safe_local"), "Kestrel on Safe sandbox");
  assert.equal(formatTuiEnvironmentLabel("cli_future_local"), "Environment unknown");
  assert.equal(formatTuiAssemblyLabel(undefined), "Kestrel on Environment unknown");
});
