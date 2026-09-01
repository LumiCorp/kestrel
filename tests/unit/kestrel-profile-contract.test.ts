import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertKestrelExecutionProfileEconomicsAdmission,
  KESTREL_HARNESS_ECONOMICS,
  KESTREL_POLICY_ID,
  KESTREL_POLICY_VERSION,
  KESTREL_PROFILE_DEFINITION,
  KESTREL_PROMPT_POLICY_ID,
  composeKestrelOneProfile,
  composeKestrelProfile,
  createKestrelEnvironmentBindingFromOverlay,
} from "../../src/profile/kestrelOnePolicy.js";
import {
  canonicalizeFirstPartyKestrelProfileId,
  createKestrelEnvironmentBindingV1,
  createKestrelProfileDefinitionV1,
  fingerprintKestrelEnvironmentBindingV1,
  fingerprintKestrelProfileDefinitionV1,
  parseKestrelEnvironmentBindingV1,
  parseKestrelEnvironmentSelectionV1,
  parseKestrelProfileDefinitionV1,
  resolveKestrelEnvironmentSelectionV1,
} from "../../src/kestrel/contracts/profile.js";
import {
  LEAN_RUNTIME_EVALUATION_BUDGET_V1,
  RUNTIME_EVALUATION_THRESHOLDS_V1,
  createRuntimeEvaluationPolicyV1,
} from "../../src/kestrel/contracts/evaluation.js";
import { COMPLETION_EVIDENCE_ASSET_BUNDLE_V1 } from "../../src/evaluation/assets.js";

test("canonical Kestrel definition is strict and canonically hashed", () => {
  const parsed = parseKestrelProfileDefinitionV1(
    structuredClone(KESTREL_PROFILE_DEFINITION),
  );

  assert.equal(parsed.id, "kestrel");
  assert.equal(parsed.label, "Kestrel");
  assert.equal(Object.isFrozen(KESTREL_PROFILE_DEFINITION), true);
  assert.equal(Object.isFrozen(KESTREL_PROFILE_DEFINITION.interaction), true);
  assert.equal(
    Object.isFrozen(KESTREL_PROFILE_DEFINITION.reasoning.request),
    true,
  );
  assert.equal(parsed.revision, fingerprintKestrelProfileDefinitionV1(parsed));
  assert.throws(
    () =>
      parseKestrelProfileDefinitionV1({
        ...structuredClone(parsed),
        unknown: true,
      }),
    /unrecognized key/iu,
  );
  assert.throws(
    () =>
      parseKestrelProfileDefinitionV1({
        ...structuredClone(parsed),
        interaction: {
          ...parsed.interaction,
          unknown: true,
        },
      }),
    /unrecognized key/iu,
  );
  assert.throws(
    () =>
      parseKestrelProfileDefinitionV1({
        ...structuredClone(parsed),
        reasoning: {
          ...parsed.reasoning,
          retention: { ...parsed.reasoning.retention, days: 8 },
        },
      }),
    /revision does not match/iu,
  );
});

test("environment selections map exact first-party surface presets", () => {
  assert.deepEqual(
    resolveKestrelEnvironmentSelectionV1({
      surface: "cli",
      environment: "safe",
    }),
    {
      version: "kestrel_environment_selection_v1",
      surface: "cli",
      environment: "safe",
      presetId: "cli_safe_local",
    },
  );
  assert.equal(
    resolveKestrelEnvironmentSelectionV1({
      surface: "desktop",
      environment: "developer",
    }).presetId,
    "desktop_dev_local",
  );
  assert.equal(
    resolveKestrelEnvironmentSelectionV1({
      surface: "web",
      environment: "workspace_hosted",
    }).presetId,
    "workspace_hosted",
  );
  assert.throws(
    () =>
      resolveKestrelEnvironmentSelectionV1({
        surface: "web",
        environment: "safe",
      }),
    /always resolves/iu,
  );
  assert.throws(
    () =>
      parseKestrelEnvironmentSelectionV1({
        version: "kestrel_environment_selection_v1",
        surface: "cli",
        environment: "safe",
        presetId: "cli_dev_local",
      }),
    /does not match/iu,
  );
});

