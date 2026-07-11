export type DevShellProcessStatus =
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "STOPPED"
  | "LOST";

export const DEV_SHELL_BRIDGE_URL_ENV = "KESTREL_DEV_SHELL_BRIDGE_URL";
export const DEV_SHELL_SOCKET_PATH_ENV = "KESTREL_DEV_SHELL_SOCKET_PATH";
export const DEV_SHELL_SERVICE_PROTOCOL_VERSION = 2;

export interface DevShellHealth {
  ok: boolean;
  serviceProtocolVersion: number;
  capabilities: {
    processWriteAndRead: boolean;
  };
}

export type DevShellEnvMode = "inherit" | "allowlist";
export type DevShellSourceWriteAuthority = "source_readonly" | "source_write";

export interface DevShellToolCheck {
  name: string;
  present: boolean;
  path?: string | undefined;
}

export interface DevShellEnvCheck {
  name: string;
  present: boolean;
}

export interface DevShellReadiness {
  workspaceRootExists: boolean;
  cwdExists: boolean;
  cwdWithinWorkspace: boolean;
  shellResolved: boolean;
  tools: DevShellToolCheck[];
  env: DevShellEnvCheck[];
}

export interface DevShellProfileConfig {
  enabled: boolean;
  idleTimeoutMs?: number | undefined;
  maxReadBytes?: number | undefined;
  allowedEnvNames?: string[] | undefined;
  envMode?: DevShellEnvMode | undefined;
  sourceWriteAuthority?: DevShellSourceWriteAuthority | undefined;
  sourceWriteGuard?: DevShellSourceWriteGuardProfile | undefined;
}

export const DEFAULT_DEV_SHELL_DISABLED_CONFIG: DevShellProfileConfig = {
  enabled: false,
  idleTimeoutMs: 30 * 60_000,
  maxReadBytes: 131_072,
  allowedEnvNames: [],
  envMode: "allowlist",
};

export const DEFAULT_DEV_SHELL_ENABLED_CONFIG: DevShellProfileConfig = {
  ...DEFAULT_DEV_SHELL_DISABLED_CONFIG,
  enabled: true,
  envMode: "inherit",
};

export interface DevShellProcessRecord {
  processId: string;
  command: string;
  status: DevShellProcessStatus;
  workspaceRoot: string;
  cwd: string;
  shellPath: string;
  idleTimeoutMs: number;
  maxReadBytes: number;
  readiness: DevShellReadiness;
  requestedTools: string[];
  envNames: string[];
  transcriptPath: string;
  outputCursor: number;
  submittedAt: string;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
  completedAt?: string | undefined;
  exitCode?: number | undefined;
  stopSignal?: string | undefined;
  failureReason?: string | undefined;
  failurePhase?: "command" | undefined;
  commandKind?: "single_line" | "multi_line" | undefined;
  strictModeApplied?: boolean | undefined;
  strictModeReason?: string | undefined;
  preflight?: DevShellPreflightResult | undefined;
  sourceWriteGuard?: DevShellSourceWriteGuardResult | undefined;
}

export interface DevShellCommandInput {
  workspaceRoot?: string | undefined;
  command: string;
  cwd?: string | undefined;
  requiredTools?: string[] | undefined;
  envNames?: string[] | undefined;
  idleTimeoutMs?: number | undefined;
  maxReadBytes?: number | undefined;
  maxOutputBytes?: number | undefined;
  yieldTimeMs?: number | undefined;
  allowedEnvNames?: string[] | undefined;
  envMode?: DevShellEnvMode | undefined;
  packageManagerPreflight?: DevShellPackageManagerPreflightConfig | undefined;
  sourceWriteAuthority?: DevShellSourceWriteAuthority | undefined;
  sourceWriteGuard?: DevShellSourceWriteGuardRequest | undefined;
  strictMultiline?: boolean | undefined;
}

export interface DevShellRunInput extends DevShellCommandInput {
  timeoutMs?: number | undefined;
}

