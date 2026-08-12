import { createHash } from "node:crypto";

import type { TuiProfile } from "../../cli/contracts.js";
import {
  createKestrelEnvironmentBindingV1,
  createKestrelProfileDefinitionV1,
  parseKestrelEnvironmentBindingV1,
  parseKestrelProfileDefinitionV1,
  type KestrelEnvironmentBindingV1,
  type KestrelProfileDefinitionV1,
} from "../kestrel/contracts/profile.js";
import { createRuntimeEvaluationPolicyV1 } from "../kestrel/contracts/evaluation.js";
import type { HarnessEconomicsControlV1 } from "../economics/contracts.js";
import {
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
} from "../mode/contracts.js";
import {
  buildRuntimeIdentityMetadata,
  resolveRuntimeProfileSelection,
  type ShellKind,
  type ShellPresetId,
} from "./runtimeProfile.js";
import { resolveProfileWithEvaluationPolicy } from "./evaluationPolicy.js";
import { KESTREL_EXECUTION_BOUNDARY_POLICY } from "../security/ExecutionBoundaryPolicy.js";

export const KESTREL_POLICY_ID = "kestrel";
export const KESTREL_POLICY_LABEL = "Kestrel";
export const KESTREL_POLICY_VERSION = 2;
export const KESTREL_PROMPT_POLICY_ID = "kestrel";

export const LEGACY_KESTREL_ONE_POLICY_ID = "kestrel-one";
export const LEGACY_KESTREL_ONE_PROMPT_POLICY_ID = "kestrel-one";

/** @deprecated Use KESTREL_POLICY_ID. */
export const KESTREL_ONE_POLICY_ID = KESTREL_POLICY_ID;
export const KESTREL_ONE_POLICY_LABEL = "Kestrel One";
/** @deprecated Use KESTREL_POLICY_VERSION. */
export const KESTREL_ONE_POLICY_VERSION = KESTREL_POLICY_VERSION;
/** @deprecated Use KESTREL_PROMPT_POLICY_ID. */
export const KESTREL_ONE_PROMPT_POLICY_ID = KESTREL_PROMPT_POLICY_ID;

export interface KestrelOnePolicyDefinition {
  id: typeof KESTREL_POLICY_ID;
  version: typeof KESTREL_POLICY_VERSION;
  promptPolicyId: typeof KESTREL_PROMPT_POLICY_ID;
  agent: TuiProfile["agent"];
  requiredModelToolNames: readonly string[];
  allowNestedCollaborators: false;
}

export type KestrelPolicyDefinition = KestrelOnePolicyDefinition;

export const KESTREL_ONE_DIALOG_TOOL_NAMES = Object.freeze([
  "dialog.open",
  "dialog.send",
  "dialog.close",
] as const);

export const KESTREL_ONE_POLICY: Readonly<KestrelOnePolicyDefinition> =
  Object.freeze({
    id: KESTREL_POLICY_ID,
    version: KESTREL_POLICY_VERSION,
    promptPolicyId: KESTREL_PROMPT_POLICY_ID,
    agent: "kestrel",
    requiredModelToolNames: KESTREL_ONE_DIALOG_TOOL_NAMES,
    allowNestedCollaborators: false,
  });

export const KESTREL_POLICY = KESTREL_ONE_POLICY;

export const KESTREL_PROFILE_DEFINITION: Readonly<KestrelProfileDefinitionV1> =
  deepFreeze(
    createKestrelProfileDefinitionV1({
      agent: "kestrel",
      interaction: {
        modeSystemV2Enabled: true,
        defaultInteractionMode: DEFAULT_INTERACTION_MODE,
        defaultActSubmode: DEFAULT_ACT_SUBMODE,
      },
      reasoning: {
        request: { mode: "provider_visible" },
        retention: { mode: "live_only", days: 7 },
      },
      delegation: {
        allowAgentSpawn: true,
        allowNestedCollaborators: false,
        maxConcurrentChildSessions: 2,
        maxDepth: 2,
      },
    }),
  );

