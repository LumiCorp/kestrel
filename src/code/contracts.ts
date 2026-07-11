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
}

export const DEFAULT_CODE_MODE_SANDBOX: CodeModeSandboxConfig = {
  executor: "docker",
  timeoutMs: 20_000,
  memoryMb: 256,
  cpuShares: 256,
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
  execute(config: CodeModeProfileConfig, request: CodeExecutionRequest): Promise<CodeExecutionResult>;
}
