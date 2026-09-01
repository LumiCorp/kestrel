import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  assertKestrelExecutionProfileEconomicsAdmission,
  assertRequiredKestrelOneTools,
  composeKestrelOneProfile,
  KESTREL_ONE_DIALOG_TOOL_NAMES,
  KESTREL_ONE_ENVIRONMENT_PRESETS,
  KESTREL_HARNESS_ECONOMICS,
  KESTREL_ONE_POLICY,
  KESTREL_POLICY_VERSION,
  defaultApprovalPolicyPackForPreset,
} from "../../src/profile/kestrelOnePolicy.js";

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
  assert.equal(KESTREL_ONE_ENVIRONMENT_PRESETS.workspace_hosted.version, 4);

  for (const composed of [
    cliSafe,
    cliDev,
    desktopSafe,
    desktopDev,
    hosted,
  ]) {
    assert.equal(composed.profile.agentProfileId, "kestrel");
    assert.equal(composed.provenance.policyId, "kestrel");
    assert.equal(composed.provenance.policyVersion, 5);
    assert.equal(composed.provenance.policyVersion, KESTREL_POLICY_VERSION);
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
  assert.deepEqual(cliDev.profile.devShell, hosted.profile.devShell);
  assert.equal(cliDev.profile.codeMode?.enabled, false);
  assert.equal(hosted.profile.codeMode?.enabled, true);
  assert.equal(hosted.profile.approvalPolicyPackId, "hosted_workspace");
  assert.equal(defaultApprovalPolicyPackForPreset("workspace_hosted"), "hosted_workspace");
  assert.equal(cliDev.profile.toolAllowlist?.includes("code.execute"), false);
  assert.equal(hosted.profile.toolAllowlist?.includes("code.execute"), true);

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

test("hosted composition rejects a policy pack that denies required shell descriptors", () => {
  assert.throws(
    () => composeKestrelOneProfile({
      environmentPresetId: "workspace_hosted",
      overlay: {
        ...LUNA_ROUTE,
        approvalPolicyPackId: "ci_bot",
        additionalToolNames: ["exec_command"],
      },
    }),
    /does not authorize advertised tool 'exec_command' class 'external_side_effect'/u,
  );
});

test("canonical Kestrel One policy and presets are immutable versioned definitions", () => {
  assert.equal(Object.isFrozen(KESTREL_ONE_POLICY), true);
  assert.equal(Object.isFrozen(KESTREL_ONE_POLICY.requiredModelToolNames), true);
  assert.equal(Object.isFrozen(KESTREL_ONE_ENVIRONMENT_PRESETS), true);
  assert.equal(Object.isFrozen(KESTREL_HARNESS_ECONOMICS), true);
  assert.equal(
    Object.values(KESTREL_ONE_ENVIRONMENT_PRESETS).every((preset) =>
      Object.isFrozen(preset) && preset.version ===
        (preset.id === "workspace_hosted" ? 4 : 1)
    ),
    true,
  );
  assert.equal(KESTREL_ONE_POLICY.allowNestedCollaborators, false);
  assert.equal(KESTREL_POLICY_VERSION, 5);
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
  assert.deepEqual(
    KESTREL_HARNESS_ECONOMICS.modelProfiles.find(
      (profile) =>
        profile.provider === "openai" && profile.model === "Qwen/Qwen3-8B",
    ),
    {
      version: 1,
      profileId: "openai:Qwen/Qwen3-8B:v1",
      provider: "openai",
      model: "Qwen/Qwen3-8B",
      contextWindowTokens: 32_768,
      maxOutputTokens: 8_192,
      counting: {
        counter: "utf8-byte-upper-bound",
        counterVersion: "1",
        method: "conservative_estimate",
        confidence: "conservative",
      },
      cache: { behavior: "none" },
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

test("approved model economics profiles are carried into hosted Kestrel composition", () => {
  const modelEconomicsProfile = {
    version: 1 as const,
    profileId: "openrouter:z-ai/glm-5.2:free:v1",
    provider: "openrouter",
    model: "z-ai/glm-5.2:free",
    contextWindowTokens: 202_752,
    maxOutputTokens: 65_536,
    counting: {
      counter: "utf8-byte-upper-bound",
      counterVersion: "1",
      method: "conservative_estimate" as const,
      confidence: "conservative" as const,
    },
    cache: { behavior: "none" as const },
  };
  const profile = composeKestrelOneProfile({
    environmentPresetId: "workspace_hosted",
    overlay: {
      ...hostedCredential(modelEconomicsProfile.model),
      modelProvider: modelEconomicsProfile.provider as "openrouter",
      model: modelEconomicsProfile.model,
      modelEconomicsProfile,
    },
  }).profile;

  assert.deepEqual(
    profile.harnessEconomics?.modelProfiles.find(
      (candidate) => candidate.model === modelEconomicsProfile.model,
    ),
    modelEconomicsProfile,
  );
  assert.doesNotThrow(() =>
    assertKestrelExecutionProfileEconomicsAdmission({
      profile,
      environmentPresetId: "workspace_hosted",
    }),
  );
});

test("canonical Kestrel policy accepts explicit hosted capability tools", () => {
  const hosted = composeKestrelOneProfile({
    environmentPresetId: "workspace_hosted",
    overlay: {
      ...LUNA_ROUTE,
      additionalToolNames: [
        "kestrel_one.search_knowledge_documents",
        "kestrel_one.google_calendar_create_event",
      ],
    },
  });

  assert.equal(
    hosted.profile.toolAllowlist?.includes(
      "kestrel_one.search_knowledge_documents",
    ),
    true,
  );
  assert.equal(
    hosted.profile.toolAllowlist?.includes(
      "kestrel_one.google_calendar_create_event",
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
    policyVersion: 5,
    promptPolicyId: "kestrel",
    harnessEconomicsControlVersion: 1,
    harnessEconomicsPolicyId: "economics:kestrel:v2",
    harnessEconomicsPolicyVersion: 1,
    environmentPresetId: "workspace_hosted",
    environmentPresetVersion: 4,
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
