import type {
  CodeExecutionServicePort,
  CodeModeProfileConfig,
  SandboxCapabilityRuntimeContext,
} from "../src/code/contracts.js";
import type {
  DevShellProfileConfig,
  DevShellServicePort,
} from "../src/devshell/contracts.js";
import type { DesktopHostOpenServicePort } from "../src/desktopShell/hostOpen.js";
import type {
  AgentToolResult,
  AgentToolPresentation,
  ModelToolContract,
  ModelToolSpec,
  ToolConsoleSink,
  ToolGateway,
  ToolRunContext,
  ToolRuntimeStatus,
} from "../src/kestrel/contracts/model-io.js";
import type { SubAgentResultEnvelope } from "../src/kestrel/contracts/orchestration.js";
import type { SessionStore } from "../src/kestrel/contracts/store.js";
import type {
  ApprovalCapabilityClass,
  InteractionMode,
  ToolApprovalDispositionV1,
  ToolApprovalPolicyEvidenceV1,
  ToolExecutionClass,
} from "../src/mode/contracts.js";
import type {
  ToolDescriptorRefV1,
  ToolDescriptorV1,
} from "../src/kestrel/contracts/tool-contract.js";
import type { MissionControlProjectStateRecord } from "../src/missionControl/projectAuthority.js";
import type { ManagedTaskWorktreeService } from "../src/workspace/ManagedTaskWorktreeService.js";
import type { TavilyInternetProvider } from "./internet/contracts.js";
import type { ToolProviderConfigurationResolver } from "./providers/runtimeConfiguration.js";
import type { Microsoft365ServicePort } from "../src/apps/microsoft365.js";
import type { GoogleWorkspaceServicePort } from "../src/apps/googleWorkspace.js";
import type { BrowserServicePort } from "../src/browser/contracts.js";

export type ToolFreshnessClass = "live" | "volatile" | "static" | "runtime";
export type ToolLatencyClass = "low" | "medium" | "high";
export type ToolCostClass = "free" | "metered" | "premium";
export type ToolGranularity = "hourly" | "daily" | "mixed";

export interface ToolCapabilitySuitability {
  forecastHorizonDays?: number | undefined;
  granularity?: ToolGranularity | undefined;
  supportsAttribution?: boolean | undefined;
  supportsAggregation?: boolean | undefined;
  typicalFailureModes?: string[] | undefined;
}

export interface ToolPresentationMetadata {
  displayName: string;
  aliases: string[];
  keywords: string[];
  provider: string;
  toolFamily: string;
}

export interface ToolCapabilityMetadata {
  freshnessClass: ToolFreshnessClass;
  latencyClass: ToolLatencyClass;
  costClass: ToolCostClass;
  executionClass: ToolExecutionClass;
  allowedInteractionModes?: InteractionMode[] | undefined;
  capabilityClasses: string[];
  approvalCapabilities?: ApprovalCapabilityClass[] | undefined;
  minimumApprovalMode?: "auto" | "ask" | undefined;
  /** Effective runtime prompt policy after hosted policy resolution. */
  approvalDisposition?: ToolApprovalDispositionV1 | undefined;
  /** Trusted runtime authority. This field must never be rendered to the model. */
  approvalAuthority?:
    | {
        kind: "runtime_policy" | "hosted_mcp_grant" | "hosted_app_policy";
        revision: string;
      }
    | undefined;
  /** Exact immutable descriptor used by runtime approval and execution checks. */
  descriptorRef?: ToolDescriptorRefV1 | undefined;
  requires?: string[] | undefined;
  suitability?: ToolCapabilitySuitability | undefined;
}

export interface SharedToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  runtimeOutputSchema?: Record<string, unknown> | undefined;
  outputContract?: ModelToolContract | undefined;
  resultNormalizerId?: string | undefined;
  capability: ToolCapabilityMetadata;
  presentation: ToolPresentationMetadata;
}

export interface FileSystemToolPolicyConfig {
  workspaceRoot: string;
  tempRoots: string[];
  readOnlyRoots?: string[] | undefined;
}

export interface DelegationTaskSpawnRequest {
  parentSessionId: string;
  parentRunId?: string | undefined;
  parentStepIndex?: number | undefined;
  taskId?: string | undefined;
  parentTaskId?: string | undefined;
  delegationDepth?: number | undefined;
  rootDelegationId?: string | undefined;
  title: string;
  prompt: string;
  profileId?: string | undefined;
  provider?:
    | "openrouter"
    | "openai"
    | "anthropic"
    | "ollama"
    | "lmstudio"
    | undefined;
  model?: string | undefined;
  resultContract?: string | undefined;
  launchedBy?: "operator" | "agent" | undefined;
}

export interface RuntimeToolRunContext {
  runId: string;
  sessionId: string;
  /** Exact prepared call identity supplied by the trusted tool gateway. */
  toolCallId?: string | undefined;
  projectId?: string | undefined;
  approvalId?: string | undefined;
  threadId?: string | undefined;
  activeTaskId?: string | undefined;
  delegationId?: string | undefined;
  delegationDepth?: number | undefined;
  rootDelegationId?: string | undefined;
}