export const KESTREL_ONE_INTERNAL_DELEGATION_TOOL_NAMES = Object.freeze([
  "agent.spawn",
  "delegate.spawn_child",
  "delegate.list_children",
  "delegate.get_child_result",
] as const);

export const KESTREL_ONE_WORKSPACE_TOOL_NAMES = Object.freeze([
  "kestrel_one.search_knowledge_documents",
  "kestrel_one.github_repository_read",
  "kestrel_one.github_push_agent_branch",
  "workspace.preview.publish",
  "workspace.preview.list",
  "workspace.preview.inspect",
  "workspace.preview.renew",
  "workspace.preview.close",
  "kestrel_one.github_issue_create",
  "kestrel_one.github_pull_request_create",
  "kestrel_one.github_pull_request_merge",
  "kestrel_one.github_release_create",
  "kestrel_one.github_workflow_dispatch",
  "kestrel_one.google_calendar_list_events",
  "kestrel_one.google_calendar_create_event",
  "kestrel_one.google_calendar_update_event",
  "kestrel_one.google_calendar_delete_event",
  "kestrel_one.google_calendar_list_availability_subjects",
  "kestrel_one.google_calendar_check_availability",
  "kestrel_one.microsoft_365_list_mail",
  "kestrel_one.microsoft_365_send_mail",
  "kestrel_one.microsoft_365_list_events",
  "kestrel_one.microsoft_365_list_chats",
  "kestrel_one.microsoft_365_send_chat_message",
  "kestrel_one.microsoft_365_search_sites",
  "kestrel_one.vercel_list_projects",
  "kestrel_one.vercel_list_deployments",
  "kestrel_one.vercel_deployment_events",
] as const);

export const KESTREL_HARNESS_ECONOMICS = Object.freeze({
  version: 1,
  policy: {
    version: 1,
    policyId: "economics:kestrel:v1",
    mode: "observe",
    counting: {
      estimatorVersion: "utf8-byte-upper-bound:v1",
      allowEstimatedEnforcement: false,
    },
    context: {
      outputReserveTokens: 8_000,
      safetyReserveTokens: 2_000,
      sections: [
        { id: "active-task", priority: "required" },
        { id: "transcript", priority: "required" },
      ],
    },
    compaction: {
      requireStructuredAnchors: true,
      maxSummaryAttempts: 2,
    },
    tools: {
      exposure: "assembly_allowlist",
      modelContextMaxTokens: 4_000,
      allowedFamiliesByPhase: {},
    },
    cache: {
      mode: "provider_default",
    },
  },
  modelProfiles: [
    {
      version: 1,
      profileId: "openrouter:z-ai/glm-5.2:v1",
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 64_000,
      counting: {
        counter: "utf8-byte-upper-bound",
        counterVersion: "1",
        method: "conservative_estimate",
        confidence: "conservative",
      },
      cache: {
        behavior: "provider_automatic",
      },
    },
  ],
} satisfies HarnessEconomicsControlV1);

/** @deprecated Use KESTREL_HARNESS_ECONOMICS. */
export const KESTREL_ONE_HOSTED_HARNESS_ECONOMICS = KESTREL_HARNESS_ECONOMICS;

const DEFAULT_TOOL_QUEUE = Object.freeze({
  perRunConcurrency: 8,
  globalConcurrency: 24,
  maxQueuedJobsPerRun: 50,
  checkpointSize: 10,
  retryCount: 1,
});

export interface KestrelOnePolicyProvenance {
  policyId: typeof KESTREL_POLICY_ID;
  policyVersion: typeof KESTREL_POLICY_VERSION;
  promptPolicyId: typeof KESTREL_PROMPT_POLICY_ID;
  environmentPresetId: Exclude<ShellPresetId, "web_balanced">;
  environmentPresetVersion: number;
  fingerprint: string;
}

