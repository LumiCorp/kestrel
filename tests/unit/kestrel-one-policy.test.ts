import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  composeManagedKestrelProfile,
  KESTREL_EXECUTION_BOUNDARY_POLICY_REVISION,
  parseManagedRuntimeEvaluationPolicy,
} from "@kestrel/runtime-profile";

import {
  assertKestrelExecutionProfileEconomicsAdmission,
  assertRequiredKestrelOneTools,
  composeKestrelOneProfile,
  KESTREL_ONE_DIALOG_TOOL_NAMES,
  KESTREL_ONE_ENVIRONMENT_PRESETS,
  KESTREL_HARNESS_ECONOMICS,
  KESTREL_ONE_POLICY,
  KESTREL_POLICY_VERSION,
} from "../../src/profile/kestrelOnePolicy.js";
import { KESTREL_EXECUTION_BOUNDARY_POLICY } from "../../src/security/ExecutionBoundaryPolicy.js";
import {
  createRuntimeEvaluationPolicyV1,
  LEAN_RUNTIME_EVALUATION_BUDGET_V1,
  parseRuntimeEvaluationPolicyV1,
  RUNTIME_EVALUATION_THRESHOLDS_V1,
} from "../../src/kestrel/contracts/evaluation.js";
import { resolveRuntimeProfileSelection } from "../../src/profile/runtimeProfile.js";

const EVALUATION_HASH_A = `sha256:${"a".repeat(64)}`;
const EVALUATION_HASH_B = `sha256:${"b".repeat(64)}`;

const LUNA_ROUTE = {
  modelProvider: "openrouter" as const,
  model: "openai/gpt-5.6-luna",
};

function hostedCredential(
  model: string,
  provider: "openrouter" | "openai" = "openrouter",
) {
  return {
    source: "kestrel-one" as const,
    runId: "run-1",
    gatewayId: "gateway-1",
    organizationId: "org-1",
    environmentId: "env-1",
    rawModelId: model,
    provider,
  };
}

