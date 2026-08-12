import { RUNNER_BUILT_IN_TOOL_NAMES } from "@kestrel-agents/protocol";

import type {
  ComposedManagedKestrelProfile,
  ComposeManagedKestrelProfileInput,
  KestrelCapabilityPackId,
  KestrelManagedEnvironmentPresetId,
  KestrelShellKind,
  ManagedCodeModeProfileConfig,
  ManagedDevShellProfileConfig,
  ManagedHarnessEconomicsControl,
  ManagedKestrelProfile,
  ManagedKestrelProfileOverlay,
  ManagedRuntimeEvaluationPolicy,
} from "./contracts.js";
import { fingerprintCanonicalValue } from "./stable.js";

export const KESTREL_POLICY_ID = "kestrel" as const;
export const KESTREL_POLICY_LABEL = "Kestrel" as const;
export const KESTREL_ONE_POLICY_LABEL = "Kestrel One" as const;
export const KESTREL_POLICY_VERSION = 2 as const;
export const KESTREL_PROMPT_POLICY_ID = "kestrel" as const;

export const KESTREL_DIALOG_TOOL_NAMES = Object.freeze([
  "dialog.open",
  "dialog.send",
  "dialog.close",
] as const);

export const KESTREL_ENVIRONMENT_PRESETS = Object.freeze({
  cli_safe_local: Object.freeze({ id: "cli_safe_local", version: 1 }),
  cli_dev_local: Object.freeze({ id: "cli_dev_local", version: 1 }),
  desktop_safe_local: Object.freeze({ id: "desktop_safe_local", version: 1 }),
  desktop_dev_local: Object.freeze({ id: "desktop_dev_local", version: 1 }),
  workspace_hosted: Object.freeze({ id: "workspace_hosted", version: 1 }),
} satisfies Record<
  KestrelManagedEnvironmentPresetId,
  { id: KestrelManagedEnvironmentPresetId; version: number }
>);

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
    compaction: { requireStructuredAnchors: true, maxSummaryAttempts: 2 },
    tools: {
      exposure: "assembly_allowlist",
      modelContextMaxTokens: 4_000,
      allowedFamiliesByPhase: {},
    },
    cache: { mode: "provider_default" },
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
      cache: { behavior: "provider_automatic" },
    },
  ],
} satisfies ManagedHarnessEconomicsControl);

const DEFAULT_TOOL_QUEUE = Object.freeze({
  perRunConcurrency: 8,
  globalConcurrency: 24,
  maxQueuedJobsPerRun: 50,
  checkpointSize: 10,
  retryCount: 1,
});

const DEFAULT_CODE_MODE_SANDBOX = {
  executor: "docker",
  timeoutMs: 20_000,
  memoryMb: 256,
  cpuShares: 256,
  pidsLimit: 64,
  workspaceSizeMb: 64,
  workspaceInodes: 8_192,
  tmpSizeMb: 32,
  tmpInodes: 2_048,
  networkDefault: "off",
  allowDependencyInstall: false,
  maxOutputBytes: 32_000,
  maxArtifacts: 20,
  maxArtifactBytes: 64_000,
} as const;

const DEFAULT_CODE_MODE: ManagedCodeModeProfileConfig = {
  enabled: false,
  languages: ["javascript", "python", "bash"],
  sandbox: { ...DEFAULT_CODE_MODE_SANDBOX },
  retention: { persistSummary: true, persistArtifacts: true },
  approvalMode: "auto",
};

const DEFAULT_DEV_SHELL: ManagedDevShellProfileConfig = {
  enabled: false,
  idleTimeoutMs: 30 * 60_000,
  maxReadBytes: 131_072,
  allowedEnvNames: [],
  envMode: "allowlist",
};

const BALANCED_TOOL_NAMES = [
  ...RUNNER_BUILT_IN_TOOL_NAMES,
  "internet.search",
  "internet.search_advanced",
  "internet.news",
  "internet.images",
  "internet.extract",
  "internet.crawl",
  "internet.map",
  "internet.research",
  "internet.research_status",
  "evidence.extract",
  "effect_result_lookup",
  "planning.write_document",
  "task.propose",
  "FinalizeAnswer",
] as const;