export interface KestrelOneEnvironmentPresetDefinition {
  id: Exclude<ShellPresetId, "web_balanced">;
  version: number;
}

export const KESTREL_ONE_ENVIRONMENT_PRESETS: Readonly<
  Record<
    KestrelOneEnvironmentPresetDefinition["id"],
    Readonly<KestrelOneEnvironmentPresetDefinition>
  >
> = Object.freeze({
  cli_safe_local: Object.freeze({ id: "cli_safe_local", version: 1 }),
  cli_dev_local: Object.freeze({ id: "cli_dev_local", version: 1 }),
  desktop_safe_local: Object.freeze({
    id: "desktop_safe_local",
    version: 1,
  }),
  desktop_dev_local: Object.freeze({
    id: "desktop_dev_local",
    version: 1,
  }),
  workspace_hosted: Object.freeze({ id: "workspace_hosted", version: 1 }),
});

export interface KestrelOneProfileOverlay {
  label?: string | undefined;
  modelProvider?: TuiProfile["modelProvider"] | undefined;
  model?: string | undefined;
  modelCredential?: TuiProfile["modelCredential"] | undefined;
  evaluationPolicy?: TuiProfile["evaluationPolicy"] | undefined;
  modelCapabilities?: TuiProfile["modelCapabilities"] | undefined;
  /** @deprecated Harness economics is policy-owned and rejected by composition. */
  harnessEconomics?: TuiProfile["harnessEconomics"] | undefined;
  agentStageConfig?: TuiProfile["agentStageConfig"] | undefined;
  modelTimeoutMs?: number | undefined;
  storeDriver?: TuiProfile["storeDriver"] | undefined;
  approvalPolicyPackId?: TuiProfile["approvalPolicyPackId"] | undefined;
  kestrelOneAppApprovalModes?:
    | TuiProfile["kestrelOneAppApprovalModes"]
    | undefined;
  additionalToolNames?: string[] | undefined;
  mcpServers?: TuiProfile["mcpServers"] | undefined;
  ociMcpEgressBindings?: TuiProfile["ociMcpEgressBindings"] | undefined;
  toolQueue?: TuiProfile["toolQueue"] | undefined;
  codeMode?: TuiProfile["codeMode"] | undefined;
  devShell?: TuiProfile["devShell"] | undefined;
  delegationLimits?:
    | Pick<
        NonNullable<TuiProfile["delegation"]>,
        "maxConcurrentChildSessions" | "maxDepth"
      >
    | undefined;
  reasoning?: TuiProfile["reasoning"] | undefined;
  theme?: TuiProfile["theme"] | undefined;
  default?: boolean | undefined;
}

export type KestrelManagedConfiguration = Omit<
  KestrelOneProfileOverlay,
  "harnessEconomics"
>;

export interface ComposeKestrelOneProfileInput {
  environmentPresetId: Exclude<ShellPresetId, "web_balanced">;
  overlay?: KestrelOneProfileOverlay | undefined;
  resolvedProfileId?: string | undefined;
}

export interface ComposedKestrelOneProfile {
  profile: TuiProfile;
  provenance: KestrelOnePolicyProvenance;
}

export interface ComposeKestrelProfileInput {
  definition: KestrelProfileDefinitionV1;
  environmentBinding: KestrelEnvironmentBindingV1;
  resolvedProfileId?: string | undefined;
}

export type ComposedKestrelProfile = ComposedKestrelOneProfile;

/** @deprecated Use composeKestrelProfile with a canonical definition and binding. */
export function composeKestrelOneProfile(
  input: ComposeKestrelOneProfileInput,
): ComposedKestrelOneProfile {
  return composeKestrelProfile(input);
}