test("canonical Kestrel policy composes parity across product environments", () => {
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
    overlay: LUNA_ROUTE,
  });

  for (const composed of [cliSafe, cliDev, desktopSafe, desktopDev, hosted]) {
    assert.equal(composed.profile.agentProfileId, "kestrel");
    assert.equal(composed.provenance.policyId, "kestrel");
    assert.equal(composed.provenance.policyVersion, 3);
    assert.equal(composed.provenance.policyVersion, KESTREL_POLICY_VERSION);
    assert.equal(composed.provenance.promptPolicyId, "kestrel");
    assert.equal(
      composed.provenance.environmentPresetVersion,
      KESTREL_ONE_ENVIRONMENT_PRESETS[composed.provenance.environmentPresetId]
        .version,
    );
    assert.equal(composed.profile.delegation?.allowAgentSpawn, true);
    assert.equal(
      composed.profile.harnessEconomics?.policy.compaction.maxSummaryAttempts,
      2,
    );
    assert.equal(
      composed.profile.harnessEconomics?.policy.policyId,
      "economics:kestrel:v2",
    );
    assert.equal(composed.profile.guardrails?.maxMaintenanceModelCallsPerRun, 8);
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
  assert.deepEqual(cliDev.profile.toolAllowlist, hosted.profile.toolAllowlist);
  assert.deepEqual(cliDev.profile.codeMode, hosted.profile.codeMode);
  assert.deepEqual(cliDev.profile.devShell, hosted.profile.devShell);

  assert.equal(
    cliSafe.profile.toolAllowlist?.includes("desktop.host.open"),
    false,
  );
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

test("canonical Kestrel One policy and presets are immutable versioned definitions", () => {
  assert.equal(Object.isFrozen(KESTREL_ONE_POLICY), true);
  assert.equal(
    Object.isFrozen(KESTREL_ONE_POLICY.requiredModelToolNames),
    true,
  );
  assert.equal(Object.isFrozen(KESTREL_ONE_ENVIRONMENT_PRESETS), true);
  assert.equal(Object.isFrozen(KESTREL_HARNESS_ECONOMICS), true);
  assert.equal(
    Object.values(KESTREL_ONE_ENVIRONMENT_PRESETS).every(
      (preset) => Object.isFrozen(preset) && preset.version === 1,
    ),
    true,
  );
  assert.equal(KESTREL_ONE_POLICY.allowNestedCollaborators, false);
  assert.equal(KESTREL_POLICY_VERSION, 3);
  assert.deepEqual(
    KESTREL_HARNESS_ECONOMICS.modelProfiles.find(
      (profile) =>
        profile.provider === "openrouter" &&
        profile.model === "openai/gpt-5.6-luna",
    ),
    {
      version: 1,
      profileId: "openrouter:openai/gpt-5.6-luna:v1",
      provider: "openrouter",
      model: "openai/gpt-5.6-luna",
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
      counting: {
        counter: "utf8-byte-upper-bound",
        counterVersion: "1",
        method: "conservative_estimate",
        confidence: "conservative",
      },
      cache: { behavior: "provider_automatic" },
    },
  );
});

test("hosted execution preflight requires one internally consistent exact economics route", () => {
  for (const input of [
    { overlay: undefined, reason: "pinned_model_route_required" },
    {
      overlay: {
        modelProvider: "openrouter" as const,
        model: "openai/gpt-5.6-luna-20260709",
        modelCredential: hostedCredential("openai/gpt-5.6-luna-20260709"),
      },
      reason: "model_profile_not_found",
    },
    {
      overlay: {
        modelProvider: "openai" as const,
        model: "openai/gpt-5.6-luna",
        modelCredential: hostedCredential("openai/gpt-5.6-luna", "openai"),
      },
      reason: "model_profile_not_found",
    },
  ]) {
    const composed = composeKestrelOneProfile({
      environmentPresetId: "workspace_hosted",
      ...(input.overlay !== undefined ? { overlay: input.overlay } : {}),
    });
    assert.throws(
      () =>
        assertKestrelExecutionProfileEconomicsAdmission({
          profile: composed.profile,
          environmentPresetId: "workspace_hosted",
        }),
      (error: unknown) => {
        const failure = error as {
          code?: string;
          details?: Record<string, unknown>;
        };
        assert.equal(
          failure.code,
          "HARNESS_ECONOMICS_MODEL_PROFILE_REQUIRED",
        );
        assert.equal(failure.details?.preset, "workspace_hosted");
        assert.equal(failure.details?.reason, input.reason);
        assert.equal("provider" in (failure.details ?? {}), true);
        assert.equal("model" in (failure.details ?? {}), true);
        return true;
      },
    );
  }

  const luna = composeKestrelOneProfile({
    environmentPresetId: "workspace_hosted",
    overlay: LUNA_ROUTE,
  }).profile;
  for (const input of [
    {
      profile: {
        ...luna,
        agentStageConfig: {
          modelByStage: { "agent.loop": "openai/gpt-5.6-luna-alias" },
        },
      },
      reason: "agent_loop_model_mismatch",
    },
    {
      profile: {
        ...luna,
        agentStageConfig: {
          modelByStage: {
            "agent.loop": "openai/gpt-5.6-luna",
            "agent.maintenance": "openai/gpt-5.6-luna-alias",
          },
        },
      },
      reason: "stage_model_mismatch",
    },
    {
      profile: {
        ...luna,
        agentStageConfig: {
          modelByStage: {
            "agent.loop": "openai/gpt-5.6-luna",
            "delegation.child": "openai/gpt-5.6-luna-alias",
          },
        },
      },
      reason: "stage_model_mismatch",
    },
    {
      profile: {
        ...luna,
        modelCredential: {
          source: "kestrel-one" as const,
          runId: "run-1",
          gatewayId: "gateway-1",
          organizationId: "org-1",
          environmentId: "env-1",
          rawModelId: "openai/gpt-5.6-luna-alias",
          provider: "openrouter" as const,
        },
      },
      reason: "model_credential_route_mismatch",
    },
  ]) {
    assert.throws(
      () =>
        assertKestrelExecutionProfileEconomicsAdmission({
          profile: input.profile,
          environmentPresetId: "workspace_hosted",
        }),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "HARNESS_ECONOMICS_MODEL_PROFILE_REQUIRED",
        );
        assert.equal(
          (error as { details?: Record<string, unknown> }).details?.reason,
          input.reason,
        );
        return true;
      },
    );
  }

  assert.doesNotThrow(() =>
    assertKestrelExecutionProfileEconomicsAdmission({
      profile: luna,
      environmentPresetId: "workspace_hosted",
    }),
  );
  for (const harnessEconomics of [
    undefined,
    {
      ...structuredClone(KESTREL_HARNESS_ECONOMICS),
      policy: {
        ...structuredClone(KESTREL_HARNESS_ECONOMICS.policy),
        policyId: "economics:kestrel:v1",
      },
    },
    {
      ...structuredClone(KESTREL_HARNESS_ECONOMICS),
      modelProfiles: KESTREL_HARNESS_ECONOMICS.modelProfiles.map((profile) =>
        profile.model === LUNA_ROUTE.model
          ? { ...profile, contextWindowTokens: 2_000_000 }
          : profile
      ),
    },
  ]) {
    assert.throws(
      () =>
        assertKestrelExecutionProfileEconomicsAdmission({
          profile: { ...luna, harnessEconomics },
          environmentPresetId: "workspace_hosted",
        }),
      (error: unknown) =>
        (error as { code?: string }).code ===
        "HARNESS_ECONOMICS_MODEL_PROFILE_REQUIRED",
    );
  }
  assert.doesNotThrow(() =>
    assertKestrelExecutionProfileEconomicsAdmission({
      profile: composeKestrelOneProfile({
        environmentPresetId: "cli_dev_local",
        overlay: {
          modelProvider: "ollama",
          model: "unprofiled-local-model",
          agentStageConfig: {
            modelByStage: {
              "agent.loop": "unprofiled-local-model",
              "agent.maintenance": "another-local-model",
            },
          },
        },
      }).profile,
      environmentPresetId: "cli_dev_local",
    }),
  );
  assert.equal(
    luna.model,
    LUNA_ROUTE.model,
  );
  assert.equal(
    composeKestrelOneProfile({
      environmentPresetId: "workspace_hosted",
      overlay: {
        modelProvider: "openrouter",
        model: "z-ai/glm-5.2",
      },
    }).profile.model,
    "z-ai/glm-5.2",
  );
  assert.equal(
    composeKestrelOneProfile({
      environmentPresetId: "cli_safe_local",
      overlay: {
        modelProvider: "ollama",
        model: "unprofiled-local-model",
      },
    }).profile.model,
    "unprofiled-local-model",
  );
  assert.doesNotThrow(() =>
    assertKestrelExecutionProfileEconomicsAdmission({
      profile: composeKestrelOneProfile({
        environmentPresetId: "desktop_safe_local",
        overlay: {
          modelProvider: "ollama",
          model: "unprofiled-local-model",
        },
      }).profile,
      environmentPresetId: "desktop_safe_local",
    }),
  );
});