const FILESYSTEM_TOOL_NAMES = [
  "fs.list",
  "fs.read_text",
  "fs.create_text",
  "fs.edit_text",
  "fs.apply_patch",
  "fs.verify_json",
  "fs.search_text",
  "repo.trace",
  "fs.write_text",
  "fs.replace_text",
  "fs.mkdir",
  "fs.copy",
  "fs.move",
  "fs.delete",
] as const;

const CODING_FILESYSTEM_TOOL_NAMES = FILESYSTEM_TOOL_NAMES.filter(
  (toolName) => toolName !== "fs.write_text" && toolName !== "fs.replace_text",
);

const DEV_SHELL_TOOL_NAMES = [
  "exec_command",
  "dev.shell.run",
  "dev.process.start",
  "dev.process.write",
  "dev.process.write_and_read",
  "dev.process.read",
  "dev.process.stop",
] as const;

const PACK_ORDER: KestrelCapabilityPackId[] = [
  "balanced",
  "filesystem",
  "dev_shell",
  "desktop_host",
  "sandbox_code",
];

const PRESET_PACKS: Record<
  KestrelManagedEnvironmentPresetId,
  KestrelCapabilityPackId[]
> = {
  cli_safe_local: ["balanced", "filesystem", "sandbox_code"],
  cli_dev_local: ["balanced", "filesystem", "dev_shell"],
  desktop_safe_local: [
    "balanced",
    "filesystem",
    "desktop_host",
    "sandbox_code",
  ],
  desktop_dev_local: ["balanced", "filesystem", "dev_shell", "desktop_host"],
  workspace_hosted: ["balanced", "filesystem", "dev_shell"],
};

const PACK_TOOL_NAMES: Record<KestrelCapabilityPackId, readonly string[]> = {
  balanced: BALANCED_TOOL_NAMES,
  filesystem: [...CODING_FILESYSTEM_TOOL_NAMES, "artifact.read"],
  dev_shell: DEV_SHELL_TOOL_NAMES,
  desktop_host: ["desktop.host.open"],
  sandbox_code: ["code.execute"],
};

