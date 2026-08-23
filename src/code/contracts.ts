export type CodeExecutionLanguage = "javascript" | "python" | "bash";
export type CodeNetworkMode = "off" | "on";
export type CodeExecutionStatus =
  | "ok"
  | "error"
  | "timeout"
  | "blocked"
  | "runtime_unavailable";

export interface CodeExecutionFile {
  path: string;
  content: string;
}

export interface CodeExecutionRequest {
  language: CodeExecutionLanguage;
  code: string;
  files?: CodeExecutionFile[] | undefined;
  timeoutMs?: number | undefined;
  network?: CodeNetworkMode | undefined;
  dependencies?: string[] | undefined;
  args?: string[] | undefined;
  capability?: import("../kestrel/contracts/sandbox-capability.js").SandboxCapabilitySelectionV1 | undefined;
}

export interface CodeExecutionArtifact {
  path: string;
  sizeBytes: number;
  sha256: string;
  preview?: {
    text: string;
    truncated: boolean;
  } | undefined;
}

export interface AppliedCodeExecutionPolicy {
  enabled: boolean;
  approvalMode: "auto";
  executor: "docker";
  language: CodeExecutionLanguage;
  timeoutMs: number;
  memoryMb: number;
  cpuShares: number;
  pidsLimit: number;
  workspaceSizeMb: number;
  workspaceInodes: number;
  tmpSizeMb: number;
  tmpInodes: number;
  network: CodeNetworkMode;
  allowDependencyInstall: boolean;
  maxOutputBytes: number;
  maxArtifacts: number;
  maxArtifactBytes: number;
}

export interface CodeExecutionResult {
  status: CodeExecutionStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  artifacts: CodeExecutionArtifact[];
  summary: string;
  policy: AppliedCodeExecutionPolicy;
  retention: CodeModeRetentionConfig;
}

export interface CodeModeSandboxConfig {
  executor: "docker";
  timeoutMs: number;
  memoryMb: number;
  cpuShares: number;
  pidsLimit?: number | undefined;
  workspaceSizeMb?: number | undefined;
  workspaceInodes?: number | undefined;
  tmpSizeMb?: number | undefined;
  tmpInodes?: number | undefined;
  networkDefault: CodeNetworkMode;
  allowDependencyInstall: boolean;
  maxOutputBytes: number;
  maxArtifacts: number;
  maxArtifactBytes: number;
}

export interface CodeModeRetentionConfig {
  persistSummary: boolean;
  persistArtifacts: boolean;
}

export interface CodeModeProfileConfig {
  enabled: boolean;
  languages: CodeExecutionLanguage[];
  sandbox: CodeModeSandboxConfig;
  retention: CodeModeRetentionConfig;
  approvalMode: "auto";
  capabilities?: import("../kestrel/contracts/sandbox-capability.js").SandboxCapabilityProfileV1[] | undefined;
}

export const DEFAULT_CODE_MODE_SANDBOX: CodeModeSandboxConfig = {
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
};

export const DEFAULT_CODE_MODE_RETENTION: CodeModeRetentionConfig = {
  persistSummary: true,
  persistArtifacts: true,
};

export const DEFAULT_CODE_MODE_DISABLED_CONFIG: CodeModeProfileConfig = {
  enabled: false,
  languages: ["javascript", "python", "bash"],
  sandbox: { ...DEFAULT_CODE_MODE_SANDBOX },
  retention: { ...DEFAULT_CODE_MODE_RETENTION },
  approvalMode: "auto",
};

export const DEFAULT_CODE_MODE_ENABLED_CONFIG: CodeModeProfileConfig = {
  ...DEFAULT_CODE_MODE_DISABLED_CONFIG,
  enabled: true,
};

