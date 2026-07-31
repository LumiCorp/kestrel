import assert from "node:assert/strict";

import {
  assertRequiredKestrelOneTools,
  composeKestrelOneProfile,
  KESTREL_ONE_DIALOG_TOOL_NAMES,
  KESTREL_ONE_ENVIRONMENT_PRESETS,
  KESTREL_HARNESS_ECONOMICS,
  KESTREL_ONE_POLICY,
} from "../../src/profile/kestrelOnePolicy.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest("runtime.hermetic", "canonical Kestrel policy composes parity across product environments", () => {
  const cliSafe = composeKestrelOneProfile({
    environmentPresetId: "cli_safe_local",
  });
  const cliDev = composeKestrelOneProfile({
    environmentPresetId: "cli_dev_local",
  });
  const desktopSafe = composeKestrelOneProfile({
    environmentPresetId: "desktop_safe_local",
  });
  const desktopDev = composeKestrelOneProfile({
    environmentPresetId: "desktop_dev_local",
  });
  const hosted = composeKestrelOneProfile({
    environmentPresetId: "workspace_hosted",
  });

  for (const composed of [
    cliSafe,
    cliDev,
    desktopSafe,
    desktopDev,
    hosted,
  ]) {
    assert.equal(composed.profile.agentProfileId, "kestrel");
    assert.equal(composed.provenance.policyId, "kestrel");
    assert.equal(composed.provenance.policyVersion, 2);
    assert.equal(composed.provenance.promptPolicyId, "kestrel");
    assert.equal(
      composed.provenance.environmentPresetVersion,
      KESTREL_ONE_ENVIRONMENT_PRESETS[
        composed.provenance.environmentPresetId
      ].version,
    );
    assert.equal(composed.profile.delegation?.allowAgentSpawn, true);
    assert.equal(
      composed.profile.harnessEconomics?.policy.compaction
        .maxSummaryAttempts,
      2,
    );
    assert.equal(
      composed.profile.harnessEconomics?.policy.policyId,
      "economics:kestrel:v1",
    );
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
  assert.equal(cliSafe.profile.devShell?.enabled, false);
  assert.equal(cliSafe.profile.codeMode?.enabled, true);
  assert.equal(desktopSafe.profile.devShell?.enabled, false);
  assert.equal(desktopSafe.profile.codeMode?.enabled, true);
  assert.equal(cliDev.profile.devShell?.enabled, true);
  assert.equal(desktopDev.profile.devShell?.enabled, true);

  assert.equal(cliSafe.profile.toolAllowlist?.includes("desktop.host.open"), false);
  assert.equal(
    cliSafe.profile.toolAllowlist?.includes(
      "kestrel_one.search_knowledge_documents",
    ),
    false,
  );
  assert.equal(
    desktopSafe.profile.toolAllowlist?.includes("desktop.host.open"),
    true,
  );
  assert.equal(
    desktopSafe.profile.toolAllowlist?.includes(
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
    false,
  );
});

contractTest("runtime.hermetic", "canonical Kestrel One policy and presets are immutable versioned definitions", () => {
  assert.equal(Object.isFrozen(KESTREL_ONE_POLICY), true);
  assert.equal(Object.isFrozen(KESTREL_ONE_POLICY.requiredModelToolNames), true);
  assert.equal(Object.isFrozen(KESTREL_ONE_ENVIRONMENT_PRESETS), true);
  assert.equal(Object.isFrozen(KESTREL_HARNESS_ECONOMICS), true);
  assert.equal(
    Object.values(KESTREL_ONE_ENVIRONMENT_PRESETS).every(
      (preset) => Object.isFrozen(preset) && preset.version === 1,
    ),
    true,
  );
  assert.equal(KESTREL_ONE_POLICY.allowNestedCollaborators, false);
});

contractTest("runtime.hermetic", "canonical Kestrel policy accepts explicit hosted capability tools", () => {
  const hosted = composeKestrelOneProfile({
    environmentPresetId: "workspace_hosted",
    overlay: {
      additionalToolNames: ["kestrel_one.search_knowledge_documents"],
    },
  });

  assert.equal(
    hosted.profile.toolAllowlist?.includes(
      "kestrel_one.search_knowledge_documents",
    ),
    true,
  );
});

contractTest("runtime.hermetic", "canonical Kestrel policy rejects policy-owned overrides", () => {
  assert.throws(
    () =>
      composeKestrelOneProfile({
        environmentPresetId: "cli_dev_local",
        overlay: {
          harnessEconomics: structuredClone(KESTREL_HARNESS_ECONOMICS),
        },
      }),
    /policy-controlled field\(s\): harnessEconomics/u,
  );
  assert.throws(
    () =>
      composeKestrelOneProfile({
        environmentPresetId: "cli_dev_local",
        overlay: {
          guardrails: { maxStepVisits: 1 },
        } as never,
      }),
    /policy-controlled field\(s\): guardrails/u,
  );
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