test("environment bindings reject route, credential, tenant, and unknown-field disagreement", () => {
  const credential = {
    source: "kestrel-one" as const,
    runId: "run-1",
    gatewayId: "gateway-1",
    organizationId: "org-1",
    environmentId: "env-1",
    rawModelId: "gpt-5.1",
    provider: "openai" as const,
  };
  const binding = createKestrelEnvironmentBindingV1({
    bindingId: "kestrel:workspace_hosted",
    presetId: "workspace_hosted",
    shellKind: "web",
    capabilityPacks: ["balanced", "filesystem", "dev_shell"],
    modelRoute: {
      kind: "pinned",
      provider: "openai",
      model: "gpt-5.1",
      modelRegistrationRevision: "model-registration:1",
      capabilities: {
        visionInputEnabled: false,
        toolCallingEnabled: true,
        structuredOutputEnabled: true,
        reasoningModes: ["off", "summary", "provider_visible"],
      },
      credentialReference: credential,
    },
    sandbox: {},
    apps: { approvalModes: {} },
    tools: {
      additionalToolNames: [],
      mcpServers: [],
      ociMcpEgressBindings: [],
    },
    approvals: { policyPackId: "production" },
    storage: { driver: "postgres" },
    queues: { tool: {} },
    tenant: {
      scope: "hosted",
      organizationId: "org-1",
      environmentId: "env-1",
    },
  });

  assert.equal(
    binding.revision,
    fingerprintKestrelEnvironmentBindingV1(binding),
  );
  const changedApproval = createKestrelEnvironmentBindingV1({
    ...binding,
    approvals: { policyPackId: "dev" },
  });
  assert.notEqual(changedApproval.revision, binding.revision);
  if (binding.modelRoute.kind !== "pinned") {
    throw new Error("expected pinned test route");
  }
  const pinnedModelRoute = binding.modelRoute;
  assert.throws(
    () =>
      createKestrelEnvironmentBindingV1({
        ...binding,
        modelRoute: {
          ...pinnedModelRoute,
          credentialReference: { ...credential, environmentId: "env-2" },
        },
      }),
    /tenant binding/iu,
  );
  assert.throws(
    () =>
      parseKestrelEnvironmentBindingV1({
        ...structuredClone(binding),
        tools: { ...binding.tools, unknown: true },
      }),
    /unrecognized key/iu,
  );
});

test("canonical composition binds the selected model to the exact environment route", () => {
  const binding = createKestrelEnvironmentBindingFromOverlay({
    environmentPresetId: "cli_safe_local",
    overlay: {
      modelProvider: "openai",
      model: "gpt-5.1",
      modelCapabilities: { visionInputEnabled: true },
    },
    modelRegistrationRevision: "model-registration:1",
  });
  const composed = composeKestrelProfile({
    definition: structuredClone(KESTREL_PROFILE_DEFINITION),
    environmentBinding: binding,
  });

  assert.equal(composed.profile.agentProfileId, "kestrel");
  assert.equal(composed.profile.label, "Kestrel");
  assert.equal(composed.profile.modelProvider, "openai");
  assert.equal(composed.profile.model, "gpt-5.1");
  assert.equal(composed.profile.modelCapabilities?.visionInputEnabled, true);
});

