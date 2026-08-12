import assert from "node:assert/strict";
import test from "node:test";

import { RUNNER_BUILT_IN_TOOL_NAMES } from "@kestrel-agents/protocol";

import {
  assertRequiredManagedKestrelTools,
  composeManagedKestrelProfile,
  fingerprintResolvedProfile,
  KESTREL_EXECUTION_BOUNDARY_POLICY_REVISION,
  KESTREL_RUNNER_BUILT_IN_TOOL_NAMES,
} from "../src/index.js";

const GOLDEN_PRESETS = {
  cli_safe_local: {
    composition:
      "0b23d53961ac362d951dfba52bc0584b661c99f9bcfff55edb480fa88df0accb",
    resolved:
      "2c3780447a8890b1963756690ba98ff8a8d4d6a4c9781dd61477951338a4d991",
  },
  cli_dev_local: {
    composition:
      "822a5258478cccd24be7c14b1207e0c27d53bbb5bfb13e05ac2f2cbdb4bc27aa",
    resolved:
      "fb8507d021be7b4ec9c08ce01fa9b4ab33fa2afb033aeade8bb612703c46b564",
  },
  desktop_safe_local: {
    composition:
      "24d2c4f788a72b6f29bc88160ddc9c4d08e5ae86e18d43249916a9466f1f19ac",
    resolved:
      "2daf89a6cfb2884eba32aa911031afdcf69b909835786bd76ec170a8e0409080",
  },
  desktop_dev_local: {
    composition:
      "8833ca5a079ec1aa62cbc80a1a6432c5d7b662e81bf9783bb28cb6767c22f0a2",
    resolved:
      "79261247329c169f5bfef21ffcb5f85611b3ee2843d090b42d0f28ccd16fcb75",
  },
  workspace_hosted: {
    composition:
      "43da808c86a550f03a8aef3a5714200582bcb967cd1a7eeef571b99998293b37",
    resolved:
      "3b95bfe09734cdcceed3207aee5782ab12f239d740d7ce631cbe48c5f7482f41",
  },
} as const;

test("managed profiles preserve the pre-extraction golden identities", () => {
  for (const [environmentPresetId, golden] of Object.entries(GOLDEN_PRESETS)) {
    const composed = composeManagedKestrelProfile({
      environmentPresetId: environmentPresetId as keyof typeof GOLDEN_PRESETS,
    });
    assert.equal(composed.provenance.fingerprint, golden.composition);
    assert.equal(
      composed.profile.id,
      `kestrel:${environmentPresetId}:${golden.composition}`,
    );
    assert.equal(fingerprintResolvedProfile(composed.profile), golden.resolved);
  }
});

test("managed built-in tool snapshot matches the public protocol", () => {
  assert.deepEqual(
    KESTREL_RUNNER_BUILT_IN_TOOL_NAMES,
    RUNNER_BUILT_IN_TOOL_NAMES,
  );
});

test("managed profile composition preserves product environment behavior", () => {
  const safe = composeManagedKestrelProfile({
    environmentPresetId: "desktop_safe_local",
  }).profile;
  const developer = composeManagedKestrelProfile({
    environmentPresetId: "desktop_dev_local",
    overlay: {
      additionalToolNames: [
        "free.weather.current",
        "agent.spawn",
        "delegate.private",
        "dialog.open",
      ],
    },
  }).profile;

  assert.equal(safe.codeMode.enabled, true);
  assert.equal(safe.devShell.enabled, false);
  assert.equal(safe.toolAllowlist.includes("code.execute"), true);
  assert.equal(developer.codeMode.enabled, false);
  assert.equal(developer.devShell.enabled, true);
  assert.equal(developer.toolAllowlist.includes("desktop.host.open"), true);
  assert.equal(developer.toolAllowlist.includes("agent.spawn"), false);
  assert.equal(developer.toolAllowlist.includes("delegate.private"), false);
  assert.deepEqual(
    developer.toolAllowlist.filter((name) => name.startsWith("dialog.")),
    ["dialog.open", "dialog.send", "dialog.close"],
  );
});

test("managed policy-owned fields fail closed", () => {
  assert.throws(
    () =>
      composeManagedKestrelProfile({
        environmentPresetId: "workspace_hosted",
        overlay: { guardrails: { maxStepVisits: 1 } } as never,
      }),
    /policy-controlled field\(s\): guardrails/u,
  );
  assert.throws(
    () => assertRequiredManagedKestrelTools(["dialog.open", "dialog.send"]),
    /dialog\.close/u,
  );
});

test("resolved fingerprints bind the canonical execution boundary revision", () => {
  assert.equal(
    KESTREL_EXECUTION_BOUNDARY_POLICY_REVISION,
    "sha256:2d48fef187d7e38ac5565fd0a1241d5c3f2de21608ce0fd4363c1f327d9a5503",
  );
  const profile = composeManagedKestrelProfile({
    environmentPresetId: "cli_safe_local",
    resolvedProfileId: "golden",
  }).profile;
  assert.notEqual(
    fingerprintResolvedProfile(profile),
    fingerprintResolvedProfile(profile, { sourceRevision: "different" }),
  );
});