export interface SandboxExecutionInput {
  request: CodeExecutionRequest;
  policy: AppliedCodeExecutionPolicy;
  capability?: SandboxCapabilityGrant | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * A short-lived grant supplied by trusted runtime code. It is deliberately not
 * part of CodeExecutionRequest or profile configuration, so model-authored and
 * persisted inputs cannot contain the lease.
 */
export interface SandboxCapabilityGrant {
  transport: "docker-shared-loopback-v1";
  lease: string;
  operation: string;
  destination: string;
  response: unknown;
  expiresAt?: string | undefined;
  maxRequests?: 1 | undefined;
  maxResponseBytes?: number | undefined;
  authority?: import("../kestrel/contracts/sandbox-capability.js").SandboxCapabilityAuthorityV1 | undefined;
  expectedInput?: { query: string; maxResults: number } | undefined;
  /** Trusted host-only adapter. This function is never serialized into Docker state. */
  adapter?: ((input: { query: string; maxResults: number }, signal: AbortSignal) => Promise<unknown>) | undefined;
  /**
   * Host-only durable lifecycle hooks. Like the adapter, these functions are
   * never serialized into broker or workload state.
   */
  lifecycle?: {
    beforeProviderInvocation: () => Promise<void>;
    commitProviderResult: (input: {
      result: unknown;
      responseBytes: number;
      resultCount: number;
    }) => Promise<void>;
    recordProviderFailure: (error: unknown) => Promise<void>;
    beforeContainerTeardown: (reason: "completed" | "failed" | "cancelled" | "timeout") => Promise<void>;
  } | undefined;
}

export interface SandboxCapabilityRuntimeContext {
  tenantId: string;
  environmentId: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  /** Exact prepared-call policy decision; never inferred from the profile. */
  policy?: import("../kestrel/contracts/tool-invocation.js").PreparedToolPolicyDispositionV1 | undefined;
  /** Exact prepared-call approval authority, when policy required approval. */
  approval?: import("../kestrel/contracts/tool-invocation.js").PreparedToolApprovalAuthorityV1 | undefined;
  /** A child must carry an independently persisted authorization inside this parent ceiling. */
  parentAuthorization?: import("../kestrel/contracts/sandbox-capability.js").SandboxCapabilityLeaseBindingV1["parentAuthorization"] | undefined;
  profileFingerprint: string;
  capabilityCatalogFingerprint: string;
  executionBoundaryRevision: string;
  brokerAuthority: { authorityId: string; revision: string };
  leaseCoordinator?: import("./SandboxCapabilityLeaseCoordinator.js").SandboxCapabilityLeaseCoordinator | undefined;
  credentialSnapshot?: {
    credentialId: "tool.tavily.default";
    revision: string;
    secret: string;
  } | undefined;
  resolveCredentialSnapshot?: (() => Promise<{ credentialId: "tool.tavily.default"; revision: string; secret: string }>) | undefined;
  resolveParentAuthorization?: ((input: {
    sessionId: string;
    runId: string;
    toolCallId: string;
  }) => Promise<import("../kestrel/contracts/sandbox-capability.js").SandboxCapabilityLeaseBindingV1["parentAuthorization"] | undefined>) | undefined;
  now?: (() => Date) | undefined;
  fetchImpl?: typeof fetch | undefined;
  registerSensitiveValue?: ((input: {
    referenceId: string;
    value: string;
  }) => (() => void)) | undefined;
  redactSensitiveValues?: (<T>(value: T) => T) | undefined;
}

export interface SandboxExecutionOutput {
  status: "ok" | "error" | "timeout";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  artifacts: CodeExecutionArtifact[];
}

export interface SandboxExecutor {
  execute(input: SandboxExecutionInput): Promise<SandboxExecutionOutput>;
}

export interface CodeExecutionServicePort {
  execute(
    config: CodeModeProfileConfig,
    request: CodeExecutionRequest,
    options?: {
      signal?: AbortSignal | undefined;
      capability?: SandboxCapabilityGrant | undefined;
      capabilityRuntime?: SandboxCapabilityRuntimeContext | undefined;
    },
  ): Promise<CodeExecutionResult>;
}