function composeLegacyKestrelOneProfile(
  input: ComposeKestrelOneProfileInput,
): ComposedKestrelOneProfile {
  assertNoPolicyControlledOverlay(input.overlay);
  const environmentPreset =
    KESTREL_ONE_ENVIRONMENT_PRESETS[input.environmentPresetId];
  const shellKind = shellKindForPreset(input.environmentPresetId);
  const resolvedEnvironment = resolveRuntimeProfileSelection({
    shellKind,
    presetId: input.environmentPresetId,
    codeMode: input.overlay?.codeMode,
    devShell: input.overlay?.devShell,
  });
  const runtimeIdentity = buildRuntimeIdentityMetadata({
    agentProfileId: KESTREL_POLICY_ID,
    agentProfileLabel: KESTREL_ONE_POLICY_LABEL,
    shellKind,
    presetId: input.environmentPresetId,
    capabilityPacks: resolvedEnvironment.capabilityPacks,
  });
  const additionalToolNames = [...(input.overlay?.additionalToolNames ?? [])];
  const toolAllowlist = normalizeKestrelOneToolAllowlist([
    ...resolvedEnvironment.toolAllowlist,
    ...additionalToolNames,
    ...KESTREL_ONE_DIALOG_TOOL_NAMES,
  ]);
  assertRequiredKestrelOneTools(toolAllowlist);

  const fingerprint = fingerprintKestrelOneComposition({
    policyId: KESTREL_ONE_POLICY_ID,
    policyVersion: KESTREL_ONE_POLICY_VERSION,
    promptPolicyId: KESTREL_ONE_PROMPT_POLICY_ID,
    environmentPresetId: input.environmentPresetId,
    environmentPresetVersion: environmentPreset.version,
    environmentCapabilityPacks: resolvedEnvironment.capabilityPacks,
    overlay: input.overlay ?? {},
    toolAllowlist,
  });
  const profileId =
    input.resolvedProfileId ??
    `${KESTREL_POLICY_ID}:${input.environmentPresetId}:${fingerprint}`;
  const delegationLimits = input.overlay?.delegationLimits;
  const profile: TuiProfile = {
    id: profileId,
    label: input.overlay?.label ?? KESTREL_ONE_POLICY_LABEL,
    agent: "kestrel",
    sessionPrefix: KESTREL_ONE_POLICY_ID,
    agentProfileId: runtimeIdentity.agentProfileId,
    agentProfileLabel: runtimeIdentity.agentProfileLabel,
    shellKind,
    presetId: input.environmentPresetId,
    capabilityPacks: [...resolvedEnvironment.capabilityPacks],
    environmentShellKind: runtimeIdentity.environmentShellKind,
    environmentPresetId: runtimeIdentity.environmentPresetId,
    environmentCapabilityPackIds: [
      ...runtimeIdentity.environmentCapabilityPackIds,
    ],
    modelProvider: input.overlay?.modelProvider ?? "openrouter",
    ...(input.overlay?.model !== undefined
      ? { model: input.overlay.model }
      : {}),
    ...(input.overlay?.modelCredential !== undefined
      ? { modelCredential: input.overlay.modelCredential }
      : {}),
    ...(input.overlay?.evaluationPolicy !== undefined
      ? { evaluationPolicy: input.overlay.evaluationPolicy }
      : {}),
    ...(input.overlay?.modelCapabilities !== undefined
      ? { modelCapabilities: input.overlay.modelCapabilities }
      : {}),
    harnessEconomics: structuredClone(KESTREL_HARNESS_ECONOMICS),
    ...(input.overlay?.agentStageConfig !== undefined
      ? { agentStageConfig: input.overlay.agentStageConfig }
      : {}),
    ...(input.overlay?.modelTimeoutMs !== undefined
      ? { modelTimeoutMs: input.overlay.modelTimeoutMs }
      : {}),
    storeDriver: input.overlay?.storeDriver ?? "auto",
    approvalPolicyPackId: input.overlay?.approvalPolicyPackId ?? "dev",
    modeSystemV2Enabled: true,
    defaultInteractionMode: DEFAULT_INTERACTION_MODE,
    defaultActSubmode: DEFAULT_ACT_SUBMODE,
    toolAllowlist,
    ...(input.overlay?.kestrelOneAppApprovalModes !== undefined
      ? {
          kestrelOneAppApprovalModes: input.overlay.kestrelOneAppApprovalModes,
        }
      : {}),
    mcpServers: input.overlay?.mcpServers ?? [],
    ...(input.overlay?.ociMcpEgressBindings !== undefined
      ? {
          ociMcpEgressBindings: structuredClone(
            input.overlay.ociMcpEgressBindings,
          ),
        }
      : {}),
    toolQueue: {
      ...DEFAULT_TOOL_QUEUE,
      ...(input.overlay?.toolQueue ?? {}),
    },
    guardrails: { maxStepVisits: 80 },
    codeMode: resolvedEnvironment.codeMode,
    devShell: resolvedEnvironment.devShell,
    delegation: {
      allowAgentSpawn: true,
      maxConcurrentChildSessions: normalizePositiveInteger(
        delegationLimits?.maxConcurrentChildSessions,
        2,
      ),
      // This remains a compatibility/runtime budget. dialog.open separately
      // rejects collaborator contexts, so nested collaborator creation stays
      // prohibited regardless of this value.
      maxDepth: normalizePositiveInteger(delegationLimits?.maxDepth, 2),
    },
    reasoning: input.overlay?.reasoning ?? {
      request: { mode: "provider_visible" },
      retention: { mode: "live_only", days: 7 },
    },
    ...(input.overlay?.theme !== undefined
      ? { theme: input.overlay.theme }
      : {}),
    ...(input.overlay?.default !== undefined
      ? { default: input.overlay.default }
      : {}),
  };

  const resolvedProfile = resolveProfileWithEvaluationPolicy(profile);

  return {
    profile: resolvedProfile,
    provenance: {
      policyId: KESTREL_ONE_POLICY_ID,
      policyVersion: KESTREL_ONE_POLICY_VERSION,
      promptPolicyId: KESTREL_ONE_PROMPT_POLICY_ID,
      environmentPresetId: input.environmentPresetId,
      environmentPresetVersion: environmentPreset.version,
      fingerprint,
    },
  };
}

