import type { ErrorObject, ValidateFunction } from "ajv";
import path from "node:path";
import { validateWorkspaceSkillPackage } from "@kestrel-agents/workspace-skills";

import type {
  ModelToolSpec,
  AgentToolResult,
  ToolGateway,
  ToolGatewayCallOptions,
  ToolGatewayPreRunContext,
  ToolRunContext,
  ToolRuntimeStatus,
} from "../../src/kestrel/contracts/model-io.js";
import type {
  McpServerConfig,
  McpStatusSnapshot,
} from "../../src/mcp/contracts.js";
import { compileMcpStatusSnapshotV1 } from "../../src/mcp/toolDescriptor.js";
import {
  compileToolJsonSchemaV1,
  hashCanonical,
  toToolDescriptorRefV1,
  type ToolSurfaceSnapshotV1,
  type ToolDescriptorV1,
} from "../../src/kestrel/contracts/tool-contract.js";
import {
  parseDurablePreparedInvocationId,
  type AgentToolResultV2,
  type PreparedToolCallV1,
  type ResolvedModelToolIntentV1,
} from "../../src/kestrel/contracts/tool-invocation.js";
import {
  createPreparedToolCallV1,
  createPreparedToolApprovalAuthorityV2,
  createStableToolApprovalIdentityV1,
  createToolSurfaceForDescriptorsV1,
  executePinnedToolCallV1,
  fingerprintToolRunScopeV1,
  resolveModelToolIntentV1,
  readHostedStableApprovalContext,
  RUNTIME_DEADLINE_BUDGET_ADAPTER_ID,
  type PinnedToolExecutionV1,
} from "../../src/io/ToolInvocationSupport.js";
import {
  parseHostedExecutionAuthorization,
  parseHostedMcpContext,
  parseHostedMcpRuntimeConnection,
} from "../../src/mcp/hosted-contracts.js";
import {
  McpClientManager,
  type McpOAuthProviderFactory,
  type PinnedMcpToolHandle,
} from "../../src/mcp/McpClientManager.js";
import {
  createRuntimeFailure,
  RuntimeFailure,
} from "../../src/runtime/RuntimeFailure.js";
import { ExecutionAuthorizationProvider } from "../../src/runtime/ExecutionAuthorizationProvider.js";
import { defaultToolCatalog } from "../catalog.js";
import { createBuiltInToolDescriptor } from "../catalog.js";
import { codeExecuteDefinitionForProfile } from "../code/execute.js";
import type {
  RuntimeToolRunContext,
  SharedToolContext,
  ToolCapabilityMetadata,
  ToolRegistry,
  ToolRegistryListOptions,
} from "../contracts.js";
import { withDefaultFileSystemPolicy } from "../filesystem/shared.js";
import { createToolInputError } from "../helpers.js";
import {
  buildAgentToolFailureResult,
  buildAgentToolSuccessResult,
  isAgentToolResult,
  replaceAgentToolResultOutput,
} from "../toolResult.js";
import { validateBuiltInToolInputContract } from "./builtInToolInputContracts.js";
import { normalizeToolActionInput } from "./normalizeToolInput.js";
import type { SensitiveValueRegistry } from "../../src/security/ExecutionBoundaryPolicy.js";
import { applyExternalDeadlineToolBudget } from "../../src/engine/ExecutionEngineSupport.js";
import {
  applyRememberedThreadApprovalV1,
  resolveToolApprovalDispositionV1,
  type ToolApprovalDispositionV1,
} from "../../src/mode/contracts.js";
import { isFileTextReadToolName } from "../../src/runtime/fileTextReadTools.js";
import { withPreparedExecCommandApprovalContext } from "./approvedExecCommandContext.js";
import type { RunnerWorkflowRunAuthorityV1 } from "@kestrel-agents/protocol";
import {
  BROWSER_SERVICE_PORT_VERSION,
  isBrowserToolName,
  isConformingBrowserServicePort,
} from "../../src/browser/contracts.js";

type CapabilityManifestItem = ToolCapabilityMetadata & {
  name: string;
  description: string;
  displayName: string;
  aliases: string[];
  keywords: string[];
  provider: string;
  toolFamily: string;
};

export interface UnifiedToolRegistryOptions {
  allowlist: string[];
  context?: SharedToolContext | undefined;
  mcpServers?: McpServerConfig[] | undefined;
  mcpManager?: McpToolProvider | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  fetchImpl?: typeof fetch | undefined;
  mcpOAuthProviderFactory?: McpOAuthProviderFactory | undefined;
  sensitiveValueRegistry?: SensitiveValueRegistry | undefined;
}

export interface McpToolProvider {
  refresh(): Promise<McpStatusSnapshot>;
  assertHealthy(): Promise<void>;
  callTool<T>(namespacedToolName: string, input: unknown): Promise<T>;
  pinTool?(namespacedToolName: string): PinnedMcpToolHandle;
  close(): Promise<void>;
}

export interface HostedMcpRuntimeTurnInput {
  runId?: string | undefined;
  sessionId?: string | undefined;
  mcpContext?: unknown;
  mcpAuthorization?: unknown;
}

type HostedMcpScope = {
  manager: McpClientManager;
  snapshot: McpStatusSnapshot;
  executionTicket: string;
  lastUsedAt: number;
  runId: string;
};