export function composeManagedKestrelProfile(
  input: ComposeManagedKestrelProfileInput,
): ComposedManagedKestrelProfile {
  assertNoPolicyControlledOverlay(input.overlay);
  const environmentPreset =
    KESTREL_ENVIRONMENT_PRESETS[input.environmentPresetId];
  const shellKind = shellKindForPreset(input.environmentPresetId);
  const resolvedEnvironment = resolveEnvironment(
    input.environmentPresetId,
    input.overlay,
  );
  const additionalToolNames = [...(input.overlay?.additionalToolNames ?? [])];
  const toolAllowlist = normalizeManagedKestrelToolAllowlist([
    ...resolvedEnvironment.toolAllowlist,
    ...additionalToolNames,
    ...KESTREL_DIALOG_TOOL_NAMES,
  ]);
  assertRequiredManagedKestrelTools(toolAllowlist);

  const fingerprint = fingerprintCanonicalValue({
    policyId: KESTREL_POLICY_ID,
    policyVersion: KESTREL_POLICY_VERSION,
    promptPolicyId: KESTREL_PROMPT_POLICY_ID,
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
  const profile: ManagedKestrelProfile = {
    id: profileId,
    label: input.overlay?.label ?? KESTREL_ONE_POLICY_LABEL,
    agent: "kestrel",
    sessionPrefix: KESTREL_POLICY_ID,
    runtimeId: input.overlay?.runtimeId ?? "kestrel",
    agentProfileId: KESTREL_POLICY_ID,
    agentProfileLabel: KESTREL_ONE_POLICY_LABEL,
    shellKind,
    presetId: input.environmentPresetId,
    capabilityPacks: [...resolvedEnvironment.capabilityPacks],
    environmentShellKind: shellKind,
    environmentPresetId: input.environmentPresetId,
    environmentCapabilityPackIds: [...resolvedEnvironment.capabilityPacks],
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
    defaultInteractionMode: "chat",
    defaultActSubmode: "safe",
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
    toolQueue: { ...DEFAULT_TOOL_QUEUE, ...(input.overlay?.toolQueue ?? {}) },
    guardrails: { maxStepVisits: 80 },
    codeMode: resolvedEnvironment.codeMode,
    devShell: resolvedEnvironment.devShell,
    delegation: {
      allowAgentSpawn: true,
      maxConcurrentChildSessions: normalizePositiveInteger(
        delegationLimits?.maxConcurrentChildSessions,
        2,
      ),
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

  return {
    profile: resolveEvaluationPolicy(profile),
    provenance: {
      policyId: KESTREL_POLICY_ID,
      policyVersion: KESTREL_POLICY_VERSION,
      promptPolicyId: KESTREL_PROMPT_POLICY_ID,
      environmentPresetId: input.environmentPresetId,
      environmentPresetVersion: environmentPreset.version,
      fingerprint,
    },
  };
}

export function normalizeManagedKestrelToolAllowlist(
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

export function assertRequiredManagedKestrelTools(
  toolNames: readonly string[],
): void {
  const available = new Set(toolNames);
  const missing = KESTREL_DIALOG_TOOL_NAMES.filter(
    (name) => available.has(name) === false,
  );
  if (missing.length > 0) {
    throw new Error(
      `Kestrel One policy is missing required model tools: ${missing.join(", ")}.`,
    );
  }
}

function resolveEnvironment(
  presetId: KestrelManagedEnvironmentPresetId,
  overlay: ManagedKestrelProfileOverlay | undefined,
): {
  capabilityPacks: KestrelCapabilityPackId[];
  toolAllowlist: string[];
  codeMode: ManagedCodeModeProfileConfig;
  devShell: ManagedDevShellProfileConfig;
} {
  const capabilityPacks = [...PRESET_PACKS[presetId]].sort(
    (left, right) => PACK_ORDER.indexOf(left) - PACK_ORDER.indexOf(right),
  );
  const toolAllowlist: string[] = [];
  for (const packId of capabilityPacks) {
    for (const toolName of PACK_TOOL_NAMES[packId]) {
      if (toolAllowlist.includes(toolName) === false)
        toolAllowlist.push(toolName);
    }
  }
  const codeModeEnabled = capabilityPacks.includes("sandbox_code");
  const devShellEnabled = capabilityPacks.includes("dev_shell");
  return {
    capabilityPacks,
    toolAllowlist,
    codeMode: {
      ...DEFAULT_CODE_MODE,
      ...(overlay?.codeMode ?? {}),
      enabled: codeModeEnabled,
    },
    devShell: {
      ...DEFAULT_DEV_SHELL,
      ...(devShellEnabled ? { envMode: "inherit" as const } : {}),
      ...(overlay?.devShell ?? {}),
      enabled: devShellEnabled,
    },
  };
}

function resolveEvaluationPolicy(
  profile: ManagedKestrelProfile,
): ManagedKestrelProfile {
  if (profile.evaluationPolicy === undefined) return profile;
  const policy = structuredClone(profile.evaluationPolicy);
  if (
    profile.modelProvider !== policy.judge.provider ||
    profile.model !== policy.judge.model
  ) {
    throw new Error(
      `Profile '${profile.id}' primary model projection does not match evaluation policy '${policy.policyId}'.`,
    );
  }
  if (
    JSON.stringify(profile.modelCredential ?? null) !==
    JSON.stringify(policy.judge.credentialReference ?? null)
  ) {
    throw new Error(
      `Profile '${profile.id}' primary credential projection does not match evaluation policy '${policy.policyId}'.`,
    );
  }
  if (
    policy.judge.capabilities.visionInputEnabled !==
    (profile.modelCapabilities?.visionInputEnabled === true)
  ) {
    throw new Error(
      `Profile '${profile.id}' primary capability projection does not match evaluation policy '${policy.policyId}'.`,
    );
  }
  return { ...structuredClone(profile), evaluationPolicy: policy };
}

function assertNoPolicyControlledOverlay(
  overlay: ManagedKestrelProfileOverlay | undefined,
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

function shellKindForPreset(
  presetId: KestrelManagedEnvironmentPresetId,
): KestrelShellKind {
  if (presetId === "desktop_safe_local" || presetId === "desktop_dev_local") {
    return "desktop";
  }
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