test("canonical Kestrel policy accepts explicit hosted capability tools", () => {
  const hosted = composeKestrelOneProfile({
    environmentPresetId: "workspace_hosted",
    overlay: {
      ...LUNA_ROUTE,
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

test("canonical Kestrel policy rejects policy-owned overrides", () => {
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

test("canonical Kestrel One policy fingerprints normalized overlays deterministically", () => {
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

test("legacy composition fingerprint includes Kestrel and economics policy revisions", () => {
  const composed = composeKestrelOneProfile({
    environmentPresetId: "workspace_hosted",
    overlay: LUNA_ROUTE,
  });
  const expected = digestCanonical({
    policyId: "kestrel",
    policyVersion: 3,
    promptPolicyId: "kestrel",
    harnessEconomicsControlVersion: 1,
    harnessEconomicsPolicyId: "economics:kestrel:v2",
    harnessEconomicsPolicyVersion: 1,
    environmentPresetId: "workspace_hosted",
    environmentPresetVersion: 1,
    environmentCapabilityPacks: composed.profile.capabilityPacks,
    overlay: LUNA_ROUTE,
    toolAllowlist: composed.profile.toolAllowlist,
  });

  assert.equal(composed.provenance.fingerprint, expected);
});

test("canonical Kestrel One policy fails closed without required dialog tools", () => {
  assert.throws(
    () => assertRequiredKestrelOneTools(["dialog.open", "dialog.send"]),
    /dialog\.close/u,
  );
});

function digestCanonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortJsonValue(value)))
    .digest("hex");
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

test("root managed profile facade remains byte-for-byte equal to the shared package", () => {
  const inputs = [
    { environmentPresetId: "cli_safe_local" as const },
    { environmentPresetId: "cli_dev_local" as const },
    { environmentPresetId: "desktop_safe_local" as const },
    {
      environmentPresetId: "desktop_dev_local" as const,
      overlay: {
        runtimeId: "codex" as const,
        modelProvider: "openai" as const,
        model: "gpt-parity",
        additionalToolNames: ["free.weather.current", "dialog.open"],
        delegationLimits: { maxConcurrentChildSessions: 4, maxDepth: 3 },
      },
      resolvedProfileId: "managed-parity",
    },
    {
      environmentPresetId: "workspace_hosted" as const,
      overlay: {
        additionalToolNames: ["kestrel_one.search_knowledge_documents"],
      },
    },
  ];

  for (const input of inputs) {
    assert.deepEqual(
      composeKestrelOneProfile(input),
      composeManagedKestrelProfile(input),
    );
  }
});

test("shared managed environment snapshots match canonical Runtime selections", () => {
  for (const environmentPresetId of [
    "cli_safe_local",
    "cli_dev_local",
    "desktop_safe_local",
    "desktop_dev_local",
    "workspace_hosted",
  ] as const) {
    const managed = composeManagedKestrelProfile({
      environmentPresetId,
    }).profile;
    const canonical = resolveRuntimeProfileSelection({
      shellKind: managed.shellKind,
      presetId: environmentPresetId,
    });
    assert.deepEqual(managed.capabilityPacks, canonical.capabilityPacks);
    assert.deepEqual(managed.toolAllowlist, [
      ...canonical.toolAllowlist,
      ...KESTREL_ONE_DIALOG_TOOL_NAMES,
    ]);
    assert.deepEqual(managed.codeMode, canonical.codeMode);
    assert.deepEqual(managed.devShell, canonical.devShell);
  }
});

test("shared resolved fingerprint revision matches the canonical root policy", () => {
  assert.equal(
    KESTREL_EXECUTION_BOUNDARY_POLICY_REVISION,
    KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
  );
});

test("shared managed evaluation policy parsing matches the canonical contract", () => {
  const policy = createRuntimeEvaluationPolicyV1({
    policyId: "evaluation:managed-parity",
    evaluator: {
      evaluatorId: "completion-evidence",
      evaluatorVersion: "1.0.0",
    },
    assets: {
      bundleId: "evaluation-assets",
      revision: EVALUATION_HASH_A,
      rubricRevision: EVALUATION_HASH_A,
      assertionsRevision: EVALUATION_HASH_A,
      promptRevision: EVALUATION_HASH_A,
      schemaRevision: EVALUATION_HASH_A,
      calibrationDatasetRevision: EVALUATION_HASH_A,
      evaluatorCodeRevision: EVALUATION_HASH_A,
    },
    judge: {
      route: "profile_primary",
      provider: "openai",
      model: "gpt-managed-parity",
      modelRegistrationRevision: EVALUATION_HASH_A,
      capabilities: {
        visionInputEnabled: false,
        toolCallingEnabled: true,
        structuredOutputEnabled: true,
        reasoningModes: ["off", "summary", "provider_visible"],
      },
      pricing: {
        priceRevision: EVALUATION_HASH_B,
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 8,
      },
    },
    calibration: {
      recordId: "evaluation-calibration",
      recordRevision: EVALUATION_HASH_A,
    },
    hooks: [
      {
        kind: "after_tool",
        mode: "advisory",
        selectorIds: ["code.execute"],
      },
      { kind: "pre_delivery", mode: "blocking", selectorIds: [] },
    ],
    budget: LEAN_RUNTIME_EVALUATION_BUDGET_V1,
    thresholds: RUNTIME_EVALUATION_THRESHOLDS_V1,
    actions: {
      revisionHandlerId: "evaluation.revise",
      reviewOptionIds: [
        "evaluation.accept_once",
        "evaluation.revise",
        "terminal.fail",
      ],
    },
  });
  assert.deepEqual(parseManagedRuntimeEvaluationPolicy(policy), policy);

  const malformedPolicies = [
    { ...policy, unexpected: true },
    {
      ...policy,
      budget: { ...policy.budget, maxEvaluationsPerRun: 5 },
    },
    {
      ...policy,
      hooks: [
        ...policy.hooks,
        { kind: "after_tool", mode: "advisory", selectorIds: [] },
      ],
    },
    { ...policy, revision: EVALUATION_HASH_B },
  ];
  for (const malformed of malformedPolicies) {
    assert.throws(() => parseRuntimeEvaluationPolicyV1(malformed));
    assert.throws(() => parseManagedRuntimeEvaluationPolicy(malformed));
    assert.throws(() =>
      composeManagedKestrelProfile({
        environmentPresetId: "workspace_hosted",
        overlay: {
          modelProvider: "openai",
          model: "gpt-managed-parity",
          modelCapabilities: { visionInputEnabled: false },
          evaluationPolicy: malformed as never,
        },
      }),
    );
  }
});
