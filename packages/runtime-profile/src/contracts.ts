import type {
  RunnerActSubmode,
  RunnerInteractionMode,
  RunnerModelProvider,
  RunnerProfile,
} from "@kestrel-agents/protocol";

export type KestrelManagedEnvironmentPresetId =
  | "cli_safe_local"
  | "cli_dev_local"
  | "desktop_safe_local"
  | "desktop_dev_local"
  | "workspace_hosted";

export type KestrelShellKind = "cli" | "web" | "desktop";

export type KestrelCapabilityPackId =
  | "balanced"
  | "filesystem"
  | "dev_shell"
  | "desktop_host"
  | "sandbox_code";

export interface ManagedModelCredentialReference {
  source: "kestrel-one";
  runId: string;
  gatewayId: string;
  organizationId: string;
  environmentId: string;
  rawModelId: string;
  provider: Exclude<RunnerModelProvider, "lmstudio">;
}

export interface ManagedRuntimeEvaluationPolicy {
  version: "runtime_evaluation_policy_v1";
  policyId: string;
  revision: string;
  evaluator: { evaluatorId: string; evaluatorVersion: string };
  assets: {
    bundleId: string;
    revision: string;
    rubricRevision: string;
    assertionsRevision: string;
    promptRevision: string;
    schemaRevision: string;
    calibrationDatasetRevision: string;
    evaluatorCodeRevision: string;
  };
  judge: {
    route: "profile_primary";
    provider: RunnerModelProvider;
    model: string;
    modelRegistrationRevision: string;
    capabilities: {
      visionInputEnabled: boolean;
      toolCallingEnabled: boolean;
      structuredOutputEnabled: boolean;
      reasoningModes: Array<"off" | "summary" | "provider_visible">;
    };
    credentialReference?: ManagedModelCredentialReference | undefined;
    pricing: {
      priceRevision: string;
      inputUsdPerMillionTokens: number;
      outputUsdPerMillionTokens: number;
    };
  };
  calibration: { recordId: string; recordRevision: string };
  hooks: Array<{
    kind: "after_tool" | "milestone" | "handoff" | "pre_delivery";
    mode: "advisory" | "blocking";
    selectorIds: string[];
  }>;
  budget: Record<string, number>;
  thresholds: Record<string, number>;
  actions: {
    revisionHandlerId: "evaluation.revise";
    reviewOptionIds: Array<
      "evaluation.accept_once" | "evaluation.revise" | "terminal.fail"
    >;
  };
}

export interface ManagedCodeModeProfileConfig {
  [key: string]: unknown;
  enabled: boolean;
  languages: Array<"javascript" | "python" | "bash">;
  sandbox: {
    executor: "docker";
    timeoutMs: number;
    memoryMb: number;
    cpuShares: number;
    pidsLimit?: number | undefined;
    workspaceSizeMb?: number | undefined;
    workspaceInodes?: number | undefined;
    tmpSizeMb?: number | undefined;
    tmpInodes?: number | undefined;
    networkDefault: "off" | "on";
    allowDependencyInstall: boolean;
    maxOutputBytes: number;
    maxArtifacts: number;
    maxArtifactBytes: number;
  };
  retention: { persistSummary: boolean; persistArtifacts: boolean };
  approvalMode: "auto";
}

export interface ManagedDevShellProfileConfig {
  enabled: boolean;
  idleTimeoutMs?: number | undefined;
  maxReadBytes?: number | undefined;
  allowedEnvNames?: string[] | undefined;
  envMode?: "inherit" | "allowlist" | undefined;
  sourceWriteAuthority?: "source_readonly" | "source_write" | undefined;
  sourceWriteGuard?: Record<string, unknown> | undefined;
}

export interface ManagedHarnessEconomicsControl {
  version: 1;
  policy: {
    version: 1;
    policyId: string;
    mode: "observe" | "enforce";
    counting: {
      estimatorVersion: string;
      allowEstimatedEnforcement: boolean;
    };
    context: {
      outputReserveTokens: number;
      safetyReserveTokens: number;
      sections: Array<{ id: string; priority: "required" | "optional" }>;
    };
    compaction: { requireStructuredAnchors: true; maxSummaryAttempts: 1 | 2 };
    tools: {
      exposure: "assembly_allowlist" | "phase_scoped";
      modelContextMaxTokens: number;
      allowedFamiliesByPhase: Record<string, string[]>;
    };
    cache: { mode: "provider_default" | "stable_prefix" };
  };
  modelProfiles: Array<{
    version: 1;
    profileId: string;
    provider: string;
    model: string;
    contextWindowTokens: number;
    maxOutputTokens: number;
    counting: {
      counter: string;
      counterVersion: string;
      method: "provider_reported" | "model_tokenizer" | "conservative_estimate";
      confidence: "provider_exact" | "model_compatible" | "conservative";
    };
    cache: {
      behavior: "none" | "provider_automatic" | "anthropic_ephemeral";
    };
  }>;
}