type PinnedExecutionSource = {
  pinned: Omit<PinnedToolExecutionV1, "handler">;
  createHandler: (
    options: ToolGatewayCallOptions,
    prepared?: PreparedToolCallV1 | undefined,
  ) => (input: unknown) => Promise<unknown>;
  retain?: (() => void) | undefined;
  release?: (() => Promise<void> | void) | undefined;
  transformInput?:
    | ((input: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>)
    | undefined;
  inputAdapterId?: string | undefined;
  resolveExecutionClass?: ((input: Record<string, unknown>) => import("../../src/mode/contracts.js").ToolExecutionClass) | undefined;
  prepareInputAdapter?: ((input: Record<string, unknown>) => import("../../src/kestrel/contracts/tool-invocation.js").PreparedToolInputAdapterV1) | undefined;
};

interface WorkspaceSkillReadProgress {
  revision: string;
  nextOffsetBytes: number;
}

const MODEL_VISIBLE_RUNTIME_TOOL_NAMES = new Set([
  "dialog.open",
  "dialog.send",
  "dialog.read",
  "dialog.list",
  "dialog.close",
]);
export class UnifiedToolRegistry implements ToolGateway, ToolRegistry {
  private readonly builtInToolSpecs: Map<string, ModelToolSpec>;
  private readonly builtInCapabilities: Map<string, CapabilityManifestItem>;
  private readonly builtInDescriptors: Map<string, ToolDescriptorV1>;
  private readonly builtInContext: SharedToolContext;
  private readonly mcpManager: McpToolProvider;
  private readonly hostedMcpScopes = new Map<string, HostedMcpScope>();
  private readonly retiredHostedMcpManagers = new Set<McpClientManager>();
  // AUTHORIZATION INVARIANT: the hosted Environment stores the ticket under
  // its requested execution run ID, but ExecutionEngine may create a different
  // internal run ID for tool calls. Do not assume those IDs are equal or
  // replace the session index with a single run-ID lookup.
  private readonly executionTicketsByRun = new Map<string, string>();
  private readonly authorizationProvidersByRun = new Map<
    string,
    ExecutionAuthorizationProvider
  >();
  private readonly authorizationProvidersBySession = new Map<
    string,
    Map<string, ExecutionAuthorizationProvider>
  >();
  private readonly releaseExecutionTicketRegistrationByRun = new Map<
    string,
    () => void
  >();
  private readonly workspaceSkillReadProgress = new Map<
    string,
    WorkspaceSkillReadProgress
  >();
  private readonly executionTicketsBySession = new Map<
    string,
    Map<string, string>
  >();
  private readonly toolSurfaceSnapshots = new Map<
    string,
    ToolSurfaceSnapshotV1
  >();
  private readonly toolSurfaceRunIds = new Map<
    string,
    {
      runId: string;
      sessionId: string;
    }
  >();
  private readonly toolSurfaceExecutions = new Map<
    string,
    Map<string, PinnedExecutionSource>
  >();
  private readonly preparedExecutions = new Map<
    string,
    PinnedExecutionSource
  >();
  private readonly terminalPreparedExecutionKeysByOwner = new Map<
    string,
    Set<string>
  >();
  private readonly preparedExecutionOwnersBySession = new Map<
    string,
    Set<string>
  >();
  private readonly releasedPreparedExecutionSessions = new Set<string>();
  private readonly executingPreparedExecutionKeys = new Set<string>();
  private readonly activePreparedExecutionCompletions = new Map<
    string,
    Promise<void>
  >();
  private readonly releasingPreparedExecutions = new Map<
    string,
    Promise<void>
  >();
  private readonly releasingToolSurfaceSnapshots = new Map<
    string,
    Promise<void>
  >();
  private readonly activeToolSurfaceSnapshotCreations = new Set<
    Promise<void>
  >();
  private closed = false;
  private closeComplete = false;
  private closeAttempt: Promise<void> | undefined;
  private defaultMcpManagerClosed = false;
  private registryGenerationSequence = 0;
  private registryGeneration = "tool-registry:uninitialized";

  private defaultAllowlist: Set<string>;
  private mcpStatus: McpStatusSnapshot = {
    healthy: true,
    checkedAt: new Date(0).toISOString(),
    servers: [],
    tools: [],
  };
  private initialized = false;
  private readonly sensitiveValueRegistry: SensitiveValueRegistry | undefined;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: UnifiedToolRegistryOptions) {
    this.defaultAllowlist = new Set(options.allowlist);
    this.builtInContext = withDefaultFileSystemPolicy(options.context);
    this.sensitiveValueRegistry = options.sensitiveValueRegistry;
    this.fetchImpl = options.fetchImpl;

    const builtInNames = defaultToolCatalog.list().map((tool) => tool.name);
    this.builtInDescriptors = new Map(
      defaultToolCatalog
        .listDescriptors()
        .map((descriptor) => [descriptor.toolId, descriptor] as const),
    );
    this.builtInToolSpecs = new Map(
      defaultToolCatalog
        .toModelTools(builtInNames)
        .map((tool) => [tool.name, tool] as const),
    );
    const codeExecuteDefinition = codeExecuteDefinitionForProfile(
      this.builtInContext.codeMode,
    );
    this.builtInDescriptors.set(
      "code.execute",
      createBuiltInToolDescriptor(codeExecuteDefinition),
    );
    this.builtInToolSpecs.set("code.execute", {
      name: codeExecuteDefinition.name,
      description: codeExecuteDefinition.description,
      inputSchema: codeExecuteDefinition.inputSchema,
    });

    this.builtInCapabilities = new Map(
      defaultToolCatalog
        .toCapabilityManifest(builtInNames)
        .map((capability) => [capability.name, capability] as const),
    );

    if (options.mcpManager !== undefined) {
      this.mcpManager = options.mcpManager;
    } else {
      this.mcpManager = new McpClientManager({
        servers: options.mcpServers ?? [],
        env: options.env,
        fetchImpl: options.fetchImpl,
        oauthProviderFactory: options.mcpOAuthProviderFactory,
      });
    }
    this.activateRegistryGeneration();
  }

  bindOrchestrationServices(
    services: Pick<SharedToolContext, "delegationService" | "dialogService">,
  ): void {
    if (services.delegationService !== undefined) {
      this.builtInContext.delegationService = services.delegationService;
    }
    if (services.dialogService !== undefined) {
      this.builtInContext.dialogService = services.dialogService;
    }
  }

  updateAllowlist(names: string[]): void {
    this.defaultAllowlist = new Set(names);
  }

  async refresh(): Promise<McpStatusSnapshot> {
    const nextStatus = compileMcpStatusSnapshotV1(
      await this.mcpManager.refresh(),
    );
    const retainedActiveGeneration =
      this.initialized && nextStatus.refreshDiagnostic !== undefined;
    this.mcpStatus = nextStatus;
    this.initialized = true;
    if (!retainedActiveGeneration) this.activateRegistryGeneration();
    return this.getMcpStatus();
  }

  async refreshForRuntimeTurn(
    input: HostedMcpRuntimeTurnInput,
  ): Promise<ToolRuntimeStatus> {
    if (this.initialized === false) {
      await this.refresh();
    }
    if (input.mcpAuthorization !== undefined && input.runId !== undefined) {
      const authorization = parseHostedExecutionAuthorization(
        input.mcpAuthorization,
      );
      const executionTicket = authorization.executionTicket;
      this.authorizationProvidersByRun.get(input.runId)?.close();
      this.authorizationProvidersByRun.delete(input.runId);
      for (const [sessionId, providers] of this
        .authorizationProvidersBySession) {
        providers.delete(input.runId);
        if (providers.size === 0)
          this.authorizationProvidersBySession.delete(sessionId);
      }
      if (authorization.renewal !== undefined) {
        const provider = new ExecutionAuthorizationProvider({
          authorization,
          fetchImpl: this.fetchImpl,
          onRenew: async (ticket) => {
            this.registerSensitiveExecutionAuthorization(
              input.runId!,
              ticket,
              authorization.renewal!.token,
            );
            this.executionTicketsByRun.set(input.runId!, ticket);
            if (input.sessionId !== undefined) {
              this.executionTicketsBySession
                .get(input.sessionId)
                ?.set(input.runId!, ticket);
            }
            if (input.mcpContext !== undefined) {
              await this.replaceHostedMcpScope(
                parseHostedMcpContext(input.mcpContext),
                ticket,
                input.runId!,
              );
            }
          },
        });
        this.authorizationProvidersByRun.set(input.runId, provider);
        if (input.sessionId !== undefined) {
          const providers =
            this.authorizationProvidersBySession.get(input.sessionId) ??
            new Map();
          providers.set(input.runId, provider);
          this.authorizationProvidersBySession.set(input.sessionId, providers);
        }
      }
      this.registerSensitiveExecutionAuthorization(
        input.runId,
        executionTicket,
        authorization.renewal?.token,
      );
      this.executionTicketsByRun.set(input.runId, executionTicket);
      if (input.sessionId !== undefined) {
        // Preserve every requested-run ticket so the internal engine run can
        // use a session fallback only when that fallback is unambiguous.
        const tickets =
          this.executionTicketsBySession.get(input.sessionId) ?? new Map();
        tickets.set(input.runId, executionTicket);
        this.executionTicketsBySession.set(input.sessionId, tickets);
      }
    }
    if (input.mcpContext === undefined) {
      if (input.mcpAuthorization !== undefined && input.runId === undefined) {
        throw createRuntimeFailure(
          "RUNTIME_AUTHORIZATION_CONTEXT_INVALID",
          "runId is required when execution authorization is provided without mcpContext",
          { recoverable: false },
        );
      }
      return toToolRuntimeStatus(this.getMcpStatus(), this.builtInContext);
    }
    const context = parseHostedMcpContext(input.mcpContext);
    const grantId = context.grantId;
    const existing = this.hostedMcpScopes.get(grantId);
    if (existing && input.mcpAuthorization === undefined) {
      existing.lastUsedAt = Date.now();
      return toToolRuntimeStatus(
        combineMcpSnapshots(this.mcpStatus, existing.snapshot),
        this.builtInContext,
      );
    }
    const connection = parseHostedMcpRuntimeConnection({
      mcpContext: context,
      mcpAuthorization: input.mcpAuthorization,
    });
    if (existing?.executionTicket === connection.executionTicket) {
      existing.lastUsedAt = Date.now();
      return toToolRuntimeStatus(
        combineMcpSnapshots(this.mcpStatus, existing.snapshot),
        this.builtInContext,
      );
    }
    const manager = new McpClientManager({
      servers: [],
      hostedGateway: connection,
      fetchImpl: this.fetchImpl,
    });
    const snapshot = compileMcpStatusSnapshotV1(await manager.refresh());
    this.assertHostedToolNamesSafe(snapshot);
    this.hostedMcpScopes.set(grantId, {
      manager,
      snapshot,
      executionTicket: connection.executionTicket,
      lastUsedAt: Date.now(),
      runId: input.runId ?? context.threadId,
    });
    if (existing !== undefined) {
      this.retiredHostedMcpManagers.add(existing.manager);
      await existing.manager.retire();
    }
    await this.pruneHostedMcpScopes(grantId);
    return toToolRuntimeStatus(
      combineMcpSnapshots(this.mcpStatus, snapshot),
      this.builtInContext,
    );
  }

  clearRuntimeTurnAuthorization(runId: string, sessionId?: string): void {
    // Clear both indexes together. Leaving the session entry behind could
    // authorize a later internal engine run with a completed turn's ticket.
    this.executionTicketsByRun.delete(runId);
    this.authorizationProvidersByRun.get(runId)?.close();
    this.authorizationProvidersByRun.delete(runId);
    this.releaseExecutionTicketRegistrationByRun.get(runId)?.();
    this.releaseExecutionTicketRegistrationByRun.delete(runId);
    for (const key of this.workspaceSkillReadProgress.keys()) {
      if (key.startsWith(`${runId}\0`))
        this.workspaceSkillReadProgress.delete(key);
    }
    const sessionIds =
      sessionId === undefined
        ? [...this.executionTicketsBySession.keys()]
        : [sessionId];
    for (const id of sessionIds) {
      const tickets = this.executionTicketsBySession.get(id);
      const providers = this.authorizationProvidersBySession.get(id);
      tickets?.delete(runId);
      providers?.delete(runId);
      if (tickets?.size === 0) {
        this.executionTicketsBySession.delete(id);
      }
      if (providers?.size === 0) {
        this.authorizationProvidersBySession.delete(id);
      }
    }
  }

  resolveAvailableAllowlistForRuntimeTurn(
    names: string[],
    input: HostedMcpRuntimeTurnInput,
    options: { includeGrantedMcpTools: boolean },
  ): string[] {
    const snapshot = this.resolveMcpSnapshotFromTurnInput(input);
    const available = new Set(this.listAvailableToolNames(snapshot));
    const requested = options.includeGrantedMcpTools
      ? [...names, ...snapshot.tools.map((tool) => tool.namespacedToolName)]
      : names;
    return [...new Set(requested)].filter(
      (name) => available.has(name) || this.isRuntimeBuiltInToolName(name),
    );
  }

  async preRun(context: ToolGatewayPreRunContext): Promise<void> {
    if (this.initialized === false) {
      await this.refreshRuntime();
    }
    const payload = asRecord(context.event.payload);
    if (payload?.mcpContext !== undefined) {
      const turnInput = {
        mcpContext: payload.mcpContext,
      };
      await this.refreshForRuntimeTurn(turnInput);
      await this.resolveMcpManager({
        runId: context.runId,
        sessionId: context.session.sessionId,
        payload: context.event.payload,
        sessionState: context.session.state,
      }).assertHealthy();
    }
  }

  async getRuntimeStatus(): Promise<ToolRuntimeStatus> {
    if (this.initialized === false) {
      await this.refresh();
    }
    return toToolRuntimeStatus(this.getMcpStatus(), this.builtInContext);
  }

  async refreshRuntime(): Promise<ToolRuntimeStatus> {
    const status = await this.refresh();
    return toToolRuntimeStatus(status, this.builtInContext);
  }

  async ensureReadyForRun(): Promise<void> {
    if (this.initialized === false) {
      await this.refreshRuntime();
    }
    await this.mcpManager.assertHealthy();
  }

  async createToolSurfaceSnapshot(
    options: ToolGatewayCallOptions = {},
  ): Promise<ToolSurfaceSnapshotV1> {
    if (this.closed) throw this.toolSurfaceCreationUnavailable();
    let completeCreation!: () => void;
    const creation = new Promise<void>((resolve) => {
      completeCreation = resolve;
    });
    this.activeToolSurfaceSnapshotCreations.add(creation);
    try {
      await this.ensureExecutionAuthorization(options.runContext);
      if (this.closed) throw this.toolSurfaceCreationUnavailable();
      if (this.initialized === false) {
        await this.refreshRuntime();
      }
      if (this.closed) throw this.toolSurfaceCreationUnavailable();
      const requestedNames =
        options.toolNames === undefined
          ? undefined
          : new Set(options.toolNames);
      const descriptors = (
        requestedNames === undefined
          ? this.listExposedDescriptors(options.runContext)
          : this.listActivatableDescriptors(options.runContext)
      ).filter((descriptor) => requestedNames?.has(descriptor.toolId) ?? true);
      const snapshotGeneration = hashCanonical({
        version: "tool-snapshot-generation-v1",
        activeGeneration: this.registryGeneration,
        scopeFingerprint: fingerprintToolRunScopeV1(options.runContext),
        descriptors: descriptors.map(toToolDescriptorRefV1),
      });
      const snapshot = createToolSurfaceForDescriptorsV1({
        descriptors,
        registryGeneration: snapshotGeneration,
        runContext: options.runContext,
      });
      const executions = new Map<string, PinnedExecutionSource>();
      try {
        for (const descriptor of descriptors) {
          executions.set(
            descriptor.toolId,
            this.createPinnedExecutionSource(
              descriptor,
              snapshot.tools.find(
                (activation) =>
                  activation.descriptor.toolId === descriptor.toolId,
              )!,
              options.runContext,
            ),
          );
        }
      } catch (error) {
        await Promise.all(
          [...executions.values()].map((source) => source.release?.()),
        );
        throw error;
      }
      this.toolSurfaceSnapshots.set(snapshot.snapshotId, snapshot);
      this.toolSurfaceExecutions.set(snapshot.snapshotId, executions);
      if (options.runContext !== undefined) {
        this.toolSurfaceRunIds.set(snapshot.snapshotId, {
          runId: options.runContext.runId,
          sessionId: options.runContext.sessionId,
        });
      }
      return snapshot;
    } finally {
      completeCreation();
      this.activeToolSurfaceSnapshotCreations.delete(creation);
    }
  }

  private toolSurfaceCreationUnavailable(): RuntimeFailure {
    return createRuntimeFailure(
      "TOOL_PINNED_HANDLER_UNAVAILABLE",
      "Tool registry is closed and cannot create a tool surface snapshot.",
      {
        subsystem: "tooling",
        classification: "configuration",
        recoverable: false,
      },
    );
  }

  resolveModelToolIntent(input: {
    snapshot: ToolSurfaceSnapshotV1;
    toolCall: { id: string; name: string; input: Record<string, unknown> };
  }): ResolvedModelToolIntentV1 {
    const active = this.toolSurfaceSnapshots.get(input.snapshot.snapshotId);
    if (active === undefined) {
      throw createRuntimeFailure(
        "TOOL_SNAPSHOT_STALE",
        `Tool surface snapshot '${input.snapshot.snapshotId}' is not active.`,
        { recoverable: false },
      );
    }
    return resolveModelToolIntentV1({
      snapshot: active,
      toolCall: input.toolCall,
    });
  }

  async prepareToolCall(
    input: Parameters<ToolGateway["prepareToolCall"]>[0],
    options: ToolGatewayCallOptions = {},
  ): Promise<PreparedToolCallV1> {
    // Validate before resolving or retaining the pinned execution source.
    parseDurablePreparedInvocationId(input.callId, "prepared tool call.callId");
    const authorizationProvider = await this.ensureExecutionAuthorization(
      options.runContext,
    );
    if (this.closed) {
      throw createRuntimeFailure(
        "TOOL_PINNED_HANDLER_UNAVAILABLE",
        "Tool registry is closed and cannot prepare a tool call.",
        {
          subsystem: "tooling",
          classification: "configuration",
          recoverable: false,
        },
      );
    }
    const snapshotSource =
      input.origin.kind === "model"
        ? this.toolSurfaceExecutions
            .get(input.origin.snapshotId)
            ?.get(input.activation.descriptor.toolId)
        : this.findPinnedExecutionSource(input.activation);
    let source =
      snapshotSource ??
      this.rehydratePreparedExecution(input, options.runContext);
    let sourceOwnsPreparedReference = false;
    if (source === undefined) {
      throw createRuntimeFailure(
        "TOOL_PINNED_HANDLER_UNAVAILABLE",
        `Pinned handler for tool '${input.activation.descriptor.toolId}' is unavailable.`,
        {
          subsystem: "tooling",
          classification: "configuration",
          recoverable: false,
          toolName: input.activation.descriptor.toolId,
          registryGeneration: input.activation.registryGeneration,
        },
      );
    }
    if (
      authorizationProvider !== undefined &&
      options.runContext !== undefined
    ) {
      source = this.createPinnedExecutionSource(
        source.pinned.descriptor,
        input.activation,
        options.runContext,
      );
      // createPinnedExecutionSource owns the initial pin. Retaining it again
      // would create a second reference with no corresponding owner.
      sourceOwnsPreparedReference = true;
    }
    let retainedSnapshotReference = false;
    try {
      if (
        hashCanonical(source.pinned.activation) !==
        hashCanonical(input.activation)
      ) {
        throw createRuntimeFailure(
          "TOOL_ACTIVATION_STALE",
          `Tool '${input.activation.descriptor.toolId}' activation is stale or divergent.`,
          { recoverable: false, toolName: input.activation.descriptor.toolId },
        );
      }
      if (sourceOwnsPreparedReference === false) {
        source.retain?.();
      }
      retainedSnapshotReference = true;
      const inputValidator = compileToolJsonSchemaV1(
        source.pinned.descriptor.inputSchema,
        { surface: "input" },
      );
      const validatedInput = validatePinnedInput(
        source.pinned.descriptor.toolId,
        input.rawInput,
        inputValidator,
        this.builtInDescriptors.has(source.pinned.descriptor.toolId),
      );
      const transformedInput =
        source.transformInput === undefined
          ? validatedInput
          : await source.transformInput(validatedInput);
      const transformedValidatedInput = validatePinnedInput(
        source.pinned.descriptor.toolId,
        transformedInput,
        inputValidator,
        this.builtInDescriptors.has(source.pinned.descriptor.toolId),
      );
      const budgeted =
        options.runtimeBudgetRemainingMs === undefined
          ? {
              input: transformedValidatedInput,
              metadata: {},
              shortCircuitResult: undefined,
            }
          : applyExternalDeadlineToolBudget({
              toolName: input.activation.descriptor.toolId,
              input: transformedValidatedInput,
              runtimeBudgetRemainingMs: options.runtimeBudgetRemainingMs,
            });
      const effectiveInput = validatePinnedInput(
        source.pinned.descriptor.toolId,
        budgeted.input,
        inputValidator,
        this.builtInDescriptors.has(source.pinned.descriptor.toolId),
      );
      const normalizedEffectiveInput = asRecord(effectiveInput);
      const execCommandContinuation =
        input.activation.descriptor.toolId === "exec_command" &&
        typeof normalizedEffectiveInput?.sessionId === "string" &&
        normalizedEffectiveInput.command === undefined;
      const workflowAuthorityAllows = authorizeWorkflowRunToolCall({
        runContext: options.runContext,
        toolId: input.activation.descriptor.toolId,
        toolFamily: this.builtInCapabilities.get(
          input.activation.descriptor.toolId,
        )?.toolFamily,
        descriptorContractRevision: input.activation.descriptor.contractRevision,
        effectiveInput: normalizedEffectiveInput ?? {},
        execCommandContinuation,
      });
      const hostedApprovalScope = options.runContext === undefined
        ? undefined
        : readHostedStableApprovalContext(options.runContext);
      const rememberedExecCommandMatch =
        input.activation.descriptor.toolId === "exec_command" &&
        !execCommandContinuation &&
        hostedApprovalScope?.actor.actorType === "end_user" &&
        this.resolveScopedContext(options.runContext).builtInContext.kestrelOne
          ?.rememberedToolApprovalEvidence?.some((evidence) => {
            const scope = evidence.scope;
            const normalized = asRecord(effectiveInput);
            return evidence.organizationId === hostedApprovalScope.organizationId &&
              evidence.environmentId === hostedApprovalScope.environmentId &&
              evidence.projectId === hostedApprovalScope.projectId &&
              evidence.threadId === hostedApprovalScope.threadId &&
              evidence.actorUserId === hostedApprovalScope.actor.actorId &&
              evidence.toolIdentity.toolId === input.activation.descriptor.toolId &&
              evidence.toolIdentity.descriptorContractRevision === input.activation.descriptor.contractRevision &&
              evidence.toolIdentity.approvalAuthorityRevision === input.approval?.authorityRevision &&
              scope.kind === "exec_command_exact" &&
              scope.command === normalized?.command &&
              scope.cwd === normalized?.cwd &&
              scope.envMode === normalized?.envMode &&
              JSON.stringify(scope.envNames) ===
                JSON.stringify(Array.isArray(normalized?.envNames) ? [...normalized.envNames].sort() : []);
          }) === true;
      if (budgeted.shortCircuitResult !== undefined) {
        source = {
          ...source,
          createHandler:
            (_handlerOptions: ToolGatewayCallOptions) =>
            async (_toolInput: unknown) =>
              budgeted.shortCircuitResult,
        };
      }
      const stableApproval =
        input.policy.decision === "approval_required" &&
        !workflowAuthorityAllows &&
        !rememberedExecCommandMatch &&
        !execCommandContinuation &&
        input.approval !== undefined &&
        options.runContext !== undefined
          ? createPreparedToolApprovalAuthorityV2({
              activation: input.activation,
              executionClass: source.resolveExecutionClass?.(asRecord(effectiveInput) ?? {}) ??
                source.pinned.descriptor.capability.executionClass,
              effectiveInput: asRecord(effectiveInput) ?? {},
              policyRevision: input.policy.policyRevision,
              approvalAuthorityRevision: input.approval.authorityRevision,
              capabilities: input.approvalCapabilities ?? [],
              runContext: options.runContext,
            })
          : undefined;
      const prepared = createPreparedToolCallV1({
        runId: input.runId,
        sessionId: input.sessionId,
        callId: input.callId,
        activation: input.activation,
        origin: input.origin,
        effectiveInput: asRecord(effectiveInput) ?? {},
        policy: workflowAuthorityAllows || rememberedExecCommandMatch || execCommandContinuation
          ? { ...input.policy, decision: "allow" }
          : input.policy,
        ...(input.approval === undefined ? {} : { approval: input.approval }),
        ...(stableApproval ?? {}),
        inputAdapters: [
          ...(source.inputAdapterId === undefined
            ? []
            : [
                {
                  adapterId: source.inputAdapterId,
                  metadata: {},
                },
              ]),
          ...(source.prepareInputAdapter === undefined
            ? []
            : [source.prepareInputAdapter(asRecord(effectiveInput) ?? {})]),
          ...(input.activation.descriptor.toolId === "dev.shell.run" ||
          input.activation.descriptor.toolId === "exec_command"
            ? [
                {
                  adapterId: RUNTIME_DEADLINE_BUDGET_ADAPTER_ID,
                  metadata: budgeted.metadata,
                },
              ]
            : []),
        ],
      });
      const preparedKey = preparedExecutionKey(prepared);
      if (
        this.preparedExecutions.has(preparedKey) ||
        this.isPreparedExecutionTerminal(prepared, preparedKey) ||
        this.executingPreparedExecutionKeys.has(preparedKey)
      ) {
        throw createRuntimeFailure(
          "TOOL_PREPARED_CALL_COLLISION",
          `Prepared tool call '${prepared.callId}' is already active.`,
          {
            recoverable: false,
            toolName: prepared.activation.descriptor.toolId,
          },
        );
      }
      this.preparedExecutions.set(preparedKey, source);
      return prepared;
    } catch (error) {
      if (retainedSnapshotReference) await source.release?.();
      throw error;
    }
  }

  async inspectToolCall(
    input: Parameters<NonNullable<ToolGateway["inspectToolCall"]>>[0],
    options: ToolGatewayCallOptions = {},
  ): Promise<{ effectiveInput: Record<string, unknown> }> {
    const authorizationProvider = await this.ensureExecutionAuthorization(
      options.runContext,
    );
    const snapshotSource =
      input.origin.kind === "model"
        ? this.toolSurfaceExecutions
            .get(input.origin.snapshotId)
            ?.get(input.activation.descriptor.toolId)
        : this.findPinnedExecutionSource(input.activation);
    let source =
      snapshotSource ??
      this.rehydratePreparedExecution(input, options.runContext);
    if (source === undefined) {
      throw createRuntimeFailure(
        "TOOL_PINNED_HANDLER_UNAVAILABLE",
        `Pinned handler for tool '${input.activation.descriptor.toolId}' is unavailable.`,
        {
          subsystem: "tooling",
          classification: "configuration",
          recoverable: false,
          toolName: input.activation.descriptor.toolId,
          registryGeneration: input.activation.registryGeneration,
        },
      );
    }
    if (
      authorizationProvider !== undefined &&
      options.runContext !== undefined
    ) {
      source = this.createPinnedExecutionSource(
        source.pinned.descriptor,
        input.activation,
        options.runContext,
      );
    }
    try {
      if (
        hashCanonical(source.pinned.activation) !==
        hashCanonical(input.activation)
      ) {
        throw createRuntimeFailure(
          "TOOL_ACTIVATION_STALE",
          `Tool '${input.activation.descriptor.toolId}' activation is stale or divergent.`,
          { recoverable: false, toolName: input.activation.descriptor.toolId },
        );
      }
      const inputValidator = compileToolJsonSchemaV1(
        source.pinned.descriptor.inputSchema,
        { surface: "input" },
      );
      const validatedInput = validatePinnedInput(
        source.pinned.descriptor.toolId,
        input.rawInput,
        inputValidator,
        this.builtInDescriptors.has(source.pinned.descriptor.toolId),
      );
      const transformedInput =
        source.transformInput === undefined
          ? validatedInput
          : await source.transformInput(validatedInput);
      const transformedValidatedInput = validatePinnedInput(
        source.pinned.descriptor.toolId,
        transformedInput,
        inputValidator,
        this.builtInDescriptors.has(source.pinned.descriptor.toolId),
      );
      const budgeted =
        options.runtimeBudgetRemainingMs === undefined
          ? { input: transformedValidatedInput }
          : applyExternalDeadlineToolBudget({
              toolName: input.activation.descriptor.toolId,
              input: transformedValidatedInput,
              runtimeBudgetRemainingMs: options.runtimeBudgetRemainingMs,
            });
      return {
        effectiveInput: validatePinnedInput(
          source.pinned.descriptor.toolId,
          budgeted.input,
          inputValidator,
          this.builtInDescriptors.has(source.pinned.descriptor.toolId),
        ),
      };
    } finally {
      if (source !== snapshotSource) await source.release?.();
    }
  }

  async executePreparedToolCall(
    prepared: PreparedToolCallV1,
    options: ToolGatewayCallOptions = {},
  ): Promise<AgentToolResultV2> {
    const key = preparedExecutionKey(prepared);
    if (
      this.closed ||
      this.isPreparedExecutionTerminal(prepared, key) ||
      this.executingPreparedExecutionKeys.has(key) ||
      this.releasingPreparedExecutions.has(key)
    ) {
      throw this.preparedExecutionUnavailable(prepared);
    }
    const retainedSource = this.preparedExecutions.get(key);
    if (
      retainedSource === undefined &&
      this.releasedPreparedExecutionSessions.has(prepared.sessionId)
    ) {
      throw this.preparedExecutionUnavailable(prepared);
    }
    // A source-free call is a restart recovery, not an ordinary execution.
    // Rehydration therefore requires explicit current run authority. This
    // keeps bounded run cleanup from reopening stale no-authority replay.
    const preparedSource =
      retainedSource ??
      (options.runContext === undefined
        ? undefined
        : this.rehydratePreparedExecution(prepared, options.runContext));
    if (preparedSource === undefined) {
      throw this.preparedExecutionUnavailable(prepared);
    }
    this.preparedExecutions.delete(key);
    this.markPreparedExecutionTerminal(prepared, key);
    this.executingPreparedExecutionKeys.add(key);
    let completeActiveExecution!: () => void;
    const activeExecutionCompletion = new Promise<void>((resolve) => {
      completeActiveExecution = resolve;
    });
    this.activePreparedExecutionCompletions.set(key, activeExecutionCompletion);
    const source = this.rebindPreparedBuiltInForManagedWorktree(
      preparedSource,
      prepared,
      options.runContext,
    );
    try {
      let persistCompletedCapabilityRawOutput:
        | ((rawOutput: unknown) => Promise<void>)
        | undefined;
      const preparedHandler = source.createHandler(
        {
          ...options,
          persistCompletedCapabilityRawOutput: (rawOutput) => {
            if (persistCompletedCapabilityRawOutput === undefined) {
              throw new Error(
                "Capability result persistence is unavailable for this prepared execution.",
              );
            }
            return persistCompletedCapabilityRawOutput(rawOutput);
          },
        },
        prepared,
      );
      let result = await executePinnedToolCallV1({
        prepared,
        pinned: {
          ...source.pinned,
          handler: (toolInput, lifecycle) => {
            persistCompletedCapabilityRawOutput =
              lifecycle?.persistCompletedCapabilityResult;
            return preparedHandler(toolInput);
          },
        },
        signal: options.signal,
        persistCompletedCapabilityResult:
          options.persistCompletedCapabilityResult,
      });
      if (
        result.outcome.kind === "failure" &&
        result.outcome.normalizedFailureCode === "EXECUTION_AUTH_EXPIRED" &&
        options.runContext !== undefined
      ) {
        const provider = this.resolveExecutionAuthorizationProvider(
          options.runContext,
        );
        if (provider !== undefined) {
          await provider.getTicket({ forceRenew: true });
          const retrySource = this.createPinnedExecutionSource(
            source.pinned.descriptor,
            prepared.activation,
            options.runContext,
          );
          try {
            let persistRetryCapabilityRawOutput:
              | ((rawOutput: unknown) => Promise<void>)
              | undefined;
            const retryHandler = retrySource.createHandler(
              {
                ...options,
                persistCompletedCapabilityRawOutput: (rawOutput) => {
                  if (persistRetryCapabilityRawOutput === undefined) {
                    throw new Error(
                      "Capability result persistence is unavailable for this prepared execution.",
                    );
                  }
                  return persistRetryCapabilityRawOutput(rawOutput);
                },
              },
              prepared,
            );
            result = await executePinnedToolCallV1({
              prepared,
              pinned: {
                ...retrySource.pinned,
                handler: (toolInput, lifecycle) => {
                  persistRetryCapabilityRawOutput =
                    lifecycle?.persistCompletedCapabilityResult;
                  return retryHandler(toolInput);
                },
              },
              signal: options.signal,
              persistCompletedCapabilityResult:
                options.persistCompletedCapabilityResult,
            });
          } finally {
            await retrySource.release?.();
          }
        }
      }
      return (await annotateWorkspaceSkillRead({
        toolName: result.toolName,
        input: prepared.effectiveInput,
        output: result,
        runContext: options.runContext,
        progress: this.workspaceSkillReadProgress,
      })) as AgentToolResultV2;
    } finally {
      let preparedReleaseFailure: unknown;
      try {
        const releaseResults = await Promise.allSettled([
          ...(source === preparedSource ? [] : [source.release?.()]),
          preparedSource.release?.(),
        ]);
        const preparedSourceResult = releaseResults.at(-1);
        if (preparedSourceResult?.status === "rejected") {
          // Preserve failed ownership so explicit release or close can retry.
          if (retainedSource !== undefined) {
            this.preparedExecutions.set(key, retainedSource);
          }
        }
        preparedReleaseFailure = releaseResults.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )?.reason;
      } finally {
        this.executingPreparedExecutionKeys.delete(key);
        completeActiveExecution();
        this.activePreparedExecutionCompletions.delete(key);
      }
      if (preparedReleaseFailure !== undefined) throw preparedReleaseFailure;
    }
  }

  async releasePreparedToolCall(prepared: PreparedToolCallV1): Promise<void> {
    const key = preparedExecutionKey(prepared);
    const existingRelease = this.releasingPreparedExecutions.get(key);
    if (existingRelease !== undefined) {
      await existingRelease;
      return;
    }
    if (this.executingPreparedExecutionKeys.has(key)) return;
    const source = this.preparedExecutions.get(key);
    if (source === undefined) {
      if (this.closed || this.isPreparedExecutionTerminal(prepared, key))
        return;
      this.markPreparedExecutionTerminal(prepared, key);
      return;
    }
    if (this.closed) return;
    this.markPreparedExecutionTerminal(prepared, key);
    const release = Promise.resolve().then(() => source.release?.());
    this.releasingPreparedExecutions.set(key, release);
    try {
      await release;
      if (this.preparedExecutions.get(key) === source) {
        this.preparedExecutions.delete(key);
      }
    } finally {
      this.releasingPreparedExecutions.delete(key);
    }
  }

  private isPreparedExecutionTerminal(
    prepared: PreparedToolCallV1,
    key: string,
  ): boolean {
    return (
      this.terminalPreparedExecutionKeysByOwner
        .get(preparedExecutionOwnerKey(prepared.runId, prepared.sessionId))
        ?.has(key) === true
    );
  }

  private markPreparedExecutionTerminal(
    prepared: PreparedToolCallV1,
    key: string,
  ): void {
    const ownerKey = preparedExecutionOwnerKey(
      prepared.runId,
      prepared.sessionId,
    );
    const ownedKeys =
      this.terminalPreparedExecutionKeysByOwner.get(ownerKey) ??
      new Set<string>();
    ownedKeys.add(key);
    this.terminalPreparedExecutionKeysByOwner.set(ownerKey, ownedKeys);
    const sessionOwners =
      this.preparedExecutionOwnersBySession.get(prepared.sessionId) ??
      new Set<string>();
    sessionOwners.add(ownerKey);
    this.preparedExecutionOwnersBySession.set(
      prepared.sessionId,
      sessionOwners,
    );
  }

  private preparedExecutionUnavailable(
    prepared: PreparedToolCallV1,
  ): RuntimeFailure {
    return createRuntimeFailure(
      "TOOL_PINNED_HANDLER_UNAVAILABLE",
      `Prepared tool call '${prepared.callId}' has no pinned live handler.`,
      {
        subsystem: "tooling",
        classification: "configuration",
        recoverable: false,
        toolName: prepared.activation.descriptor.toolId,
        registryGeneration: prepared.activation.registryGeneration,
      },
    );
  }

  private rebindPreparedBuiltInForManagedWorktree(
    source: PinnedExecutionSource,
    prepared: PreparedToolCallV1,
    runContext: ToolRunContext | undefined,
  ): PinnedExecutionSource {
    if (
      runContext === undefined ||
      this.builtInDescriptors.has(prepared.activation.descriptor.toolId) ===
        false ||
      prepared.activation.scopeFingerprint ===
        fingerprintToolRunScopeV1(runContext) ||
      hasTrustedManagedWorktreeBinding(
        runContext.runId,
        runContext.sessionState,
        runContext.payload,
        runContext.sessionId,
      ) === false
    ) {
      return source;
    }
    return this.createPinnedExecutionSource(
      source.pinned.descriptor,
      prepared.activation,
      runContext,
    );
  }

  async releaseToolSurfaceSnapshot(snapshotId: string): Promise<void> {
    if (this.closed) return;
    const existingRelease = this.releasingToolSurfaceSnapshots.get(snapshotId);
    if (existingRelease !== undefined) {
      await existingRelease;
      return;
    }
    const executions = this.toolSurfaceExecutions.get(snapshotId);
    this.toolSurfaceSnapshots.delete(snapshotId);
    if (executions === undefined) {
      this.toolSurfaceRunIds.delete(snapshotId);
      return;
    }
    const release = this.releaseToolSurfaceExecutionEntries(
      snapshotId,
      executions,
    );
    this.releasingToolSurfaceSnapshots.set(snapshotId, release);
    try {
      await release;
      this.toolSurfaceRunIds.delete(snapshotId);
    } finally {
      this.releasingToolSurfaceSnapshots.delete(snapshotId);
    }
  }

  private async releaseToolSurfaceExecutionEntries(
    snapshotId: string,
    executions: Map<string, PinnedExecutionSource>,
  ): Promise<void> {
    const results = await Promise.allSettled(
      [...executions.entries()].map(async ([toolId, source]) => {
        await source.release?.();
        if (executions.get(toolId) === source) executions.delete(toolId);
      }),
    );
    if (executions.size === 0) {
      this.toolSurfaceExecutions.delete(snapshotId);
    }
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
  }

  async releaseToolRun(runId: string, sessionId: string): Promise<void> {
    if (this.closed) return;
    const snapshotIds = [...this.toolSurfaceRunIds.entries()]
      .filter(([, owner]) => owner.sessionId === sessionId)
      .map(([snapshotId]) => snapshotId);
    for (const snapshotId of snapshotIds) {
      await this.releaseToolSurfaceSnapshot(snapshotId);
    }
    // The terminal continuation may have a different run ID from the run that
    // prepared the call. Collapse the owners recorded while those calls were
    // made instead of manufacturing an ineffective continuation owner.
    const preparedOwnerKeys =
      this.preparedExecutionOwnersBySession.get(sessionId) ?? new Set<string>();
    for (const ownerKey of preparedOwnerKeys) {
      this.terminalPreparedExecutionKeysByOwner.delete(ownerKey);
    }
    this.preparedExecutionOwnersBySession.delete(sessionId);
    // One bounded session fence prevents source-free stale rehydration after
    // cleanup. A fresh registry has no fence and can still perform an
    // explicitly authorized restart recovery.
    this.releasedPreparedExecutionSessions.add(sessionId);
  }

  getDescriptor(
    name: string,
    options: ToolRegistryListOptions = {},
  ): ToolDescriptorV1 | undefined {
    return (
      this.builtInDescriptors.get(name) ??
      this.resolveExposedMcpTool(name, options.runContext)?.descriptor
    );
  }

  getModelTools(options: ToolRegistryListOptions = {}): ModelToolSpec[] {
    const tools: ModelToolSpec[] = [];
    const scopedContext = this.resolveScopedContext(options.runContext);
    const allowlist = scopedContext.allowlist;
    const activeBuiltInContext = scopedContext.builtInContext;
    const mcpStatus = this.resolveMcpSnapshot(options.runContext);
    const workflowAuthority = readWorkflowRunAuthority(options.runContext);

    for (const name of allowlist) {
      if (
        workflowAuthority !== undefined &&
        (workflowAuthority.activeStep.kind === "kestrel"
          ? workflowAuthority.manifest.nativeTools.some(entry => entry.toolId === name)
          : workflowAuthority.manifest.actions.some(entry => entry.nodeId === workflowAuthority.activeStep.nodeId && entry.toolId === name)) === false
      ) {
        continue;
      }
      const builtIn = this.builtInToolSpecs.get(name);
      if (builtIn !== undefined) {
        if (
          isRuntimeBuiltInTool(name, this.builtInCapabilities) &&
          MODEL_VISIBLE_RUNTIME_TOOL_NAMES.has(name) === false
        ) {
          continue;
        }
        if (isBuiltInToolDisabledByContext(name, activeBuiltInContext)) {
          continue;
        }
        tools.push({
          ...builtIn,
        });
        continue;
      }

      const mcpTool = mcpStatus.tools.find(
        (tool) => tool.namespacedToolName === name,
      );
      if (mcpTool?.descriptor === undefined) {
        continue;
      }
      tools.push({
        name: mcpTool.descriptor.toolId,
        description: mcpTool.descriptor.description,
        inputSchema: mcpTool.descriptor.inputSchema,
        ...(mcpTool.descriptor.modelOutputContract !== undefined
          ? { outputContract: mcpTool.descriptor.modelOutputContract }
          : {}),
      });
    }

    return tools;
  }

  getCapabilityManifest(
    options: ToolRegistryListOptions = {},
  ): CapabilityManifestItem[] {
    const manifest: CapabilityManifestItem[] = [];
    const scopedContext = this.resolveScopedContext(options.runContext);
    const allowlist = scopedContext.allowlist;
    const activeBuiltInContext = scopedContext.builtInContext;
    const mcpStatus = this.resolveMcpSnapshot(options.runContext);
    const hostedMcpGrantId = readHostedMcpGrantId(options.runContext?.payload);

    for (const name of allowlist) {
      const builtIn = this.builtInCapabilities.get(name);
      if (builtIn !== undefined) {
        if (
          builtIn.freshnessClass === "runtime" &&
          MODEL_VISIBLE_RUNTIME_TOOL_NAMES.has(name) === false
        ) {
          continue;
        }
        if (isBuiltInToolDisabledByContext(name, activeBuiltInContext)) {
          continue;
        }
        const configuredAppApprovalMode =
          activeBuiltInContext.kestrelOne?.appApprovalModes?.[name];
        const approvalPolicyEvidence =
          activeBuiltInContext.kestrelOne?.appApprovalPolicies?.[name];
        const descriptor = this.builtInDescriptors.get(name)!;
        const hasHostedAppPolicy =
          configuredAppApprovalMode !== undefined ||
          approvalPolicyEvidence !== undefined;
        const upstreamAuthority = hasHostedAppPolicy
          ? {
              kind: "hosted_app_policy" as const,
              revision: hashCanonical({
                toolId: name,
                configuredAppApprovalMode,
                approvalPolicyEvidence,
                minimumApprovalMode: builtIn.minimumApprovalMode ?? "auto",
              }),
            }
          : (builtIn.approvalAuthority ?? {
              kind: "runtime_policy" as const,
              revision: hashCanonical({ toolId: name, policy: "runtime" }),
            });
        const approvalAuthority = this.bindApprovalAuthorityToDescriptor(
          descriptor,
          upstreamAuthority,
          options.runContext,
        );
        const baselineApprovalDisposition: ToolApprovalDispositionV1 | undefined =
          approvalPolicyEvidence !== undefined
            ? resolveToolApprovalDispositionV1({
                environment: approvalPolicyEvidence.environment,
                project: approvalPolicyEvidence.project,
                subject: approvalPolicyEvidence.subject,
                minimum:
                  builtIn.minimumApprovalMode ?? approvalPolicyEvidence.minimum,
                authority: approvalAuthority,
              })
            : configuredAppApprovalMode === undefined
              ? undefined
              : resolveToolApprovalDispositionV1({
                  environment: configuredAppApprovalMode!,
                  minimum: builtIn.minimumApprovalMode ?? "auto",
                  authority: approvalAuthority,
                });
        const stableToolIdentity = createStableToolApprovalIdentityV1({
          toolId: name,
          descriptorContractRevision: descriptor.contractRevision,
          approvalAuthorityRevision: approvalAuthority.revision,
        });
        const hostedScope = options.runContext === undefined
          ? undefined
          : readHostedStableApprovalContext(options.runContext);
        const exactRememberedEvidenceMatch =
          name !== "exec_command" &&
          hostedScope?.actor.actorType === "end_user" &&
          activeBuiltInContext.kestrelOne?.rememberedToolApprovalEvidence?.some(
            (evidence) =>
              evidence.organizationId === hostedScope.organizationId &&
              evidence.environmentId === hostedScope.environmentId &&
              evidence.projectId === hostedScope.projectId &&
              evidence.threadId === hostedScope.threadId &&
              evidence.actorUserId === hostedScope.actor.actorId &&
              evidence.toolIdentity.toolId === stableToolIdentity.toolId &&
              evidence.toolIdentity.descriptorContractRevision ===
                stableToolIdentity.descriptorContractRevision &&
              evidence.toolIdentity.approvalAuthorityRevision ===
                stableToolIdentity.approvalAuthorityRevision,
          ) === true;
        const approvalDisposition = baselineApprovalDisposition === undefined
          ? undefined
          : applyRememberedThreadApprovalV1({
              disposition: baselineApprovalDisposition,
              exactEvidenceMatch: exactRememberedEvidenceMatch,
              currentPolicy: {
                environment:
                  approvalPolicyEvidence?.environment ??
                  configuredAppApprovalMode!,
                project: approvalPolicyEvidence?.project,
                subject: approvalPolicyEvidence?.subject,
                minimum:
                  builtIn.minimumApprovalMode ??
                  approvalPolicyEvidence?.minimum ??
                  "auto",
              },
            });
        if (approvalDisposition?.mode === "deny") continue;
        const appApprovalMode =
          approvalDisposition?.mode ?? configuredAppApprovalMode;
        const approvalCapabilities =
          appApprovalMode === undefined
            ? builtIn.approvalCapabilities
            : [
                ...(builtIn.approvalCapabilities ?? []).filter(
                  (capability) => capability !== "external.confirm",
                ),
                ...(appApprovalMode === "ask"
                  ? (["external.confirm"] as const)
                  : []),
              ];
        manifest.push({
          ...builtIn,
          descriptorRef: toToolDescriptorRefV1(descriptor),
          approvalAuthority,
          ...(approvalDisposition === undefined ? {} : { approvalDisposition }),
          ...(approvalCapabilities === undefined ||
          approvalCapabilities.length === 0
            ? { approvalCapabilities: undefined }
            : { approvalCapabilities: [...new Set(approvalCapabilities)] }),
        });
        continue;
      }

      const mcpTool = mcpStatus.tools.find(
        (tool) => tool.namespacedToolName === name,
      );
      if (mcpTool?.descriptor === undefined) {
        continue;
      }
      const capability = mcpTool.descriptor.capability;
      const presentation = mcpTool.descriptor.presentation;
      const upstreamAuthority =
        mcpTool.serverId === "kestrel-one-hosted" &&
        hostedMcpGrantId !== undefined
          ? {
              kind: "hosted_mcp_grant" as const,
              revision: hostedMcpGrantId,
            }
          : {
              kind: "runtime_policy" as const,
              revision: hashCanonical({
                serverId: mcpTool.serverId,
                policy: "runtime",
              }),
            };
      manifest.push({
        name: mcpTool.descriptor.toolId,
        description: mcpTool.descriptor.description,
        freshnessClass: capability.freshnessClass,
        latencyClass: capability.latencyClass,
        costClass: capability.costClass,
        executionClass: capability.executionClass,
        ...(capability.allowedInteractionModes !== undefined
          ? {
              allowedInteractionModes: [...capability.allowedInteractionModes],
            }
          : {}),
        capabilityClasses: [...capability.capabilityClasses],
        approvalCapabilities: [...(capability.approvalCapabilities ?? [])],
        approvalAuthority: this.bindApprovalAuthorityToDescriptor(
          mcpTool.descriptor,
          upstreamAuthority,
          options.runContext,
        ),
        descriptorRef: toToolDescriptorRefV1(mcpTool.descriptor),
        displayName: presentation.displayName,
        aliases: [...presentation.aliases],
        keywords: [...presentation.keywords],
        provider: presentation.provider,
        toolFamily: presentation.toolFamily,
      });
    }

    return manifest;
  }

  getMcpStatus(): McpStatusSnapshot {
    const allowlist = this.defaultAllowlist;
    return {
      healthy: this.mcpStatus.healthy,
      checkedAt: this.mcpStatus.checkedAt,
      servers: this.mcpStatus.servers.map((server) => ({ ...server })),
      tools: this.mcpStatus.tools.map((tool) => ({
        ...tool,
        allowlisted: allowlist.has(tool.namespacedToolName),
      })),
      ...(this.mcpStatus.refreshDiagnostic === undefined
        ? {}
        : { refreshDiagnostic: { ...this.mcpStatus.refreshDiagnostic } }),
    };
  }

  resolveAvailableAllowlist(names: string[]): string[] {
    const available = new Set(this.listAvailableToolNames(this.mcpStatus));
    return [...new Set(names)].filter(
      (name) => available.has(name) || this.isRuntimeBuiltInToolName(name),
    );
  }

  async close(): Promise<void> {
    if (this.closeComplete) return;
    if (this.closeAttempt !== undefined) {
      await this.closeAttempt;
      return;
    }
    this.closed = true;
    const attempt = this.performClose();
    this.closeAttempt = attempt;
    try {
      await attempt;
      this.closeComplete = true;
    } finally {
      if (this.closeAttempt === attempt) this.closeAttempt = undefined;
    }
  }

  private async performClose(): Promise<void> {
    // Provider shutdown must never race an active external effect. New
    // executions are already rejected because closed was set synchronously.
    await Promise.allSettled([
      ...this.activePreparedExecutionCompletions.values(),
      ...this.activeToolSurfaceSnapshotCreations,
    ]);
    await Promise.allSettled([
      ...this.releasingPreparedExecutions.values(),
      ...this.releasingToolSurfaceSnapshots.values(),
    ]);

    this.toolSurfaceSnapshots.clear();
    this.toolSurfaceRunIds.clear();
    this.terminalPreparedExecutionKeysByOwner.clear();
    this.preparedExecutionOwnersBySession.clear();
    this.releasedPreparedExecutionSessions.clear();

    const ownershipReleaseResults = await Promise.allSettled([
      ...[...this.toolSurfaceExecutions.entries()].map(
        async ([snapshotId, executions]) =>
          this.releaseToolSurfaceExecutionEntries(snapshotId, executions),
      ),
      ...[...this.preparedExecutions.entries()].map(async ([key, source]) => {
        await source.release?.();
        if (this.preparedExecutions.get(key) === source) {
          this.preparedExecutions.delete(key);
        }
      }),
    ]);
    const ownershipFailure = ownershipReleaseResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    this.workspaceSkillReadProgress.clear();
    this.executionTicketsByRun.clear();
    this.executionTicketsBySession.clear();
    const registrationReleaseResults = await Promise.allSettled(
      [...this.releaseExecutionTicketRegistrationByRun.entries()].map(
        async ([runId, release]) => {
          release();
          this.releaseExecutionTicketRegistrationByRun.delete(runId);
        },
      ),
    );
    const providers = new Set(this.authorizationProvidersByRun.values());
    for (const sessionProviders of this.authorizationProvidersBySession.values()) {
      for (const provider of sessionProviders.values()) providers.add(provider);
    }
    const authorizationCloseResults = await Promise.allSettled(
      [...providers].map(async (provider) => {
        provider.close();
        for (const [runId, candidate] of this.authorizationProvidersByRun) {
          if (candidate === provider)
            this.authorizationProvidersByRun.delete(runId);
        }
        for (const [sessionId, sessionProviders] of this
          .authorizationProvidersBySession) {
          for (const [runId, candidate] of sessionProviders) {
            if (candidate === provider) sessionProviders.delete(runId);
          }
          if (sessionProviders.size === 0) {
            this.authorizationProvidersBySession.delete(sessionId);
          }
        }
      }),
    );
    // A provider remains open while any pinned ownership still needs a retry.
    // Independent credential cleanup above is still attempted in this pass.
    const managerCloseResults: PromiseSettledResult<void>[] = [];
    if (ownershipFailure === undefined) {
      const managers = new Map<McpToolProvider, () => void>();
      if (this.defaultMcpManagerClosed === false) {
        managers.set(this.mcpManager, () => {
          this.defaultMcpManagerClosed = true;
        });
      }
      for (const scope of this.hostedMcpScopes.values()) {
        managers.set(scope.manager, () => {
          for (const [grantId, candidate] of this.hostedMcpScopes) {
            if (candidate.manager === scope.manager) {
              this.hostedMcpScopes.delete(grantId);
            }
          }
          this.retiredHostedMcpManagers.delete(scope.manager);
        });
      }
      for (const manager of this.retiredHostedMcpManagers) {
        if (managers.has(manager)) continue;
        managers.set(manager, () => {
          this.retiredHostedMcpManagers.delete(manager);
        });
      }
      managerCloseResults.push(
        ...(await Promise.allSettled(
          [...managers.entries()].map(async ([manager, markClosed]) => {
            await manager.close();
            markClosed();
          }),
        )),
      );
    }
    const cleanupFailure = [
      ...ownershipReleaseResults,
      ...managerCloseResults,
      ...registrationReleaseResults,
      ...authorizationCloseResults,
    ].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (cleanupFailure !== undefined) throw cleanupFailure.reason;
  }

  private activateRegistryGeneration(): void {
    this.registryGenerationSequence += 1;
    const descriptors = [
      ...this.builtInDescriptors.values(),
      ...this.mcpStatus.tools.flatMap((tool) =>
        tool.descriptor === undefined ? [] : [tool.descriptor],
      ),
    ].map(toToolDescriptorRefV1);
    this.registryGeneration = `generation:${this.registryGenerationSequence}:${hashCanonical(descriptors)}`;
  }

  private listExposedDescriptors(
    runContext: ToolRunContext | undefined,
  ): ToolDescriptorV1[] {
    return this.getModelTools({ runContext }).map((tool) => {
      const descriptor = this.getDescriptor(tool.name, { runContext });
      if (descriptor === undefined) {
        throw createRuntimeFailure(
          "TOOL_DESCRIPTOR_UNAVAILABLE",
          `Exposed tool '${tool.name}' has no canonical descriptor.`,
          { recoverable: false, toolName: tool.name },
        );
      }
      return descriptor;
    });
  }

  private listActivatableDescriptors(
    runContext: ToolRunContext | undefined,
  ): ToolDescriptorV1[] {
    const scopedContext = this.resolveScopedContext(runContext);
    const mcpStatus = this.resolveMcpSnapshot(runContext);
    return [...scopedContext.allowlist].flatMap((name) => {
      if (isInternalOnlyRuntimeToolName(name)) return [];
      const builtIn = this.builtInDescriptors.get(name);
      if (builtIn !== undefined) {
        return isBuiltInToolDisabledByContext(
          name,
          scopedContext.builtInContext,
        )
          ? []
          : [builtIn];
      }
      const mcpTool = mcpStatus.tools.find(
        (candidate) => candidate.namespacedToolName === name,
      );
      return mcpTool?.descriptor === undefined ? [] : [mcpTool.descriptor];
    });
  }

  private bindApprovalAuthorityToDescriptor(
    descriptor: ToolDescriptorV1,
    upstream: NonNullable<ToolCapabilityMetadata["approvalAuthority"]>,
    runContext: ToolRunContext | undefined,
  ): NonNullable<ToolCapabilityMetadata["approvalAuthority"]> {
    return {
      kind: upstream.kind,
      revision: hashCanonical({
        version: "tool-approval-authority-v1",
        descriptor: toToolDescriptorRefV1(descriptor),
        upstream,
      }),
    };
  }

  private findPinnedExecutionSource(
    activation: Parameters<ToolGateway["prepareToolCall"]>[0]["activation"],
  ): PinnedExecutionSource | undefined {
    for (const executions of this.toolSurfaceExecutions.values()) {
      const source = executions.get(activation.descriptor.toolId);
      if (
        source !== undefined &&
        hashCanonical(source.pinned.activation) === hashCanonical(activation)
      ) {
        return source;
      }
    }
    return undefined;
  }

  private createPinnedExecutionSource(
    descriptor: ToolDescriptorV1,
    activation: Parameters<ToolGateway["prepareToolCall"]>[0]["activation"],
    runContext: ToolRunContext | undefined,
  ): PinnedExecutionSource {
    const validator = compileToolJsonSchemaV1(descriptor.runtimeOutput.schema, {
      surface: "output",
    });
    if (this.builtInDescriptors.has(descriptor.toolId)) {
      const activeContext =
        this.resolveScopedContext(runContext).builtInContext;
      const normalizer = defaultToolCatalog.createResultNormalizers([
        descriptor.toolId,
      ])[descriptor.toolId];
      if (normalizer === undefined) {
        throw createRuntimeFailure(
          "TOOL_RESULT_NORMALIZER_UNAVAILABLE",
          `Pinned result normalizer '${descriptor.execution.resultNormalizerId}' is unavailable.`,
          { recoverable: false, toolName: descriptor.toolId },
        );
      }
      const hasExecutionClassResolver =
        defaultToolCatalog.resolveExecutionClass(descriptor.toolId, {}) !== undefined;
      const hasPreparedInputAdapter =
        defaultToolCatalog.prepareInputAdapter(descriptor.toolId, {}) !== undefined;
      const resolveExecutionClass = (input: Record<string, unknown>) =>
        defaultToolCatalog.resolveExecutionClass(descriptor.toolId, input) ??
        descriptor.capability.executionClass;
      return {
        pinned: {
          descriptor,
          activation,
          validator,
          normalizer,
          ...(hasExecutionClassResolver ? { resolveExecutionClass } : {}),
        },
        inputAdapterId: "kestrel.builtin-input-normalizer:v1",
        ...(hasExecutionClassResolver ? { resolveExecutionClass } : {}),
        ...(hasPreparedInputAdapter === false ? {} : {
          prepareInputAdapter: (input: Record<string, unknown>) =>
            defaultToolCatalog.prepareInputAdapter(descriptor.toolId, input)!,
        }),
        transformInput: async (input) => {
          const normalized = normalizeToolActionInput(
            descriptor.toolId,
            input,
            activeContext.fileSystem?.workspaceRoot,
            {
              workspaceAppRoot: activeContext.workspace?.appRoot,
              devShellEnvMode: activeContext.devShell?.envMode,
            },
          );
          validateBuiltInToolInputContract(descriptor.toolId, normalized);
          const record = asRecord(normalized);
          if (record === undefined) {
            throw createRuntimeFailure(
              "TOOL_INPUT_INVALID",
              `Tool '${descriptor.toolId}' normalized input must remain an object.`,
              { recoverable: false, toolName: descriptor.toolId },
            );
          }
          return await prepareDesktopGmailMutationInput({
            toolName: descriptor.toolId,
            input: record,
            context: activeContext,
          });
        },
        createHandler: (handlerOptions: ToolGatewayCallOptions, prepared) => {
          const baseExecutionContext =
            prepared === undefined
              ? activeContext
              : {
                  ...activeContext,
                  runtime: {
                    ...activeContext.runtime,
                    runId: activeContext.runtime?.runId ?? prepared.runId,
                    sessionId:
                      activeContext.runtime?.sessionId ?? prepared.sessionId,
                    toolCallId: prepared.callId,
                  },
                  ...(descriptor.toolId === "code.execute" &&
                  activeContext.sandboxCapabilityRuntime !== undefined
                    ? {
                        sandboxCapabilityRuntime: {
                          ...activeContext.sandboxCapabilityRuntime,
                          preparedPolicy: prepared.policy,
                          ...(prepared.approval === undefined
                            ? {}
                            : { preparedApproval: prepared.approval }),
                        },
                      }
                    : {}),
                };
          const executionContext = prepared === undefined
            ? baseExecutionContext
            : withPreparedExecCommandApprovalContext(
                baseExecutionContext,
                prepared,
              );
          const contextWithResultPersistence =
            handlerOptions.persistCompletedCapabilityRawOutput === undefined
              ? executionContext
              : {
                  ...executionContext,
                  persistCompletedCapabilityResult:
                    handlerOptions.persistCompletedCapabilityRawOutput,
                };
          const handlers = defaultToolCatalog.createRawHandlers(
            [descriptor.toolId],
            handlerOptions.console === undefined
              ? {
                  ...contextWithResultPersistence,
                  signal: handlerOptions.signal,
                }
              : {
                  ...contextWithResultPersistence,
                  toolConsole: handlerOptions.console,
                  signal: handlerOptions.signal,
                },
            prepared,
          );
          const handler = handlers[descriptor.toolId];
          if (handler === undefined) {
            throw createRuntimeFailure(
              "TOOL_PINNED_HANDLER_UNAVAILABLE",
              `Pinned built-in handler '${descriptor.execution.handlerId}' is unavailable.`,
              { recoverable: false, toolName: descriptor.toolId },
            );
          }
          return handler;
        },
      };
    }
    const manager = this.resolveMcpManager(runContext);
    const pinnedHandle = manager.pinTool?.(descriptor.toolId);
    if (pinnedHandle === undefined) {
      throw createRuntimeFailure(
        "TOOL_PINNED_HANDLER_UNAVAILABLE",
        `Dynamic tool '${descriptor.toolId}' cannot be activated without an exact pinned handler.`,
        {
          recoverable: false,
          toolName: descriptor.toolId,
          handlerId: descriptor.execution.handlerId,
        },
      );
    }
    const normalizer = resolveMcpResultNormalizer(
      descriptor.execution.resultNormalizerId,
      descriptor.toolId,
    );
    return {
      pinned: {
        descriptor,
        activation,
        validator,
        normalizer,
      },
      createHandler:
        (_handlerOptions: ToolGatewayCallOptions) => (toolInput: unknown) =>
          pinnedHandle.call(toolInput),
      retain: () => pinnedHandle.retain(),
      release: () => pinnedHandle.release(),
    };
  }

  private rehydratePreparedExecution(
    input: { activation: PreparedToolCallV1["activation"] },
    runContext: ToolRunContext | undefined,
  ): PinnedExecutionSource | undefined {
    const descriptor =
      this.builtInDescriptors.get(input.activation.descriptor.toolId) ??
      this.resolveExposedMcpTool(
        input.activation.descriptor.toolId,
        runContext,
      )?.descriptor;
    const blockedResumeScope = resolveBlockedResumeScope(runContext);
    const scopeMatches =
      input.activation.scopeFingerprint ===
        fingerprintToolRunScopeV1(runContext) ||
      (runContext !== undefined &&
        blockedResumeScope !== undefined &&
        input.activation.scopeFingerprint ===
          fingerprintToolRunScopeV1({
            ...runContext,
            runId: blockedResumeScope.runId,
            payload: {
              ...(asRecord(runContext.payload) ?? {}),
              ...(blockedResumeScope.mcpContext === undefined
                ? {}
                : { mcpContext: blockedResumeScope.mcpContext }),
            },
          }));
    if (
      descriptor === undefined ||
      hashCanonical(toToolDescriptorRefV1(descriptor)) !==
        hashCanonical(input.activation.descriptor) ||
      scopeMatches === false
    ) {
      return;
    }
    return this.createPinnedExecutionSource(
      descriptor,
      input.activation,
      runContext,
    );
  }

  private isRuntimeBuiltInToolName(name: string): boolean {
    if (this.builtInToolSpecs.has(name) === false) {
      return false;
    }
    return isRuntimeBuiltInTool(name, this.builtInCapabilities);
  }

  private listAvailableToolNames(mcpStatus: McpStatusSnapshot): string[] {
    const available = new Set<string>();
    for (const [name] of this.builtInToolSpecs) {
      if (
        isRuntimeBuiltInTool(name, this.builtInCapabilities) &&
        MODEL_VISIBLE_RUNTIME_TOOL_NAMES.has(name) === false
      ) {
        continue;
      }
      if (isBuiltInToolDisabledByContext(name, this.builtInContext)) {
        continue;
      }
      available.add(name);
    }
    for (const tool of mcpStatus.tools) {
      if (tool.descriptor === undefined) {
        continue;
      }
      available.add(tool.namespacedToolName);
    }
    return [...available];
  }

  private resolveExposedMcpTool(
    name: string,
    runContext: ToolRunContext | undefined,
  ) {
    const tool = this.resolveMcpSnapshot(runContext).tools.find(
      (candidate) => candidate.namespacedToolName === name,
    );
    return tool?.descriptor !== undefined ? tool : undefined;
  }

  private resolveMcpManager(
    runContext: ToolRunContext | undefined,
  ): McpToolProvider {
    const grantId = readHostedMcpGrantId(runContext?.payload);
    if (!grantId) {
      return this.mcpManager;
    }
    const scope = this.hostedMcpScopes.get(grantId);
    if (!scope) {
      throw createRuntimeFailure(
        "MCP_HOSTED_SCOPE_UNAVAILABLE",
        "The hosted MCP grant is not connected for this run.",
        { grantId, recoverable: false },
      );
    }
    scope.lastUsedAt = Date.now();
    return scope.manager;
  }

  private resolveMcpSnapshot(
    runContext: ToolRunContext | undefined,
  ): McpStatusSnapshot {
    const grantId = readHostedMcpGrantId(runContext?.payload);
    if (!grantId) {
      return this.mcpStatus;
    }
    const hosted = this.hostedMcpScopes.get(grantId)?.snapshot;
    return hosted
      ? combineMcpSnapshots(this.mcpStatus, hosted)
      : this.mcpStatus;
  }

  private resolveMcpSnapshotFromTurnInput(
    input: HostedMcpRuntimeTurnInput,
  ): McpStatusSnapshot {
    if (input.mcpContext === undefined) {
      return this.mcpStatus;
    }
    const context = parseHostedMcpContext(input.mcpContext);
    const hosted = this.hostedMcpScopes.get(context.grantId)?.snapshot;
    return hosted
      ? combineMcpSnapshots(this.mcpStatus, hosted)
      : this.mcpStatus;
  }

  private async pruneHostedMcpScopes(activeGrantId: string): Promise<void> {
    const maximumScopes = 128;
    if (this.hostedMcpScopes.size <= maximumScopes) {
      return;
    }
    const stale = [...this.hostedMcpScopes.entries()]
      .filter(([grantId]) => grantId !== activeGrantId)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
      .slice(0, this.hostedMcpScopes.size - maximumScopes);
    await Promise.all(
      stale.map(async ([, scope]) => {
        this.retiredHostedMcpManagers.add(scope.manager);
        await scope.manager.retire();
      }),
    );
    for (const [grantId] of stale) {
      this.hostedMcpScopes.delete(grantId);
    }
  }

  private async ensureExecutionAuthorization(
    runContext: ToolRunContext | undefined,
  ): Promise<ExecutionAuthorizationProvider | undefined> {
    if (runContext === undefined) return;
    const provider = this.resolveExecutionAuthorizationProvider(runContext);
    if (!provider) return;
    await provider.getTicket();
    return provider;
  }

  private resolveExecutionAuthorizationProvider(
    runContext: ToolRunContext,
  ): ExecutionAuthorizationProvider | undefined {
    return (
      this.authorizationProvidersByRun.get(runContext.runId) ??
      this.resolveUnambiguousSessionAuthorizationProvider(runContext.sessionId)
    );
  }

  private registerSensitiveExecutionAuthorization(
    runId: string,
    executionTicket: string,
    renewalToken?: string | undefined,
  ) {
    this.releaseExecutionTicketRegistrationByRun.get(runId)?.();
    const releases = [
      this.sensitiveValueRegistry?.register({
        reference: {
          referenceId: `execution-ticket:${runId}`,
          kind: "credential",
          scope: "tool",
        },
        value: executionTicket,
      }),
      ...(renewalToken === undefined
        ? []
        : [
            this.sensitiveValueRegistry?.register({
              reference: {
                referenceId: `execution-renewal-token:${runId}`,
                kind: "credential",
                scope: "tool",
              },
              value: renewalToken,
            }),
          ]),
    ].filter((release): release is () => void => release !== undefined);
    this.releaseExecutionTicketRegistrationByRun.set(runId, () =>
      releases.forEach((release) => release()),
    );
  }

  private resolveUnambiguousSessionAuthorizationProvider(
    sessionId: string,
  ): ExecutionAuthorizationProvider | undefined {
    const providers = this.authorizationProvidersBySession.get(sessionId);
    if (providers?.size !== 1) return;
    return providers.values().next().value;
  }

  private async replaceHostedMcpScope(
    context: ReturnType<typeof parseHostedMcpContext>,
    executionTicket: string,
    runId: string,
  ) {
    const existing = this.hostedMcpScopes.get(context.grantId);
    if (existing?.executionTicket === executionTicket) return;
    const manager = new McpClientManager({
      servers: [],
      hostedGateway: { context, executionTicket },
      fetchImpl: this.fetchImpl,
    });
    const snapshot = compileMcpStatusSnapshotV1(await manager.refresh());
    this.assertHostedToolNamesSafe(snapshot);
    this.hostedMcpScopes.set(context.grantId, {
      manager,
      snapshot,
      executionTicket,
      lastUsedAt: Date.now(),
      runId,
    });
    if (existing) {
      this.retiredHostedMcpManagers.add(existing.manager);
      await existing.manager.retire();
    }
  }

  private assertHostedToolNamesSafe(snapshot: McpStatusSnapshot): void {
    const staticNames = new Set(
      this.mcpStatus.tools.map((tool) => tool.namespacedToolName),
    );
    for (const tool of snapshot.tools) {
      if (
        this.builtInToolSpecs.has(tool.namespacedToolName) ||
        staticNames.has(tool.namespacedToolName)
      ) {
        throw createRuntimeFailure(
          "MCP_TOOL_NAME_COLLISION",
          `Hosted MCP tool '${tool.namespacedToolName}' conflicts with an existing runtime tool.`,
          { toolName: tool.namespacedToolName, recoverable: false },
        );
      }
    }
  }

  private resolveScopedContext(runContext: ToolRunContext | undefined): {
    allowlist: ReadonlySet<string>;
    builtInContext: SharedToolContext;
  } {
    if (runContext === undefined) {
      return {
        allowlist: this.defaultAllowlist,
        builtInContext: this.builtInContext,
      };
    }
    return resolveScopedRunContext(
      runContext.payload,
      this.defaultAllowlist,
      this.builtInContext,
      resolveRuntimeToolRunContext(
        runContext.runId,
        runContext.sessionId,
        runContext.payload,
        runContext.sessionState,
      ),
      hasTrustedManagedWorktreeBinding(
        runContext.runId,
        runContext.sessionState,
        runContext.payload,
        runContext.sessionId,
      ),
      // Lookup order is security-sensitive: exact run first; then the session
      // bridge required because the Environment run ID and engine run ID can
      // differ; finally the hosted MCP grant. Never make the session bridge
      // choose among multiple active tickets.
      this.executionTicketsByRun.get(runContext.runId) ??
        this.resolveUnambiguousSessionExecutionTicket(runContext.sessionId) ??
        this.hostedMcpScopes.get(readHostedMcpGrantId(runContext.payload) ?? "")
          ?.executionTicket,
    );
  }

  private resolveUnambiguousSessionExecutionTicket(
    sessionId: string,
  ): string | undefined {
    const tickets = this.executionTicketsBySession.get(sessionId);
    // Overlapping turns in one session must fail closed. Selecting either
    // ticket would break the run isolation this index exists to preserve.
    if (tickets?.size !== 1) return;
    return tickets.values().next().value;
  }
}