export interface DevProcessStartInput extends DevShellCommandInput {}

export interface DevProcessWriteInput {
  processId: string;
  data: string;
}

export interface DevProcessWriteAndReadInput extends DevProcessWriteInput {
  cursor?: number | undefined;
  waitMs?: number | undefined;
  maxBytes?: number | undefined;
}

export interface DevProcessReadInput {
  processId: string;
  cursor?: number | undefined;
  waitMs?: number | undefined;
  maxBytes?: number | undefined;
}

export interface DevProcessStopInput {
  processId: string;
  signal?: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGKILL" | undefined;
  waitMs?: number | undefined;
  cursor?: number | undefined;
  maxBytes?: number | undefined;
}

export interface DevShellRunResult {
  status: DevShellProcessStatus;
  stdout: string;
  stderr?: string | undefined;
  text: string;
  truncated: boolean;
  command?: string | undefined;
  cwd?: string | undefined;
  workspaceRoot?: string | undefined;
  submittedAt?: string | undefined;
  startedAt?: string | undefined;
  updatedAt?: string | undefined;
  completedAt?: string | undefined;
  exitCode?: number | undefined;
  securityMode?: string | undefined;
  failureReason?: string | undefined;
  failurePhase?: "command" | undefined;
  commandKind?: "single_line" | "multi_line" | undefined;
  strictModeApplied?: boolean | undefined;
  strictModeReason?: string | undefined;
  preflight?: DevShellPreflightResult | undefined;
  sourceWriteGuard?: DevShellSourceWriteGuardResult | undefined;
  unauthorizedSourceWrites?: DevShellUnauthorizedSourceWrite[] | undefined;
}

export interface DevProcessStartResult {
  processId?: string | undefined;
  status: DevShellProcessStatus;
  text: string;
  truncated: boolean;
  cursor: number;
  nextCursor: number;
  command?: string | undefined;
  cwd?: string | undefined;
  workspaceRoot?: string | undefined;
  submittedAt?: string | undefined;
  startedAt?: string | undefined;
  updatedAt?: string | undefined;
  completedAt?: string | undefined;
  exitCode?: number | undefined;
  securityMode?: string | undefined;
  failureReason?: string | undefined;
  failurePhase?: "command" | undefined;
  commandKind?: "single_line" | "multi_line" | undefined;
  strictModeApplied?: boolean | undefined;
  strictModeReason?: string | undefined;
  preflight?: DevShellPreflightResult | undefined;
  sourceWriteGuard?: DevShellSourceWriteGuardResult | undefined;
  unauthorizedSourceWrites?: DevShellUnauthorizedSourceWrite[] | undefined;
}

export interface DevProcessWriteResult {
  processId: string;
  status: "ACCEPTED" | "FAILED";
  bytesWritten: number;
  message?: string | undefined;
}

export interface DevProcessReadResult {
  processId?: string | undefined;
  status: DevShellProcessStatus;
  text: string;
  truncated: boolean;
  cursor: number;
  nextCursor: number;
  command?: string | undefined;
  cwd?: string | undefined;
  workspaceRoot?: string | undefined;
  submittedAt?: string | undefined;
  startedAt?: string | undefined;
  updatedAt?: string | undefined;
  completedAt?: string | undefined;
  exitCode?: number | undefined;
  securityMode?: string | undefined;
  failureReason?: string | undefined;
  failurePhase?: "command" | undefined;
  commandKind?: "single_line" | "multi_line" | undefined;
  strictModeApplied?: boolean | undefined;
  strictModeReason?: string | undefined;
  preflight?: DevShellPreflightResult | undefined;
  sourceWriteGuard?: DevShellSourceWriteGuardResult | undefined;
  unauthorizedSourceWrites?: DevShellUnauthorizedSourceWrite[] | undefined;
}

export interface DevProcessWriteAndReadResult extends DevProcessReadResult {
  bytesWritten: number;
}

export type DevProcessStopResult = DevProcessReadResult;