export function composeKestrelProfile(
  input: ComposeKestrelProfileInput | ComposeKestrelOneProfileInput,
): ComposedKestrelProfile {
  if ("environmentPresetId" in input) {
    return composeLegacyKestrelOneProfile(input);
  }
  const definition = parseKestrelProfileDefinitionV1(input.definition);
  const binding = parseKestrelEnvironmentBindingV1(input.environmentBinding);
  const resolvedEnvironment = resolveRuntimeProfileSelection({
    shellKind: binding.shellKind,
    presetId: binding.presetId,
    codeMode: binding.sandbox.codeMode,
    devShell: binding.sandbox.devShell,
  });
  if (
    JSON.stringify(resolvedEnvironment.capabilityPacks) !==
    JSON.stringify(binding.capabilityPacks)
  ) {
    throw new Error(
      `Kestrel environment '${binding.bindingId}' capability packs do not match its preset.`,
    );
  }
  const runtimeIdentity = buildRuntimeIdentityMetadata({
    agentProfileId: KESTREL_POLICY_ID,
    agentProfileLabel: KESTREL_POLICY_LABEL,
    shellKind: binding.shellKind,
    presetId: binding.presetId,
    capabilityPacks: binding.capabilityPacks,
  });
  const toolAllowlist = normalizeKestrelOneToolAllowlist([
    ...resolvedEnvironment.toolAllowlist,
    ...binding.tools.additionalToolNames,
    ...KESTREL_ONE_DIALOG_TOOL_NAMES,
  ]);
  assertRequiredKestrelOneTools(toolAllowlist);
  const fingerprint = fingerprintKestrelOneComposition({
    profileDefinitionRevision: definition.revision,
    environmentBindingRevision: binding.revision,
    toolAllowlist,
  });
  const profile: TuiProfile = {
    id:
      input.resolvedProfileId ??
      `${KESTREL_POLICY_ID}:${binding.presetId}:${fingerprint}`,
    label: definition.label,
    agent: definition.agent,
    sessionPrefix: KESTREL_POLICY_ID,
    agentProfileId: runtimeIdentity.agentProfileId,
    agentProfileLabel: runtimeIdentity.agentProfileLabel,
    shellKind: binding.shellKind,
    presetId: binding.presetId,
    capabilityPacks: [...binding.capabilityPacks],
    environmentShellKind: runtimeIdentity.environmentShellKind,
    environmentPresetId: runtimeIdentity.environmentPresetId,
    environmentCapabilityPackIds: [
      ...runtimeIdentity.environmentCapabilityPackIds,
    ],
    ...(binding.modelRoute.kind === "pinned"
      ? {
          modelProvider: binding.modelRoute.provider,
          model: binding.modelRoute.model,
          modelCredential: binding.modelRoute.credentialReference,
          modelCapabilities: {
            visionInputEnabled:
              binding.modelRoute.capabilities.visionInputEnabled,
          },
          agentStageConfig: {
            modelByStage: { "agent.loop": binding.modelRoute.model },
          },
        }
      : { modelProvider: "openrouter" as const }),
    harnessEconomics: structuredClone(KESTREL_HARNESS_ECONOMICS),
    storeDriver: binding.storage.driver,
    approvalPolicyPackId: binding.approvals.policyPackId,
    modeSystemV2Enabled: definition.interaction.modeSystemV2Enabled,
    defaultInteractionMode: definition.interaction.defaultInteractionMode,
    defaultActSubmode: definition.interaction.defaultActSubmode,
    toolAllowlist,
    kestrelOneAppApprovalModes: structuredClone(binding.apps.approvalModes),
    mcpServers: structuredClone(binding.tools.mcpServers),
    ociMcpEgressBindings: structuredClone(
      binding.tools.ociMcpEgressBindings,
    ) as TuiProfile["ociMcpEgressBindings"],
    toolQueue: { ...DEFAULT_TOOL_QUEUE, ...binding.queues.tool },
    guardrails: { maxStepVisits: 80 },
    codeMode: resolvedEnvironment.codeMode,
    devShell: resolvedEnvironment.devShell,
    delegation: {
      allowAgentSpawn: definition.delegation.allowAgentSpawn,
      maxConcurrentChildSessions:
        definition.delegation.maxConcurrentChildSessions,
      maxDepth: definition.delegation.maxDepth,
    },
    reasoning: structuredClone(definition.reasoning),
  };
  const routeBound = bindDefinitionPoliciesToEnvironment(
    profile,
    definition,
    binding,
  );
  return {
    profile: routeBound,
    provenance: {
      policyId: KESTREL_POLICY_ID,
      policyVersion: KESTREL_POLICY_VERSION,
      promptPolicyId: KESTREL_PROMPT_POLICY_ID,
      environmentPresetId: binding.presetId,
      environmentPresetVersion:
        KESTREL_ONE_ENVIRONMENT_PRESETS[binding.presetId].version,
      fingerprint,
    },
  };
}

