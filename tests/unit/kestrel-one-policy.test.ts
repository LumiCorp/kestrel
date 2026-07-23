import assert from "node:assert/strict";

import {
  assertRequiredKestrelOneTools,
  composeKestrelOneProfile,
  KESTREL_ONE_DIALOG_TOOL_NAMES,
  KESTREL_ONE_ENVIRONMENT_PRESETS,
  KESTREL_ONE_POLICY,
} from "../../src/profile/kestrelOnePolicy.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest("runtime.hermetic", "canonical Kestrel One policy composes isolated product environments", () => {
  const cli = composeKestrelOneProfile({
    environmentPresetId: "cli_dev_local",
  });
  const desktop = composeKestrelOneProfile({
    environmentPresetId: "desktop_dev_local",
  });
  const hosted = composeKestrelOneProfile({
    environmentPresetId: "workspace_hosted",
  });

  for (const composed of [cli, desktop, hosted]) {
    assert.equal(composed.profile.agentProfileId, "kestrel-one");
    assert.equal(
      composed.provenance.environmentPresetVersion,
      KESTREL_ONE_ENVIRONMENT_PRESETS[
        composed.provenance.environmentPresetId
      ].version,
    );
    assert.equal(composed.profile.delegation?.allowAgentSpawn, true);
    assert.deepEqual(
      composed.profile.toolAllowlist?.filter(
        (name) =>
          name.startsWith("dialog.") ||
          name.startsWith("delegate.") ||
          name === "agent.spawn",
      ),
      [...KESTREL_ONE_DIALOG_TOOL_NAMES],
    );
  }

  assert.equal(cli.profile.toolAllowlist?.includes("desktop.host.open"), false);
  assert.equal(
    cli.profile.toolAllowlist?.includes(
      "kestrel_one.search_knowledge_documents",
    ),
    false,
  );
  assert.equal(
    desktop.profile.toolAllowlist?.includes("desktop.host.open"),
    true,
  );
  assert.equal(
    desktop.profile.toolAllowlist?.includes(
      "kestrel_one.search_knowledge_documents",
    ),
    false,
  );
  assert.equal(
    hosted.profile.toolAllowlist?.includes("desktop.host.open"),
    false,
  );
  assert.equal(
    hosted.profile.toolAllowlist?.includes(
      "kestrel_one.search_knowledge_documents",
    ),
    true,
  );
});

contractTest("runtime.hermetic", "canonical Kestrel One policy and presets are immutable versioned definitions", () => {
  assert.equal(Object.isFrozen(KESTREL_ONE_POLICY), true);
  assert.equal(Object.isFrozen(KESTREL_ONE_POLICY.requiredModelToolNames), true);
  assert.equal(Object.isFrozen(KESTREL_ONE_ENVIRONMENT_PRESETS), true);
  assert.equal(
    Object.values(KESTREL_ONE_ENVIRONMENT_PRESETS).every(
      (preset) => Object.isFrozen(preset) && preset.version === 1,
    ),
    true,
  );
  assert.equal(KESTREL_ONE_POLICY.allowNestedCollaborators, false);
});

contractTest("runtime.hermetic", "canonical Kestrel One policy fingerprints normalized overlays deterministically", () => {
  const first = composeKestrelOneProfile({
    environmentPresetId: "desktop_dev_local",
    overlay: {
      additionalToolNames: [
        "free.weather.current",
        "agent.spawn",
        "delegate.future_internal_tool",
        "dialog.open",
      ],
    },
  });
  const second = composeKestrelOneProfile({
    environmentPresetId: "desktop_dev_local",
    overlay: {
      additionalToolNames: [
        "free.weather.current",
        "agent.spawn",
        "delegate.future_internal_tool",
        "dialog.open",
      ],
    },
  });
  const changed = composeKestrelOneProfile({
    environmentPresetId: "desktop_dev_local",
    overlay: {
      additionalToolNames: ["free.time.current"],
    },
  });

  assert.equal(first.provenance.fingerprint, second.provenance.fingerprint);
  assert.notEqual(first.provenance.fingerprint, changed.provenance.fingerprint);
  assert.equal(first.profile.toolAllowlist?.includes("agent.spawn"), false);
  assert.equal(
    first.profile.toolAllowlist?.includes("delegate.future_internal_tool"),
    false,
  );
});

contractTest("runtime.hermetic", "canonical Kestrel One policy fails closed without required dialog tools", () => {
  assert.throws(
    () => assertRequiredKestrelOneTools(["dialog.open", "dialog.send"]),
    /dialog\.close/u,
  );
});