function isInternalOnlyRuntimeToolName(name: string): boolean {
  return name === "agent.spawn" || name.startsWith("delegate.");
}

async function annotateWorkspaceSkillRead(input: {
  toolName: string;
  input: unknown;
  output: unknown;
  runContext?: ToolRunContext | undefined;
  progress: Map<string, WorkspaceSkillReadProgress>;
}): Promise<AgentToolResult> {
  const wrapped = isAgentToolResult(input.output)
    ? input.output
    : buildAgentToolSuccessResult({
        toolName: input.toolName,
        input: input.input,
        output: input.output,
      });
  if (isFileTextReadToolName(input.toolName) === false) return wrapped;
  const request = asRecord(input.input);
  const result = asRecord(wrapped.auditRecord.output);
  if (result?.range === undefined) return wrapped;
  const range = asRecord(result.range);
  const requestedPath = normalizeSkillEvidencePath(request?.path);
  const resultPath = normalizeSkillEvidencePath(result.path);
  const catalog = asRecord(input.runContext?.payload)?.workspaceSkills;
  if (!Array.isArray(catalog)) return wrapped;
  const match = catalog.find((candidate) => {
    const skillFile = normalizeSkillEvidencePath(
      asRecord(candidate)?.skillFile,
    );
    return (
      skillFile !== undefined &&
      (skillFile === requestedPath || skillFile === resultPath)
    );
  });
  const skill = asRecord(match);
  const installationId =
    typeof skill?.installationId === "string"
      ? skill.installationId
      : undefined;
  const name = typeof skill?.name === "string" ? skill.name : undefined;
  const commitSha =
    typeof skill?.commitSha === "string" ? skill.commitSha : undefined;
  const contentDigest =
    typeof skill?.contentDigest === "string" ? skill.contentDigest : undefined;
  const skillFile =
    typeof skill?.skillFile === "string" ? skill.skillFile : undefined;
  if (!installationId || !name || !commitSha || !contentDigest || !skillFile)
    return wrapped;
  const runId = input.runContext?.runId;
  const sessionId = input.runContext?.sessionId;
  const revision =
    typeof result.revision === "string" ? result.revision : undefined;
  const startByte =
    typeof range?.startByte === "number" ? range.startByte : undefined;
  const endByte =
    typeof range?.endByte === "number" ? range.endByte : undefined;
  if (
    !runId ||
    !sessionId ||
    !revision ||
    startByte === undefined ||
    endByte === undefined
  )
    return wrapped;
  const progressKey = `${runId}\0${sessionId}\0${installationId}\0${skillFile}`;
  const previous = input.progress.get(progressKey);
  const isContiguous =
    startByte === 0 ||
    (previous !== undefined &&
      previous.revision === revision &&
      previous.nextOffsetBytes === startByte);
  if (!isContiguous) {
    input.progress.delete(progressKey);
    return wrapped;
  }
  if (result.complete !== true) {
    input.progress.set(progressKey, { revision, nextOffsetBytes: endByte });
    return wrapped;
  }
  input.progress.delete(progressKey);
  const workspace = asRecord(asRecord(input.runContext?.payload)?.workspace);
  const workspaceRoot =
    typeof workspace?.workspaceRoot === "string"
      ? workspace.workspaceRoot
      : undefined;
  if (!workspaceRoot) return wrapped;
  const validated = await validateWorkspaceSkillPackage(
    path.dirname(path.join(workspaceRoot, ...skillFile.split("/"))),
  );
  if (
    validated.contentDigest !== contentDigest ||
    validated.manifest.name !== name
  ) {
    throw createRuntimeFailure(
      "WORKSPACE_SKILL_INTEGRITY_FAILED",
      `Installed workspace skill '${name}' changed after the run snapshot was recorded.`,
      {
        subsystem: "workspace",
        classification: "security",
        recoverable: false,
        installationId,
        commitSha,
        expectedContentDigest: contentDigest,
        actualContentDigest: validated.contentDigest,
      },
    );
  }
  const annotated = {
    ...result,
    workspaceSkillProvenance: {
      installationId,
      name,
      commitSha,
      contentDigest,
      skillFile,
      loaded: true,
    },
  };
  return replaceAgentToolResultOutput(wrapped, annotated);
}

function normalizeSkillEvidencePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return;
  return value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
}

function resolveScopedRunContext(
  payload: unknown,
  fallback: ReadonlySet<string>,
  baseContext: SharedToolContext,
  runtime: RuntimeToolRunContext,
  trustedManagedWorktree: boolean,
  ephemeralExecutionTicket?: string | undefined,
): {
  allowlist: ReadonlySet<string>;
  builtInContext: SharedToolContext;
} {
  const orchestration = asRecord(asRecord(payload)?.orchestration);
  const runtimeAssembly = asRecord(orchestration?.runtimeAssembly);
  const toolAllowlist = Array.isArray(runtimeAssembly?.toolAllowlist)
    ? runtimeAssembly.toolAllowlist.filter(
        (value): value is string => typeof value === "string",
      )
    : undefined;
  const workspace = asRecord(asRecord(payload)?.workspace);
  const workspaceRoot =
    typeof workspace?.workspaceRoot === "string" &&
    workspace.workspaceRoot.trim().length > 0
      ? workspace.workspaceRoot
      : undefined;
  const effectiveWorkspaceRoot =
    workspaceRoot ?? baseContext.fileSystem?.workspaceRoot ?? process.cwd();
  const attachmentReadOnlyRoots = readAttachmentReadOnlyRoots(payload);
  const workspaceToolContext = {
    ...(typeof workspace?.appRoot === "string" &&
    workspace.appRoot.trim().length > 0
      ? { appRoot: workspace.appRoot.trim() }
      : {}),
    ...(typeof workspace?.packageManager === "string" &&
    workspace.packageManager.trim().length > 0
      ? { packageManager: workspace.packageManager.trim() }
      : {}),
    ...(asRecord(workspace?.commands) !== undefined
      ? {
          commands: asRecord(workspace?.commands) as Record<
            string,
            string | undefined
          >,
        }
      : {}),
  };
  const tenantId = readKestrelOneTenantId(payload);
  const contextGrantId = readKestrelOneContextGrantId(payload);
  const executionTicket = ephemeralExecutionTicket;
  const interactionMode = readInteractionMode(payload);
  const devShellSourceWriteApprovalGrants =
    readDevShellSourceWriteApprovalGrants(payload);
  const sourceWriteAuthority = resolveDevShellSourceWriteAuthority(
    workspace,
    trustedManagedWorktree,
  );
  const sourceWriteGuardAllowedWriteRoots =
    resolveDevShellSourceWriteAllowedWriteRoots(
      effectiveWorkspaceRoot,
      sourceWriteAuthority,
      trustedManagedWorktree,
    );
  const scopedBaseContext: SharedToolContext = {
    ...baseContext,
    runtime,
    ...(interactionMode !== undefined ? { interactionMode } : {}),
    ...(tenantId !== undefined ||
    contextGrantId !== undefined ||
    executionTicket !== undefined
      ? {
          kestrelOne: {
            ...(baseContext.kestrelOne ?? {}),
            ...(tenantId !== undefined ? { tenantId } : {}),
            ...(contextGrantId !== undefined ? { contextGrantId } : {}),
            ...(executionTicket !== undefined ? { executionTicket } : {}),
            ...(executionTicket !== undefined
              ? { executionRunId: readExecutionTicketRunId(executionTicket) }
              : {}),
          },
        }
      : {}),
    ...(Object.keys(workspaceToolContext).length > 0
      ? { workspace: workspaceToolContext }
      : {}),
    ...(devShellSourceWriteApprovalGrants.length > 0 ||
    trustedManagedWorktree ||
    sourceWriteAuthority !== undefined
      ? {
          devShell: {
            ...(baseContext.devShell ?? { enabled: false }),
            ...(sourceWriteAuthority !== undefined
              ? { sourceWriteAuthority }
              : {}),
            sourceWriteGuard: {
              ...(baseContext.devShell?.sourceWriteGuard ?? {}),
              ...(trustedManagedWorktree ? { managedWorktree: true } : {}),
              ...(sourceWriteGuardAllowedWriteRoots !== undefined
                ? { allowedWriteRoots: sourceWriteGuardAllowedWriteRoots }
                : {}),
              approvalGrants: [
                ...(baseContext.devShell?.sourceWriteGuard?.approvalGrants ??
                  []),
                ...devShellSourceWriteApprovalGrants,
              ],
            },
          },
        }
      : {}),
  };
  return {
    allowlist: toolAllowlist === undefined ? fallback : new Set(toolAllowlist),
    builtInContext: withDefaultFileSystemPolicy({
      ...scopedBaseContext,
      fileSystem: {
        workspaceRoot:
          effectiveWorkspaceRoot,
        tempRoots: scopedBaseContext.fileSystem?.tempRoots ?? [],
        readOnlyRoots: [
          ...(scopedBaseContext.fileSystem?.readOnlyRoots ?? []),
          ...attachmentReadOnlyRoots,
        ],
      },
    }),
  };
}