export function createKestrelEnvironmentBindingFromOverlay(input: {
  environmentPresetId: ComposeKestrelOneProfileInput["environmentPresetId"];
  overlay?: KestrelOneProfileOverlay | undefined;
  bindingId?: string | undefined;
  modelRegistrationRevision?: string | undefined;
  tenant?: KestrelEnvironmentBindingV1["tenant"] | undefined;
}): KestrelEnvironmentBindingV1 {
  assertNoPolicyControlledOverlay(input.overlay);
  const shellKind = shellKindForPreset(input.environmentPresetId);
  const resolved = resolveRuntimeProfileSelection({
    shellKind,
    presetId: input.environmentPresetId,
    codeMode: input.overlay?.codeMode,
    devShell: input.overlay?.devShell,
  });
  const modelRoute: KestrelEnvironmentBindingV1["modelRoute"] =
    input.overlay?.model !== undefined &&
    input.overlay.modelProvider !== undefined
      ? {
          kind: "pinned",
          provider: input.overlay.modelProvider,
          model: input.overlay.model,
          modelRegistrationRevision:
            input.modelRegistrationRevision ?? "legacy-overlay:v1",
          capabilities: {
            visionInputEnabled:
              input.overlay.modelCapabilities?.visionInputEnabled === true,
            toolCallingEnabled: true,
            structuredOutputEnabled: true,
            reasoningModes:
              input.overlay.modelProvider === "ollama" ||
              input.overlay.modelProvider === "lmstudio"
                ? ["off", "summary"]
                : ["off", "summary", "provider_visible"],
          },
          ...(input.overlay.modelCredential !== undefined
            ? { credentialReference: input.overlay.modelCredential }
            : {}),
        }
      : {
          kind: "runtime_configuration",
          registrationSource:
            input.environmentPresetId === "workspace_hosted"
              ? "hosted_control_plane"
              : "local_core",
        };
  return createKestrelEnvironmentBindingV1({
    bindingId:
      input.bindingId ?? `kestrel:${input.environmentPresetId}:binding`,
    presetId: input.environmentPresetId,
    shellKind,
    capabilityPacks: [...resolved.capabilityPacks],
    modelRoute,
    sandbox: {
      ...(input.overlay?.codeMode !== undefined
        ? { codeMode: structuredClone(input.overlay.codeMode) }
        : {}),
      ...(input.overlay?.devShell !== undefined
        ? { devShell: structuredClone(input.overlay.devShell) }
        : {}),
    },
    apps: {
      approvalModes: structuredClone(
        input.overlay?.kestrelOneAppApprovalModes ?? {},
      ),
    },
    tools: {
      additionalToolNames: normalizeKestrelOneToolAllowlist(
        input.overlay?.additionalToolNames ?? [],
      ),
      mcpServers: structuredClone(input.overlay?.mcpServers ?? []),
      ociMcpEgressBindings: structuredClone(
        input.overlay?.ociMcpEgressBindings ?? [],
      ) as Array<Record<string, unknown>>,
    },
    approvals: {
      policyPackId: input.overlay?.approvalPolicyPackId ?? "dev",
    },
    storage: { driver: input.overlay?.storeDriver ?? "auto" },
    queues: { tool: { ...(input.overlay?.toolQueue ?? {}) } },
    tenant:
      input.tenant ??
      (input.environmentPresetId === "workspace_hosted"
        ? input.overlay?.modelCredential !== undefined
          ? {
              scope: "hosted",
              organizationId:
                input.overlay.modelCredential.organizationId,
              environmentId: input.overlay.modelCredential.environmentId,
            }
          : {
              scope: "hosted_runtime",
              authoritySource: "trusted_host_context",
            }
        : { scope: "local" }),
  });
}