export interface ManagedKestrelProfile extends RunnerProfile {
  agent: "kestrel";
  runtimeId: NonNullable<RunnerProfile["runtimeId"]>;
  agentProfileId: string;
  agentProfileLabel: string;
  shellKind: KestrelShellKind;
  presetId: KestrelManagedEnvironmentPresetId;
  capabilityPacks: KestrelCapabilityPackId[];
  environmentShellKind: KestrelShellKind;
  environmentPresetId: KestrelManagedEnvironmentPresetId;
  environmentCapabilityPackIds: KestrelCapabilityPackId[];
  modelProvider: RunnerModelProvider;
  modelCredential?: ManagedModelCredentialReference | undefined;
  evaluationPolicy?: ManagedRuntimeEvaluationPolicy | undefined;
  modelCapabilities?: { visionInputEnabled?: boolean | undefined } | undefined;
  harnessEconomics: ManagedHarnessEconomicsControl;
  agentStageConfig?:
    | { modelByStage?: Record<string, string> | undefined }
    | undefined;
  modelTimeoutMs?: number | undefined;
  storeDriver: "auto" | "postgres" | "sqlite";
  approvalPolicyPackId: "dev" | "ci_bot" | "production";
  modeSystemV2Enabled: true;
  defaultInteractionMode: RunnerInteractionMode;
  defaultActSubmode: RunnerActSubmode;
  toolAllowlist: string[];
  mcpServers: Array<Record<string, unknown>>;
  ociMcpEgressBindings?: Array<Record<string, unknown>> | undefined;
  toolQueue: {
    perRunConcurrency?: number | undefined;
    globalConcurrency?: number | undefined;
    maxQueuedJobsPerRun?: number | undefined;
    checkpointSize?: number | undefined;
    retryCount?: number | undefined;
  };
  guardrails: {
    maxStepVisits: number;
    maxMaintenanceModelCallsPerRun: number;
  };
  codeMode: ManagedCodeModeProfileConfig;
  devShell: ManagedDevShellProfileConfig;
  delegation: {
    allowAgentSpawn: true;
    maxConcurrentChildSessions: number;
    maxDepth: number;
  };
  reasoning: {
    request: {
      mode: "off" | "summary" | "provider_visible";
      effort?: "low" | "medium" | "high" | undefined;
    };
    retention: { mode: "live_only" | "provider_visible"; days: number };
  };
  theme?: Record<string, string | undefined> | undefined;
}

export interface ManagedKestrelProfileOverlay {
  runtimeId?: ManagedKestrelProfile["runtimeId"] | undefined;
  label?: string | undefined;
  modelProvider?: RunnerModelProvider | undefined;
  model?: string | undefined;
  modelCredential?: ManagedModelCredentialReference | undefined;
  evaluationPolicy?: ManagedRuntimeEvaluationPolicy | undefined;
  modelCapabilities?: ManagedKestrelProfile["modelCapabilities"] | undefined;
  /** Policy-owned. Its presence is rejected by composition. */
  harnessEconomics?: ManagedHarnessEconomicsControl | undefined;
  agentStageConfig?: ManagedKestrelProfile["agentStageConfig"] | undefined;
  modelTimeoutMs?: number | undefined;
  storeDriver?: ManagedKestrelProfile["storeDriver"] | undefined;
  approvalPolicyPackId?:
    | ManagedKestrelProfile["approvalPolicyPackId"]
    | undefined;
  kestrelOneAppApprovalModes?: Record<string, "auto" | "ask"> | undefined;
  additionalToolNames?: string[] | undefined;
  mcpServers?: Array<Record<string, unknown>> | undefined;
  ociMcpEgressBindings?: Array<Record<string, unknown>> | undefined;
  toolQueue?: ManagedKestrelProfile["toolQueue"] | undefined;
  codeMode?: ManagedCodeModeProfileConfig | undefined;
  devShell?: ManagedDevShellProfileConfig | undefined;
  delegationLimits?:
    | {
        maxConcurrentChildSessions?: number | undefined;
        maxDepth?: number | undefined;
      }
    | undefined;
  reasoning?: ManagedKestrelProfile["reasoning"] | undefined;
  theme?: ManagedKestrelProfile["theme"] | undefined;
  default?: boolean | undefined;
}

export interface ComposeManagedKestrelProfileInput {
  environmentPresetId: KestrelManagedEnvironmentPresetId;
  overlay?: ManagedKestrelProfileOverlay | undefined;
  resolvedProfileId?: string | undefined;
}

export interface ManagedKestrelProfileProvenance {
  policyId: "kestrel";
  policyVersion: 3;
  promptPolicyId: "kestrel";
  environmentPresetId: KestrelManagedEnvironmentPresetId;
  environmentPresetVersion: number;
  fingerprint: string;
}

export interface ComposedManagedKestrelProfile {
  profile: ManagedKestrelProfile;
  provenance: ManagedKestrelProfileProvenance;
}
