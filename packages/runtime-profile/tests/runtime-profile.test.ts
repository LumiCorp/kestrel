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
      "cbafad03a320e86d90b7b7e1a270491704b55d3428dd2c124dd0232b58642da2",
    resolved:
      "5a1178f1e383cfbcb2dcd73558fc97722b7178c0f418543627e725e95bdb5650",
  },
  cli_dev_local: {
    composition:
      "37f76dc9ecb662d0307215a1ec59e328bfec4a1830407280f66925739906b31a",
    resolved:
      "e4fff8cde8a0291f1eaab10cc6f8fa51c08d159917fc0fd9f6430fbabdae0715",
  },
  desktop_safe_local: {
    composition:
      "932d6612c3f5ede065c9edb6185165bbc30d647bc1eb2a2b4fc62defe80439ae",
    resolved:
      "283f51f970d6c43aba71d6d9a511ce7674950c89a689b49aedf91db77b0e2a1f",
  },
  desktop_dev_local: {
    composition:
      "ead44f3d5c767ad57f338f984221119cda38eaa8fbe889a5888cae7415556325",
    resolved:
      "0a327335aac811f4fa199325d2ad02699f4c8b441c3e3d1e1149500e4299dd69",
  },
  workspace_hosted: {
    composition:
      "2c9d974f943421dbd19676809b6e10c515615af31cc0448fa3cdc2a9584efe42",
    resolved:
      "5a40b038b6da8aef67f58c996148d7a439958d9e2d78d2b0e591e8f09f4174ea",
  },
} as const;

test("managed profiles preserve the current canonical golden identities", () => {
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