export function createKestrelProfileDefinitionFromOverlay(
  overlay: KestrelOneProfileOverlay | undefined,
): KestrelProfileDefinitionV1 {
  assertNoPolicyControlledOverlay(overlay);
  return createKestrelProfileDefinitionV1({
    agent: "kestrel",
    interaction: {
      modeSystemV2Enabled: true,
      defaultInteractionMode: DEFAULT_INTERACTION_MODE,
      defaultActSubmode: DEFAULT_ACT_SUBMODE,
    },
    ...(overlay?.evaluationPolicy !== undefined
      ? { evaluationPolicy: structuredClone(overlay.evaluationPolicy) }
      : {}),
    reasoning: structuredClone(
      overlay?.reasoning ?? KESTREL_PROFILE_DEFINITION.reasoning,
    ),
    delegation: {
      allowAgentSpawn: true,
      allowNestedCollaborators: false,
      maxConcurrentChildSessions: normalizePositiveInteger(
        overlay?.delegationLimits?.maxConcurrentChildSessions,
        KESTREL_PROFILE_DEFINITION.delegation.maxConcurrentChildSessions,
      ),
      maxDepth: normalizePositiveInteger(
        overlay?.delegationLimits?.maxDepth,
        KESTREL_PROFILE_DEFINITION.delegation.maxDepth,
      ),
    },
  });
}