export interface DevShellPackageManagerPreflightConfig {
  pnpmApproveBuilds?: "approve_all" | "disabled" | undefined;
}

export interface DevShellPreflightResult {
  pnpmBuildApproval?: DevShellPnpmBuildApprovalPreflight | undefined;
}

export type DevShellPnpmBuildApprovalPreflightStatus =
  | "skipped"
  | "applied"
  | "already_applied"
  | "failed";

export interface DevShellPnpmBuildApprovalPreflight {
  status: DevShellPnpmBuildApprovalPreflightStatus;
  reason?: string | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  packageJsonPath?: string | undefined;
  packageManager?: string | undefined;
  exitCode?: number | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
  timedOut?: boolean | undefined;
}

export type DevShellSourceWriteMode = "source_readonly" | "approved_source_write" | "checkpoint_worktree";

export interface DevShellSourceWriteApprovalGrant {
  grantId: string;
  command: string;
  cwd?: string | undefined;
  writablePaths: string[];
  expiresAt?: string | undefined;
}

export interface DevShellSourceWriteGuardProfile {
  enabled?: boolean | undefined;
  managedWorktree?: boolean | undefined;
  sourceRoots?: string[] | undefined;
  allowedWriteRoots?: string[] | undefined;
  approvalGrants?: DevShellSourceWriteApprovalGrant[] | undefined;
}

export interface DevShellSourceWriteGuardRequest {
  enabled: boolean;
  managedWorktree?: boolean | undefined;
  sourceRoots?: string[] | undefined;
  allowedWriteRoots?: string[] | undefined;
  approvalGrants?: DevShellSourceWriteApprovalGrant[] | undefined;
}

export interface DevShellUnauthorizedSourceWrite {
  path: string;
  kind: "created" | "modified" | "deleted" | "type_changed";
  restored: boolean;
}

export interface DevShellSourceWriteGuardResult {
  enabled: boolean;
  mode: DevShellSourceWriteMode;
  approvedGrantId?: string | undefined;
  allowedWriteRoots: string[];
  sourceRoots: string[];
  unauthorizedSourceWrites: DevShellUnauthorizedSourceWrite[];
  restored: boolean;
  finalCheckCompleted?: boolean | undefined;
  changedFiles?: string[] | undefined;
  preActionCheckpointId?: string | undefined;
  postActionCheckpointId?: string | undefined;
}

export type DevShellOutputChannel = "stdout" | "stderr" | "merged";

export interface DevShellOutputChunk {
  channel: DevShellOutputChannel;
  text: string;
  byteLength: number;
  cursor: number;
  nextCursor: number;
  processId?: string | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  truncated?: boolean | undefined;
}

export type DevShellOutputObserver = (chunk: DevShellOutputChunk) => void | Promise<void>;

export interface DevShellCommandOptions {
  outputObserver?: DevShellOutputObserver | undefined;
}

export interface DevShellProcessStore {
  upsertProcess(record: DevShellProcessRecord): Promise<void>;
  getProcess(processId: string): Promise<DevShellProcessRecord | null>;
  listProcesses(input?: {
    status?: DevShellProcessStatus[] | undefined;
  }): Promise<DevShellProcessRecord[]>;
}

export interface DevShellServicePort {
  runCommand(input: DevShellRunInput, options?: DevShellCommandOptions): Promise<DevShellRunResult>;
  startProcess(input: DevProcessStartInput, options?: DevShellCommandOptions): Promise<DevProcessStartResult>;
  writeProcess(input: DevProcessWriteInput): Promise<DevProcessWriteResult>;
  writeAndReadProcess(input: DevProcessWriteAndReadInput, options?: DevShellCommandOptions): Promise<DevProcessWriteAndReadResult>;
  readProcess(input: DevProcessReadInput, options?: DevShellCommandOptions): Promise<DevProcessReadResult>;
  stopProcess(input: DevProcessStopInput, options?: DevShellCommandOptions): Promise<DevProcessStopResult>;
}