function readAttachmentReadOnlyRoots(payload: unknown): string[] {
  const record = asRecord(payload);
  const attachments = Array.isArray(record?.attachments)
    ? record.attachments
    : asRecord(record?.turn)?.attachments;
  if (Array.isArray(attachments) === false) return [];
  return [
    ...new Set(
      attachments.flatMap((attachment) => {
        const attachmentPath = asRecord(attachment)?.path;
        return typeof attachmentPath === "string" &&
          attachmentPath.trim().length > 0
          ? [path.dirname(path.resolve(attachmentPath))]
          : [];
      }),
    ),
  ];
}

function readExecutionTicketRunId(ticket: string): string | undefined {
  const payload = ticket.split(".")[1];
  if (!payload) return;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { runId?: unknown };
    return typeof decoded.runId === "string" && decoded.runId.trim()
      ? decoded.runId.trim()
      : undefined;
  } catch {
    return;
  }
}

function readInteractionMode(
  payload: unknown,
): "chat" | "plan" | "build" | undefined {
  const direct = asRecord(payload)?.interactionMode;
  if (direct === "chat" || direct === "plan" || direct === "build") {
    return direct;
  }
  const metadata = asRecord(asRecord(payload)?.metadata);
  const fromMetadata = metadata?.interactionMode;
  if (
    fromMetadata === "chat" ||
    fromMetadata === "plan" ||
    fromMetadata === "build"
  ) {
    return fromMetadata;
  }
  const orchestration = asRecord(asRecord(payload)?.orchestration);
  const fromOrchestration = orchestration?.interactionMode;
  return fromOrchestration === "chat" ||
    fromOrchestration === "plan" ||
    fromOrchestration === "build"
    ? fromOrchestration
    : undefined;
}

