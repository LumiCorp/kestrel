import type { AgentToolResult, ModelToolContract, ModelToolSpec, ToolConsoleSink, ToolGateway, ToolGatewayCallOptions, ToolRunContext, ToolRuntimeStatus } from "../src/kestrel/contracts/model-io.js";
import type { SubAgentResultEnvelope } from "../src/kestrel/contracts/orchestration.js";
import type { SessionStore } from "../src/kestrel/contracts/store.js";

import type {
  ProductProjectAction,
  ProductProjectSnapshot,
} from "../src/project/contracts.js";
import type {
  CodeExecutionServicePort,
  CodeModeProfileConfig,
} from "../src/code/contracts.js";
import type {
  DevShellProfileConfig,
  DevShellServicePort,
} from "../src/devshell/contracts.js";
import type {
  ApprovalCapabilityClass,
  ToolExecutionClass,
} from "../src/mode/contracts.js";
import type { TavilyInternetProvider } from "./internet/contracts.js";
import type { ManagedTaskWorktreeService } from "../src/workspace/ManagedTaskWorktreeService.js";

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
  capabilityClasses: string[];
  approvalCapabilities?: ApprovalCapabilityClass[] | undefined;
  requires?: string[] | undefined;
  suitability?: ToolCapabilitySuitability | undefined;
}

export interface SharedToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputContract?: ModelToolContract | undefined;
  capability: ToolCapabilityMetadata;
  presentation: ToolPresentationMetadata;
}

export interface FileSystemToolPolicyConfig {
  workspaceRoot: string;
  tempRoots: string[];
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
  provider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
  model?: string | undefined;
  skillPackId?: string | undefined;
  resultContract?: string | undefined;
  launchedBy?: "operator" | "agent" | undefined;
}

export interface RuntimeToolRunContext {
  runId: string;
  sessionId: string;
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
  skillPackId?: string | undefined;
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

export interface SharedToolContext {
  store?: SessionStore | undefined;
  onFinalize?: ((payload: unknown) => unknown | Promise<unknown>) | undefined;
  fetchImpl?: typeof fetch | undefined;
  internetProvider?: TavilyInternetProvider | undefined;
  internetEnv?: NodeJS.ProcessEnv | undefined;
  strictFinalizeProvenance?: boolean | undefined;
  codeMode?: CodeModeProfileConfig | undefined;
  codeExecutionService?: CodeExecutionServicePort | undefined;
  devShell?: DevShellProfileConfig | undefined;
  devShellService?: DevShellServicePort | undefined;
  interactionMode?: "chat" | "plan" | "build" | undefined;
  delegationService?: DelegationServicePort | undefined;
  runtime?: RuntimeToolRunContext | undefined;
  workspace?: {
    appRoot?: string | undefined;
    packageManager?: string | undefined;
    commands?: Record<string, string | undefined> | undefined;
  } | undefined;
  managedTaskWorktreeService?: ManagedTaskWorktreeService | undefined;
  projectActions?: {
    apply(action: ProductProjectAction): Promise<{
      sessionId: string;
      snapshot: ProductProjectSnapshot;
    }>;
  } | undefined;
  toolConsole?: ToolConsoleSink | undefined;
  fileSystem?: FileSystemToolPolicyConfig | undefined;
  kestrelOne?: {
    appUrl?: string | undefined;
    toolToken?: string | undefined;
    tenantId?: string | undefined;
    contextGrantId?: string | undefined;
    executionTicket?: string | undefined;
  } | undefined;
}

export type SharedToolRawHandler = (input: unknown) => Promise<unknown>;
export type SharedToolHandler = (input: unknown) => Promise<AgentToolResult>;

export interface SharedToolModule {
  definition: SharedToolDefinition;
  createHandler(context: SharedToolContext): SharedToolRawHandler;
}

export interface ToolCatalog {
  list(): SharedToolDefinition[];
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
  createHandlers(names: string[], context: SharedToolContext): Record<string, SharedToolHandler>;
}

export interface ToolRegistryListOptions {
  runContext?: ToolRunContext | undefined;
}

export interface ToolRegistry extends ToolGateway {
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
  validateInput?(name: string, input: unknown, options?: ToolGatewayCallOptions): Promise<unknown>;
  getRuntimeStatus?(): Promise<ToolRuntimeStatus>;
  refreshRuntime?(): Promise<ToolRuntimeStatus>;
  ensureReadyForRun(): Promise<void>;
  resolveAvailableAllowlist(names: string[]): string[];
}