export interface DelegationTaskSnapshot {
  taskId: string;
  parentSessionId: string;
  parentRunId?: string | undefined;
  sourceTaskId?: string | undefined;
  parentTaskId?: string | undefined;
  delegationDepth?: number | undefined;
  rootDelegationId?: string | undefined;
  title: string;
  status: "PENDING" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
  childSessionId: string;
  childSessionName: string;
  profileId: string;
  provider: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio";
  model: string;
  waitEventType?: string | undefined;
  result?: SubAgentResultEnvelope | undefined;
  resultSummary?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  references?: string[] | undefined;
  launchedBy?: "operator" | "agent" | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface DelegationTaskResult {
  task: DelegationTaskSnapshot;
  finalizedPayload?: unknown | undefined;
}

export interface DelegationServicePort {
  spawnTask(input: DelegationTaskSpawnRequest): Promise<DelegationTaskSnapshot>;
  listTasks(parentSessionId: string): Promise<DelegationTaskSnapshot[]>;
  getTaskResult(taskId: string): Promise<DelegationTaskResult | null>;
}

export interface DialogSnapshot {
  dialogId: string;
  name: string;
  parentSessionId: string;
  childSessionId: string;
  status: "open" | "closed";
  activity: "idle" | "working" | "waiting" | "interrupted";
  active: boolean;
  cursor?: string | undefined;
  errorMessage?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface DialogOpenResult extends DialogSnapshot {
  /** True only when this call created the collaborator. */
  created: boolean;
}

export interface DialogReadResult extends DialogSnapshot {
  messages: Array<{
    messageId: string;
    sender: "kestrel" | "collaborator" | "system";
    text: string;
    createdAt: string;
    status?: "failed" | "cancelled" | undefined;
  }>;
  nextCursor?: string | undefined;
  previousCursor?: string | undefined;
  hasEarlier: boolean;
  hasMore: boolean;
}

export interface DialogListResult {
  dialogs: DialogSnapshot[];
  nextCursor?: string | undefined;
  hasMore: boolean;
}

export interface DialogServicePort {
  open(input: {
    parentSessionId: string;
    parentRunId?: string | undefined;
    name: string;
    message: string;
  }): Promise<DialogOpenResult>;
  send(input: {
    parentSessionId: string;
    parentRunId?: string | undefined;
    dialogId: string;
    message: string;
  }): Promise<DialogSnapshot>;
  read(input: {
    parentSessionId: string;
    dialogId: string;
    afterCursor?: string | undefined;
    beforeCursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<DialogReadResult>;
  list(input: {
    parentSessionId: string;
    status?: "open" | "closed" | "all" | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<DialogListResult>;
  close(input: {
    parentSessionId: string;
    parentRunId?: string | undefined;
    dialogId: string;
  }): Promise<DialogSnapshot>;
}

export interface SharedToolContext {
  signal?: AbortSignal | undefined;
  store?: SessionStore | undefined;
  onFinalize?: ((payload: unknown) => unknown | Promise<unknown>) | undefined;
  fetchImpl?: typeof fetch | undefined;
  internetProvider?: TavilyInternetProvider | undefined;
  providerConfigurations?: ToolProviderConfigurationResolver | undefined;
  microsoft365Service?: Microsoft365ServicePort | undefined;
  googleWorkspaceService?: GoogleWorkspaceServicePort | undefined;
  browserService?: BrowserServicePort | undefined;
  /** @deprecated Transitional compatibility for callers not yet using providerConfigurations. */
  internetEnv?: NodeJS.ProcessEnv | undefined;
  strictFinalizeProvenance?: boolean | undefined;
  codeMode?: CodeModeProfileConfig | undefined;
  codeExecutionService?: CodeExecutionServicePort | undefined;
  /** Gateway-owned raw-output sink; capability tools invoke it before teardown. */
  persistCompletedCapabilityResult?: ((rawOutput: unknown) => Promise<void>) | undefined;
  sandboxCapabilityRuntime?: (
    Omit<SandboxCapabilityRuntimeContext, "sessionId" | "runId" | "toolCallId" | "policy" | "approval" | "parentAuthorization"> & {
      /** Set only by the trusted prepared-call path in UnifiedToolRegistry. */
      preparedPolicy?: import("../src/kestrel/contracts/tool-invocation.js").PreparedToolPolicyDispositionV1 | undefined;
      preparedApproval?: import("../src/kestrel/contracts/tool-invocation.js").PreparedToolApprovalAuthorityV1 | undefined;
    }
  ) | undefined;
  devShell?: DevShellProfileConfig | undefined;
  devShellService?: DevShellServicePort | undefined;
  desktopHostOpenService?: DesktopHostOpenServicePort | undefined;
  interactionMode?: "chat" | "plan" | "build" | undefined;
  delegationService?: DelegationServicePort | undefined;
  dialogService?: DialogServicePort | undefined;
  runtime?: RuntimeToolRunContext | undefined;
  workspace?:
    | {
        appRoot?: string | undefined;
        packageManager?: string | undefined;
        commands?: Record<string, string | undefined> | undefined;
      }
    | undefined;
  managedTaskWorktreeService?: ManagedTaskWorktreeService | undefined;
  missionControlActions?:
    | {
        propose(input: {
          projectId: string;
          title: string;
          instructions: string;
          order?: number | undefined;
        }): Promise<MissionControlProjectStateRecord>;
      }
    | undefined;
  toolConsole?: ToolConsoleSink | undefined;
  fileSystem?: FileSystemToolPolicyConfig | undefined;
  kestrelOne?:
    | {
        appUrl?: string | undefined;
        toolToken?: string | undefined;
        tenantId?: string | undefined;
        contextGrantId?: string | undefined;
        executionTicket?: string | undefined;
        appRelayUrl?: string | undefined;
        appRelayToken?: string | undefined;
        executionRunId?: string | undefined;
        workspaceRuntimeUrl?: string | undefined;
        appApprovalModes?: Record<string, "auto" | "ask"> | undefined;
        appApprovalPolicies?:
          | Record<string, ToolApprovalPolicyEvidenceV1>
          | undefined;
        rememberedToolApprovalEvidence?:
          | import("@kestrel-agents/protocol").RememberedToolApprovalEvidenceV1[]
          | undefined;
      }
    | undefined;
}

export type SharedToolRawHandler = (input: unknown) => Promise<unknown>;
export type SharedToolHandler = (input: unknown) => Promise<AgentToolResult>;

export interface SharedToolModule {
  definition: SharedToolDefinition;
  createHandler(
    context: SharedToolContext,
    prepared?: import("../src/kestrel/contracts/tool-invocation.js").PreparedToolCallV1 | undefined,
  ): SharedToolRawHandler;
  resolveExecutionClass?(input: Record<string, unknown>): ToolExecutionClass;
  prepareInputAdapter?(input: Record<string, unknown>): import("../src/kestrel/contracts/tool-invocation.js").PreparedToolInputAdapterV1;
  normalizeResult?(output: unknown, input: unknown): SharedToolNormalizedResult;
}

export interface SharedToolNormalizedResult {
  output: unknown;
  presentation?: AgentToolPresentation | undefined;
  partial?:
    | {
        normalizedFailureCode: string;
        retryable: boolean;
      }
    | undefined;
}

export interface ToolCatalog {
  list(): SharedToolDefinition[];
  listDescriptors(): ToolDescriptorV1[];
  getDescriptor(name: string): ToolDescriptorV1 | undefined;
  getDescriptorRef(name: string): ToolDescriptorRefV1 | undefined;
  toModelTools(names: string[]): ModelToolSpec[];
  toCapabilityManifest(names: string[]): Array<
    ToolCapabilityMetadata & {
      name: string;
      description: string;
      displayName: string;
      aliases: string[];
      keywords: string[];
      provider: string;
      toolFamily: string;
    }
  >;
  createHandlers(
    names: string[],
    context: SharedToolContext,
  ): Record<string, SharedToolHandler>;
  createRawHandlers(
    names: string[],
    context: SharedToolContext,
    prepared?: import("../src/kestrel/contracts/tool-invocation.js").PreparedToolCallV1 | undefined,
  ): Record<string, SharedToolRawHandler>;
  createResultNormalizers(
    names: string[],
  ): Record<
    string,
    (output: unknown, input: unknown) => SharedToolNormalizedResult
  >;
  resolveExecutionClass(name: string, input: Record<string, unknown>): ToolExecutionClass | undefined;
  prepareInputAdapter(name: string, input: Record<string, unknown>): import("../src/kestrel/contracts/tool-invocation.js").PreparedToolInputAdapterV1 | undefined;
}

export interface ToolRegistryListOptions {
  runContext?: ToolRunContext | undefined;
}

export interface ToolRegistry extends ToolGateway {
  releasePreparedToolCall(
    prepared: import("../src/kestrel/contracts/tool-invocation.js").PreparedToolCallV1,
  ): Promise<void>;
  getDescriptor(
    name: string,
    options?: ToolRegistryListOptions,
  ): ToolDescriptorV1 | undefined;
  getModelTools(options?: ToolRegistryListOptions): ModelToolSpec[];
  getCapabilityManifest(options?: ToolRegistryListOptions): Array<
    ToolCapabilityMetadata & {
      name: string;
      description: string;
      displayName: string;
      aliases: string[];
      keywords: string[];
      provider: string;
      toolFamily: string;
    }
  >;
  getRuntimeStatus?(): Promise<ToolRuntimeStatus>;
  refreshRuntime?(): Promise<ToolRuntimeStatus>;
  ensureReadyForRun(): Promise<void>;
  resolveAvailableAllowlist(names: string[]): string[];
}