test("canonical hosted composition hydrates templates while execution preflight admits only exact routes", () => {
  for (const binding of [
    createKestrelEnvironmentBindingFromOverlay({
      environmentPresetId: "workspace_hosted",
    }),
    createKestrelEnvironmentBindingFromOverlay({
      environmentPresetId: "workspace_hosted",
      overlay: {
        modelProvider: "openrouter",
        model: "openai/gpt-5.6-luna-20260709",
      },
    }),
  ]) {
    const composed = composeKestrelProfile({
      definition: structuredClone(KESTREL_PROFILE_DEFINITION),
      environmentBinding: binding,
    });
    assert.throws(
      () =>
        assertKestrelExecutionProfileEconomicsAdmission({
          profile: composed.profile,
          environmentPresetId: "workspace_hosted",
        }),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "HARNESS_ECONOMICS_MODEL_PROFILE_REQUIRED",
        );
        return true;
      },
    );
  }

  const binding = createKestrelEnvironmentBindingFromOverlay({
    environmentPresetId: "workspace_hosted",
    overlay: {
      modelProvider: "openrouter",
      model: "openai/gpt-5.6-luna",
    },
  });
  const composed = composeKestrelProfile({
    definition: structuredClone(KESTREL_PROFILE_DEFINITION),
    environmentBinding: binding,
  });
  assert.equal(composed.profile.model, "openai/gpt-5.6-luna");
  assert.doesNotThrow(() =>
    assertKestrelExecutionProfileEconomicsAdmission({
      profile: composed.profile,
      environmentPresetId: "workspace_hosted",
    }),
  );

  const expectedFingerprint = digestCanonical({
    policyId: KESTREL_POLICY_ID,
    policyVersion: KESTREL_POLICY_VERSION,
    promptPolicyId: KESTREL_PROMPT_POLICY_ID,
    harnessEconomicsControlVersion: KESTREL_HARNESS_ECONOMICS.version,
    harnessEconomicsPolicyId: KESTREL_HARNESS_ECONOMICS.policy.policyId,
    harnessEconomicsPolicyVersion: KESTREL_HARNESS_ECONOMICS.policy.version,
    profileDefinitionRevision: KESTREL_PROFILE_DEFINITION.revision,
    environmentBindingRevision: binding.revision,
    toolAllowlist: composed.profile.toolAllowlist,
  });
  assert.equal(composed.provenance.fingerprint, expectedFingerprint);
});

test("legacy overlay routes cannot synthesize evaluation capabilities", () => {
  const hashA = `sha256:${"a".repeat(64)}`;
  const hashB = `sha256:${"b".repeat(64)}`;
  const authoredEvaluation = createRuntimeEvaluationPolicyV1({
    policyId: "evaluation:test",
    evaluator: {
      evaluatorId: "completion-evidence",
      evaluatorVersion: "1.0.0",
    },
    assets: COMPLETION_EVIDENCE_ASSET_BUNDLE_V1,
    judge: {
      route: "profile_primary",
      provider: "openai",
      model: "gpt-5.1",
      modelRegistrationRevision: hashA,
      capabilities: {
        visionInputEnabled: false,
        toolCallingEnabled: true,
        structuredOutputEnabled: true,
        reasoningModes: ["off", "summary", "provider_visible"],
      },
      pricing: {
        priceRevision: hashB,
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 4,
      },
    },
    calibration: { recordId: "calibration:1", recordRevision: hashA },
    hooks: [{ kind: "pre_delivery", mode: "blocking", selectorIds: [] }],
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
  const definition = createKestrelProfileDefinitionV1({
    agent: "kestrel",
    interaction: structuredClone(KESTREL_PROFILE_DEFINITION.interaction),
    evaluationPolicy: authoredEvaluation,
    reasoning: structuredClone(KESTREL_PROFILE_DEFINITION.reasoning),
    delegation: structuredClone(KESTREL_PROFILE_DEFINITION.delegation),
  });
  const binding = createKestrelEnvironmentBindingFromOverlay({
    environmentPresetId: "cli_safe_local",
    overlay: {
      modelProvider: "anthropic",
      model: "claude-sonnet-4-5",
    },
    modelRegistrationRevision: hashB,
  });

  assert.throws(
    () =>
      composeKestrelProfile({
        definition,
        environmentBinding: binding,
      }),
    /structured output capability must be enabled/u,
  );
});

test("deprecated Kestrel One composer preserves its prior resolved snapshot", () => {
  const input = {
    environmentPresetId: "desktop_safe_local" as const,
    overlay: { additionalToolNames: ["free.time.current"] },
  };
  assert.deepEqual(
    composeKestrelProfile(input),
    composeKestrelOneProfile(input),
  );
});

test("legacy first-party aliases canonicalize without admitting custom profiles", () => {
  assert.equal(canonicalizeFirstPartyKestrelProfileId("kestrel"), "kestrel");
  assert.equal(
    canonicalizeFirstPartyKestrelProfileId("kestrel-one"),
    "kestrel",
  );
  assert.throws(
    () => canonicalizeFirstPartyKestrelProfileId("reference"),
    /non-canonical profile/iu,
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