function bindDefinitionPoliciesToEnvironment(
  profile: TuiProfile,
  definition: KestrelProfileDefinitionV1,
  binding: KestrelEnvironmentBindingV1,
): TuiProfile {
  if (binding.modelRoute.kind !== "pinned") {
    if (
      definition.evaluationPolicy !== undefined
    ) {
      throw new Error(
        "Route-bound Kestrel evaluation policies require a pinned environment model route.",
      );
    }
    return profile;
  }
  if (definition.evaluationPolicy === undefined) {
    return profile;
  }
  const evaluationPolicy = createRuntimeEvaluationPolicyV1({
    ...structuredClone(definition.evaluationPolicy),
    judge: {
      ...structuredClone(definition.evaluationPolicy.judge),
      provider: binding.modelRoute.provider,
      model: binding.modelRoute.model,
      modelRegistrationRevision:
        binding.modelRoute.modelRegistrationRevision,
      capabilities: structuredClone(binding.modelRoute.capabilities),
      ...(binding.modelRoute.credentialReference !== undefined
        ? {
            credentialReference: structuredClone(
              binding.modelRoute.credentialReference,
            ),
          }
        : { credentialReference: undefined }),
    },
  });
  return resolveProfileWithEvaluationPolicy({
    ...profile,
    evaluationPolicy,
  });
}

export function normalizeKestrelOneToolAllowlist(
  toolNames: readonly string[],
): string[] {
  return [
    ...new Set(
      toolNames
        .map((name) => name.trim())
        .filter(
          (name) =>
            name.length > 0 &&
            name !== "agent.spawn" &&
            name.startsWith("delegate.") === false,
        ),
    ),
  ];
}

export function assertRequiredKestrelOneTools(
  toolNames: readonly string[],
): void {
  const available = new Set(toolNames);
  const missing = KESTREL_ONE_DIALOG_TOOL_NAMES.filter(
    (name) => available.has(name) === false,
  );
  if (missing.length > 0) {
    throw new Error(
      `Kestrel One policy is missing required model tools: ${missing.join(", ")}.`,
    );
  }
}

export function fingerprintResolvedProfile(
  profile: TuiProfile,
  revisionProvenance?: unknown,
): string {
  return createHash("sha256")
    .update(
      stableJson(
        {
          profile,
          executionBoundaryPolicyRevision:
            KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
          ...(revisionProvenance !== undefined ? { revisionProvenance } : {}),
        },
      ),
    )
    .digest("hex");
}

function fingerprintKestrelOneComposition(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function assertNoPolicyControlledOverlay(
  overlay: KestrelOneProfileOverlay | undefined,
): void {
  if (overlay === undefined) return;
  const record = overlay as Record<string, unknown>;
  const rejected = [
    "agent",
    "agentProfileId",
    "agentProfileLabel",
    "defaultInteractionMode",
    "defaultActSubmode",
    "guardrails",
    "harnessEconomics",
    "modeSystemV2Enabled",
    "promptPolicyId",
    "sessionPrefix",
    "toolAllowlist",
  ].filter((field) => record[field] !== undefined);
  if (rejected.length > 0) {
    throw new Error(
      `Kestrel policy composition rejects policy-controlled field(s): ${rejected.join(", ")}.`,
    );
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function shellKindForPreset(
  presetId: ComposeKestrelOneProfileInput["environmentPresetId"],
): ShellKind {
  if (presetId === "desktop_safe_local" || presetId === "desktop_dev_local")
    return "desktop";
  if (presetId === "workspace_hosted") return "web";
  return "cli";
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.trunc(value))
    : fallback;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