function resolveDevShellSourceWriteAuthority(
  workspace: Record<string, unknown> | undefined,
  trustedManagedWorktree: boolean,
): "source_write" | undefined {
  if (trustedManagedWorktree) {
    return "source_write";
  }
  if (workspace?.managedWorktreeRequired === false) {
    return "source_write";
  }
  return;
}

function resolveDevShellSourceWriteAllowedWriteRoots(
  workspaceRoot: string | undefined,
  sourceWriteAuthority: "source_write" | undefined,
  trustedManagedWorktree: boolean,
): string[] | undefined {
  if (
    sourceWriteAuthority !== "source_write" ||
    trustedManagedWorktree ||
    workspaceRoot === undefined
  ) {
    return;
  }
  return [workspaceRoot];
}

function resolveRuntimeToolRunContext(
  runId: string,
  sessionId: string,
  payload: unknown,
  sessionState: unknown,
): RuntimeToolRunContext {
  const payloadRecord = asRecord(payload);
  const orchestration = asRecord(payloadRecord?.orchestration);
  const metadata = asRecord(payloadRecord?.metadata);
  const projectContext =
    asRecord(payloadRecord?.projectContext) ??
    asRecord(metadata?.projectContext);
  const missionControl =
    asRecord(payloadRecord?.missionControl) ??
    asRecord(metadata?.missionControl);
  const projectId =
    asNonEmptyString(projectContext?.projectId) ??
    asNonEmptyString(missionControl?.projectId);
  const threadId =
    asNonEmptyString(orchestration?.threadId) ??
    asNonEmptyString(metadata?.threadId);
  const activeTaskId =
    asNonEmptyString(orchestration?.activeTaskId) ??
    asNonEmptyString(orchestration?.taskId) ??
    asNonEmptyString(metadata?.activeTaskId) ??
    asNonEmptyString(metadata?.taskId);
  const delegationId =
    asNonEmptyString(orchestration?.delegationId) ??
    asNonEmptyString(metadata?.delegationId);
  const rootDelegationId =
    asNonEmptyString(orchestration?.rootDelegationId) ??
    asNonEmptyString(metadata?.rootDelegationId);
  const delegationDepth =
    asFiniteNumber(orchestration?.delegationDepth) ??
    asFiniteNumber(metadata?.delegationDepth);
  const approvalId = readPendingApprovalId(sessionState);
  return {
    runId,
    sessionId,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(approvalId !== undefined ? { approvalId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(activeTaskId !== undefined ? { activeTaskId } : {}),
    ...(delegationId !== undefined ? { delegationId } : {}),
    ...(delegationDepth !== undefined ? { delegationDepth } : {}),
    ...(rootDelegationId !== undefined ? { rootDelegationId } : {}),
  };
}

function readPendingApprovalId(state: unknown): string | undefined {
  const stateRecord = asRecord(state);
  const pendingApproval =
    asRecord(asRecord(asRecord(stateRecord?.agent)?.exec)?.pendingApproval) ??
    asRecord(asRecord(asRecord(stateRecord?.react)?.exec)?.pendingApproval);
  return asNonEmptyString(pendingApproval?.approvalId);
}

function hasTrustedManagedWorktreeBinding(
  runId: string,
  state: unknown,
  payload: unknown,
  sessionId: string,
): boolean {
  const stateRecord = asRecord(state);
  const binding =
    asRecord(
      asRecord(asRecord(stateRecord?.agent)?.exec)?.managedWorktreeBinding,
    ) ??
    asRecord(
      asRecord(asRecord(stateRecord?.react)?.exec)?.managedWorktreeBinding,
    );
  if (binding?.status !== "bound") {
    return false;
  }
  const bindingSessionId = asNonEmptyString(binding.sessionId);
  if (bindingSessionId !== undefined && bindingSessionId !== sessionId) {
    return false;
  }
  const bindingRunId = asNonEmptyString(binding.runId);
  if (bindingRunId !== undefined && bindingRunId !== runId) {
    return false;
  }
  const leaseId = asNonEmptyString(binding.leaseId);
  if (leaseId === undefined) {
    return false;
  }
  const workspace = asRecord(asRecord(payload)?.workspace);
  return (
    workspace?.managedWorktree === true &&
    asNonEmptyString(workspace.workspaceRoot) ===
      asNonEmptyString(binding.worktreeRoot) &&
    asNonEmptyString(workspace.leaseId) === leaseId
  );
}

function readDevShellSourceWriteApprovalGrants(payload: unknown) {
  const orchestration = asRecord(asRecord(payload)?.orchestration);
  const grants = Array.isArray(orchestration?.devShellSourceWriteApprovalGrants)
    ? orchestration.devShellSourceWriteApprovalGrants
    : [];
  return grants.flatMap((item) => {
    const record = asRecord(item);
    const grantId = asNonEmptyString(record?.grantId);
    const command = asNonEmptyString(record?.command);
    const writablePaths = Array.isArray(record?.writablePaths)
      ? record.writablePaths.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
      : [];
    if (
      grantId === undefined ||
      command === undefined ||
      writablePaths.length === 0
    ) {
      return [];
    }
    return [
      {
        grantId,
        command,
        writablePaths,
        ...(asNonEmptyString(record?.cwd) !== undefined
          ? { cwd: asNonEmptyString(record?.cwd) }
          : {}),
        ...(asNonEmptyString(record?.expiresAt) !== undefined
          ? { expiresAt: asNonEmptyString(record?.expiresAt) }
          : {}),
      },
    ];
  });
}

function readKestrelOneTenantId(payload: unknown): string | undefined {
  const clientCapabilities = asRecord(asRecord(payload)?.clientCapabilities);
  const kestrelOne = asRecord(clientCapabilities?.kestrelOne);
  return (
    asNonEmptyString(kestrelOne?.tenantId) ??
    asNonEmptyString(kestrelOne?.organizationId)
  );
}

function readKestrelOneContextGrantId(payload: unknown): string | undefined {
  const clientCapabilities = asRecord(asRecord(payload)?.clientCapabilities);
  const kestrelOne = asRecord(clientCapabilities?.kestrelOne);
  return asNonEmptyString(kestrelOne?.contextGrantId);
}

function readHostedMcpGrantId(payload: unknown): string | undefined {
  return asNonEmptyString(asRecord(asRecord(payload)?.mcpContext)?.grantId);
}

function combineMcpSnapshots(
  base: McpStatusSnapshot,
  hosted: McpStatusSnapshot,
): McpStatusSnapshot {
  return {
    healthy: base.healthy && hosted.healthy,
    checkedAt:
      Date.parse(base.checkedAt) > Date.parse(hosted.checkedAt)
        ? base.checkedAt
        : hosted.checkedAt,
    servers: [
      ...base.servers.map((server) => ({ ...server })),
      ...hosted.servers.map((server) => ({ ...server })),
    ],
    tools: [
      ...base.tools.map((tool) => ({ ...tool })),
      ...hosted.tools.map((tool) => ({ ...tool })),
    ],
    ...((hosted.refreshDiagnostic ?? base.refreshDiagnostic) === undefined
      ? {}
      : {
          refreshDiagnostic: {
            ...(hosted.refreshDiagnostic ?? base.refreshDiagnostic)!,
          },
        }),
  };
}

const MCP_RESULT_NORMALIZER_IDS = new Set([
  "mcp:tool:envelope:v1",
  "mcp:resource:envelope:v1",
  "mcp:resource_template:envelope:v1",
  "mcp:prompt:envelope:v1",
]);

function resolveMcpResultNormalizer(
  normalizerId: string,
  toolName: string,
): PinnedToolExecutionV1["normalizer"] {
  if (!MCP_RESULT_NORMALIZER_IDS.has(normalizerId)) {
    throw createRuntimeFailure(
      "TOOL_RESULT_NORMALIZER_UNAVAILABLE",
      `Pinned MCP result normalizer '${normalizerId}' is unavailable.`,
      { recoverable: false, toolName },
    );
  }
  return (output: unknown) => ({ output });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" &&
    value !== null &&
    Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}

function readWorkflowRunAuthority(
  runContext: ToolRunContext | undefined,
): RunnerWorkflowRunAuthorityV1 | undefined {
  const value = asRecord(asRecord(runContext?.payload)?.workflowRunAuthority);
  if (value === undefined) return undefined;
  if (
    value.version !== "runner_workflow_run_authority_v2" ||
    asRecord(value.manifest)?.version !== "workflow_capability_manifest_v2"
  ) {
    throw createRuntimeFailure(
      "WORKFLOW_RUN_AUTHORITY_INVALID",
      "Workflow run authority is malformed.",
      { recoverable: false, subsystem: "tooling" },
    );
  }
  return value as unknown as RunnerWorkflowRunAuthorityV1;
}

export function authorizeWorkflowRunToolCall(input: {
  runContext?: ToolRunContext | undefined;
  toolId: string;
  toolFamily?: string | undefined;
  descriptorContractRevision: string;
  effectiveInput: Record<string, unknown>;
  execCommandContinuation: boolean;
}): boolean {
  const authority = readWorkflowRunAuthority(input.runContext);
  if (authority === undefined) return false;
  if (input.toolFamily === "runtime") return true;
  if (authority.activeStep.kind === "kestrel") {
    const native = authority.manifest.nativeTools.find(entry => entry.toolId === input.toolId);
    if (native?.descriptorContractRevision === input.descriptorContractRevision) return true;
  }

  if (authority.activeStep.kind !== "action") throw createRuntimeFailure("WORKFLOW_RUN_AUTHORITY_EXCEEDED", `Workflow activation does not authorize tool '${input.toolId}' in this Kestrel step.`, { recoverable: false, subsystem: "tooling", toolName: input.toolId });
  const resolvedActionInput = authority.activeStep.resolvedInput;
  const matchingIdentity = authority.manifest.actions.filter(
    (entry) =>
      entry.nodeId === authority.activeStep.nodeId &&
      entry.toolId === input.toolId &&
      entry.descriptorContractRevision === input.descriptorContractRevision,
  );
  const allowed = matchingIdentity.some((entry) => {
    if (input.toolId === "exec_command") {
      if (input.execCommandContinuation) return true;
      const scope = entry.rememberedApprovalScope;
      return scope.kind === "exec_command_exact" &&
        scope.command === input.effectiveInput.command &&
        scope.cwd === input.effectiveInput.cwd &&
        scope.envMode === input.effectiveInput.envMode &&
        JSON.stringify(scope.envNames) === JSON.stringify(
          Array.isArray(input.effectiveInput.envNames)
            ? [...input.effectiveInput.envNames].sort()
            : [],
        );
    }
    return hashCanonical(resolvedActionInput) === hashCanonical(input.effectiveInput);
  });
  if (allowed) return true;

  throw createRuntimeFailure(
    "WORKFLOW_RUN_AUTHORITY_EXCEEDED",
    `Workflow activation does not authorize tool '${input.toolId}' with this input.`,
    {
      recoverable: false,
      subsystem: "tooling",
      toolName: input.toolId,
      workflowId: authority.workflowId,
      workflowVersionId: authority.workflowVersionId,
      workflowRunId: authority.workflowRunId,
    },
  );
}

function resolveBlockedResumeScope(runContext: ToolRunContext | undefined):
  | {
      runId: string;
      mcpContext?: Record<string, unknown> | undefined;
    }
  | undefined {
  const payload = asRecord(runContext?.payload);
  if (payload?.resumeBlockedRun !== true) {
    return;
  }
  const metadata = asRecord(payload.metadata);
  const orchestration = asRecord(payload.orchestration);
  const blockedToolScope = asRecord(metadata?.blockedToolScope);
  const candidates = [
    metadata?.blockedRunId,
    orchestration?.blockedRunId,
    blockedToolScope?.runId,
  ].flatMap((value) =>
    typeof value === "string" && value.trim().length > 0 ? [value.trim()] : [],
  );
  const distinct = [...new Set(candidates)];
  if (distinct.length !== 1) {
    return;
  }
  const currentMcpContext = asRecord(payload.mcpContext);
  const blockedMcpContext = asRecord(blockedToolScope?.mcpContext);
  if (
    (currentMcpContext === undefined) !== (blockedMcpContext === undefined) ||
    (currentMcpContext !== undefined &&
      blockedMcpContext !== undefined &&
      hashCanonical(withoutGrantId(currentMcpContext)) !==
        hashCanonical(withoutGrantId(blockedMcpContext)))
  ) {
    return;
  }
  return {
    runId: distinct[0]!,
    ...(blockedMcpContext === undefined
      ? {}
      : { mcpContext: blockedMcpContext }),
  };
}

function withoutGrantId(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const { grantId: _grantId, ...stableContext } = context;
  return stableContext;
}

function preparedExecutionKey(prepared: PreparedToolCallV1): string {
  return `${prepared.runId}\0${prepared.sessionId}\0${prepared.callId}`;
}

function preparedExecutionOwnerKey(runId: string, sessionId: string): string {
  return `${runId}\0${sessionId}`;
}

function validatePinnedInput(
  toolName: string,
  value: unknown,
  validator: ValidateFunction,
  builtIn: boolean,
): Record<string, unknown> {
  if (validator(value) !== true) {
    if (builtIn) {
      throw createBuiltInSchemaValidationError(
        toolName,
        value,
        validator.errors ?? [],
      );
    }
    throw createRuntimeFailure(
      "TOOL_INPUT_SCHEMA_FAILED",
      `Tool '${toolName}' input failed its pinned descriptor contract.`,
      {
        subsystem: "tooling",
        classification: "schema",
        recoverable: false,
        toolName,
        validationErrors: (validator.errors ?? []).map((error) => ({
          field: readAjvErrorField(error),
          instancePath: error.instancePath,
          schemaPath: error.schemaPath,
          keyword: error.keyword,
          message: error.message,
        })),
      },
    );
  }
  const record = asRecord(value);
  if (record === undefined) {
    throw createRuntimeFailure(
      "TOOL_INPUT_INVALID",
      `Tool '${toolName}' input must be an object.`,
      { recoverable: false, toolName },
    );
  }
  return structuredClone(record);
}

function createBuiltInSchemaValidationError(
  toolName: string,
  input: unknown,
  errors: ErrorObject[],
): RuntimeFailure {
  const inputRecord = asRecord(input);
  if (
    toolName === "fs.read_text" &&
    (Object.hasOwn(inputRecord ?? {}, "offsetBytes") ||
      Object.hasOwn(inputRecord ?? {}, "expectedRevision"))
  ) {
    return createToolInputError(
      toolName,
      "fs.read_text only reads the first page. Continue with fs.read_text_page using the exact returned nextPage.input.",
      {
        nextSuggestedAction:
          "Call fs.read_text_page with the exact nextPage.input returned by fs.read_text.",
        validationErrors: errors.map((error) => ({
          instancePath: error.instancePath,
          schemaPath: error.schemaPath,
          keyword: error.keyword,
          message: error.message,
        })),
      },
    );
  }
  const firstError = errors[0];
  const field =
    firstError === undefined ? "input" : readAjvErrorField(firstError);
  const expected =
    firstError === undefined
      ? "input satisfying tool schema"
      : readAjvErrorExpectation(firstError);
  const invalidValues =
    firstError === undefined
      ? []
      : readAjvErrorInvalidValues(input, firstError);
  const location = field === "input" ? "input" : `input.${field}`;
  return createToolInputError(
    toolName,
    `Invalid ${toolName} ${location}. Expected ${expected}.`,
    {
      field,
      expected,
      ...(invalidValues.length > 0 ? { invalidValues } : {}),
      validationErrors: errors.map((error) => ({
        instancePath: error.instancePath,
        schemaPath: error.schemaPath,
        keyword: error.keyword,
        message: error.message,
      })),
    },
  );
}

function readAjvErrorField(error: ErrorObject): string {
  if (
    error.keyword === "required" &&
    typeof error.params.missingProperty === "string"
  ) {
    return error.params.missingProperty;
  }
  if (
    error.keyword === "additionalProperties" &&
    typeof error.params.additionalProperty === "string"
  ) {
    const parent = jsonPointerToField(error.instancePath);
    return parent === "input"
      ? error.params.additionalProperty
      : `${parent}.${error.params.additionalProperty}`;
  }
  return jsonPointerToField(error.instancePath);
}

function readAjvErrorExpectation(error: ErrorObject): string {
  switch (error.keyword) {
    case "minimum":
      return `value >= ${String(error.params.limit)}`;
    case "maximum":
      return `value <= ${String(error.params.limit)}`;
    case "minLength":
      return `string length >= ${String(error.params.limit)}`;
    case "maxLength":
      return `string length <= ${String(error.params.limit)}`;
    case "minItems":
      return `array length >= ${String(error.params.limit)}`;
    case "maxItems":
      return `array length <= ${String(error.params.limit)}`;
    case "enum":
      return Array.isArray(error.params.allowedValues)
        ? `one of ${error.params.allowedValues.map(String).join(", ")}`
        : "one of the allowed values";
    case "type":
      return typeof error.params.type === "string"
        ? `type ${error.params.type}`
        : "the expected JSON type";
    case "required":
      return "required field";
    case "additionalProperties":
      return "no unknown fields";
    default:
      return error.message ?? `input satisfying ${error.keyword}`;
  }
}

function readAjvErrorInvalidValues(
  input: unknown,
  error: ErrorObject,
): unknown[] {
  if (error.keyword === "required") return [];
  if (
    error.keyword === "additionalProperties" &&
    typeof error.params.additionalProperty === "string"
  ) {
    const value = readValueAtJsonPointer(
      input,
      `${error.instancePath}/${encodeJsonPointerSegment(error.params.additionalProperty)}`,
    );
    return value === undefined ? [] : [value];
  }
  const value = readValueAtJsonPointer(input, error.instancePath);
  return value === undefined ? [] : [value];
}

function jsonPointerToField(pointer: string): string {
  return pointer.length === 0
    ? "input"
    : pointer.slice(1).split("/").map(decodeJsonPointerSegment).join(".");
}

function encodeJsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function readValueAtJsonPointer(input: unknown, pointer: string): unknown {
  if (pointer.length === 0) return input;
  let current: unknown = input;
  for (const segment of pointer
    .slice(1)
    .split("/")
    .map(decodeJsonPointerSegment)) {
    if (typeof current !== "object" || current === null) return;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (Number.isInteger(index) === false || index < 0) return;
      current = current[index];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRuntimeBuiltInTool(
  name: string,
  capabilities: Map<string, CapabilityManifestItem>,
): boolean {
  const capability = capabilities.get(name);
  return capability?.freshnessClass === "runtime";
}

async function prepareDesktopGmailMutationInput(input: {
  toolName: string;
  input: Record<string, unknown>;
  context: SharedToolContext;
}): Promise<Record<string, unknown>> {
  const operation = input.toolName === "google_workspace.send_gmail"
    ? "gmail.messages.send" as const
    : input.toolName === "google_workspace.reply_gmail"
      ? "gmail.messages.reply" as const
      : undefined;
  if (operation === undefined) return input.input;
  const threadId = input.context.runtime?.threadId ?? input.context.runtime?.sessionId;
  if (!threadId?.trim()) {
    throw createRuntimeFailure(
      "GOOGLE_WORKSPACE_THREAD_REQUIRED",
      "Gmail sends require an active Desktop Thread.",
      { subsystem: "tooling", classification: "configuration", recoverable: true, toolName: input.toolName },
    );
  }
  const prepare = input.context.googleWorkspaceService?.prepareApprovalInput;
  if (prepare === undefined) {
    throw createRuntimeFailure(
      "GOOGLE_WORKSPACE_GMAIL_PREPARATION_UNAVAILABLE",
      "Desktop Gmail exact-approval preparation is unavailable.",
      { subsystem: "tooling", classification: "configuration", recoverable: true, toolName: input.toolName },
    );
  }
  return await prepare(operation, input.input, { threadId });
}

function isBuiltInToolDisabledByContext(
  name: string,
  context: SharedToolContext,
): boolean {
  if (name === "code.execute") {
    return context.codeMode?.enabled !== true;
  }
  if (name.startsWith("dev.shell.")) {
    return context.devShell?.enabled !== true;
  }
  if (isBrowserToolName(name)) {
    return !isConformingBrowserServicePort(context.browserService);
  }

  return false;
}

function toToolRuntimeStatus(
  status: McpStatusSnapshot,
  context: SharedToolContext,
): ToolRuntimeStatus {
  return {
    healthy: status.healthy,
    checkedAt: status.checkedAt,
    providers: {
      mcp: status,
      tools: context.providerConfigurations?.list() ?? [],
      browser: {
        contractVersion: BROWSER_SERVICE_PORT_VERSION,
        ready: isConformingBrowserServicePort(context.browserService),
      },
    },
  };
}
