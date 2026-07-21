import type {
  GuardrailConfig,
  ManagedTaskWorktreeService,
  NormalizedOutput,
  StepContractRegistry,
  StepContractValidator,
  StepAgent,
} from "./contracts/execution.js";
import type { ModelGateway, ToolGateway, ToolRuntimeStatus } from "./contracts/model-io.js";
import type { RunEventListener, RuntimeEvent } from "./contracts/events.js";
import type { RuntimeWorkspaceCheckpointService, SessionStore } from "./contracts/store.js";
import { ExecutionEngine } from "../engine/ExecutionEngine.js";
import { EffectRegistry } from "../effects/EffectRegistry.js";
import { InlineEffectRunner } from "../effects/EffectRunner.js";
import { createExecuteToolCallHandler } from "../effects/handlers/executeToolCall.js";
import { sendMessageHandler } from "../effects/handlers/sendMessage.js";
import { testNoopHandler } from "../effects/handlers/testNoop.js";
import { NoopRuntimeEventDispatcher, type RuntimeEventDispatcher } from "../events/InlineDispatcher.js";
import { InlineOutbox } from "../events/Outbox.js";
import {
  FanoutProgressReporter,
  FanoutReasoningReporter,
  FanoutRunLogger,
  FanoutConsoleReporter,
  NoopConsoleReporter,
  NoopProgressReporter,
  NoopReasoningReporter,
  type ConsoleListener,
  type ProgressListener,
  type ReasoningListener,
  type RunLogListener,
  StructuredRunLogger,
} from "../logging/RunLogger.js";
import { DefaultOutputNormalizer } from "../normalize/OutputNormalizer.js";
import { InMemoryStepRegistry } from "../steps/StepRegistry.js";
import { InMemoryStepContractRegistry } from "../engine/StepContractRegistry.js";
import { RunReplayService, type ReplayQuery, type ReplayResult } from "../replay/RunReplayService.js";
import type { HeapDiagnosticsReporter } from "../runtime/heapDiagnostics.js";
import type { ProviderReasoningVault } from "../runtime/ProviderReasoningVault.js";

export interface KestrelOptions {
  store: SessionStore;
  modelGateway: ModelGateway;
  providerReasoningVault?: ProviderReasoningVault | undefined;
  toolGateway: ToolGateway;
  workspaceCheckpointService?: RuntimeWorkspaceCheckpointService | undefined;
  managedTaskWorktreeService?: ManagedTaskWorktreeService | undefined;
  guardrails?: Partial<GuardrailConfig>;
  dispatcher?: RuntimeEventDispatcher;
  runLogListener?: RunLogListener;
  progressListener?: ProgressListener;
  consoleListener?: ConsoleListener;
  reasoningListener?: ReasoningListener;
  runEventListener?: RunEventListener;
  stepContractRegistry?: StepContractRegistry;
  heapDiagnostics?: HeapDiagnosticsReporter | undefined;
}

export class Kestrel {
  private readonly store: SessionStore;
  private readonly toolGateway: ToolGateway;
  private readonly registry = new InMemoryStepRegistry();
  private readonly stepContractRegistry = new InMemoryStepContractRegistry();
  private readonly effectRegistry = new EffectRegistry();
  private readonly engine: ExecutionEngine;
  private readonly managedTaskWorktreeService: ManagedTaskWorktreeService | undefined;
  private readonly outbox: InlineOutbox;
  private readonly replayService: RunReplayService;
  private readonly providerReasoningVault: ProviderReasoningVault | undefined;

  constructor(options: KestrelOptions) {
    this.store = options.store;
    this.toolGateway = options.toolGateway;
    this.managedTaskWorktreeService = options.managedTaskWorktreeService;
    this.providerReasoningVault = options.providerReasoningVault;

    const executeToolCallHandler = createExecuteToolCallHandler(this.toolGateway);
    this.effectRegistry.register("send_message", sendMessageHandler);
    this.effectRegistry.register("assistant.respond", sendMessageHandler);
    this.effectRegistry.register("test_noop", testNoopHandler);
    this.effectRegistry.register("test.noop", testNoopHandler);
    this.effectRegistry.register("execute_tool_call", executeToolCallHandler);
    this.effectRegistry.register("tool.execute", executeToolCallHandler);

    const baseRunLogger = new StructuredRunLogger(this.store);
    const runLogger =
      options.runLogListener === undefined
        ? baseRunLogger
        : new FanoutRunLogger(baseRunLogger, options.runLogListener);
    const progressReporter =
      options.progressListener === undefined
        ? new NoopProgressReporter()
        : new FanoutProgressReporter(new NoopProgressReporter(), options.progressListener);
    const consoleReporter =
      options.consoleListener === undefined
        ? undefined
        : new FanoutConsoleReporter(new NoopConsoleReporter(), options.consoleListener);
    const reasoningReporter =
      options.reasoningListener === undefined
        ? new NoopReasoningReporter()
        : new FanoutReasoningReporter(new NoopReasoningReporter(), options.reasoningListener);
    const outbox = new InlineOutbox(
      this.store,
      options.dispatcher ?? new NoopRuntimeEventDispatcher(),
    );

    this.outbox = outbox;
    this.replayService = new RunReplayService(this.store);

    this.engine = new ExecutionEngine(
      {
        store: this.store,
        registry: this.registry,
        stepContractRegistry: options.stepContractRegistry ?? this.stepContractRegistry,
        toolGateway: this.toolGateway,
        ...(options.workspaceCheckpointService !== undefined
          ? { workspaceCheckpointService: options.workspaceCheckpointService }
          : {}),
        ...(options.managedTaskWorktreeService !== undefined
          ? { managedTaskWorktreeService: options.managedTaskWorktreeService }
          : {}),
        modelGateway: options.modelGateway,
        ...(options.providerReasoningVault !== undefined
          ? { providerReasoningVault: options.providerReasoningVault }
          : {}),
        effectRunner: new InlineEffectRunner(this.store, this.effectRegistry),
        outbox,
        runLogger,
        progressReporter,
        ...(consoleReporter !== undefined ? { consoleReporter } : {}),
        reasoningReporter,
        ...(options.runEventListener !== undefined ? { runEventListener: options.runEventListener } : {}),
        ...(options.heapDiagnostics !== undefined ? { heapDiagnostics: options.heapDiagnostics } : {}),
        outputNormalizer: new DefaultOutputNormalizer(),
      },
      options.guardrails,
    );
  }

  registerStep(name: string, step: StepAgent): void {
    this.registry.register(name, step);
  }

  registerStepContract(name: string, validator: StepContractValidator): void {
    this.stepContractRegistry.register(name, validator);
  }

  async run(
    event: RuntimeEvent,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<NormalizedOutput> {
    return this.engine.run(event, options);
  }

  async getSession(sessionId: string) {
    return this.store.getSession(sessionId);
  }

  async updateManagedWorktreeBinding(
    sessionId: string,
    binding: import("../workspace/ManagedTaskWorktreeService.js").ManagedTaskWorktreeBinding | undefined,
  ) {
    const session = await this.store.getSession(sessionId);
    if (session === null) {
      throw new Error(`Session '${sessionId}' does not exist.`);
    }
    const agent = typeof session.state.agent === "object" && session.state.agent !== null
      ? session.state.agent as Record<string, unknown>
      : {};
    const exec = typeof agent.exec === "object" && agent.exec !== null
      ? agent.exec as Record<string, unknown>
      : {};
    const nextAgent = {
      ...agent,
      exec: {
        ...exec,
        managedWorktreeBinding: binding,
      },
    };
    if (this.store.patchSessionState === undefined) {
      throw new Error("Session store does not support managed worktree binding updates.");
    }
    return this.store.patchSessionState({
      sessionId,
      expectedVersion: session.version,
      reason: binding === undefined ? "managed_worktree_cleanup" : "managed_worktree_cleanup_rollback",
      statePatch: { agent: nextAgent },
    });
  }

  async cancelActiveRun(sessionId: string): Promise<{ runId?: string | undefined }> {
    return this.engine.cancelActiveRun(sessionId);
  }

  async getRetainedProviderReasoning(input: { runId: string; sessionId: string; actorRole: string; actorId?: string | undefined }) {
    if (this.providerReasoningVault === undefined) {
      throw new Error("Provider reasoning retention is unavailable because the encrypted vault is not configured");
    }
    return this.providerReasoningVault.readRetainedForAdmin(input);
  }

  async deleteRetainedProviderReasoning(input: { runId: string; sessionId: string; actorRole: string; actorId?: string | undefined }) {
    if (this.providerReasoningVault === undefined) {
      throw new Error("Provider reasoning retention is unavailable because the encrypted vault is not configured");
    }
    return this.providerReasoningVault.deleteRetainedForAdmin(input);
  }

  getProviderReasoningVaultStatus() {
    return this.providerReasoningVault?.status() ?? {
      ready: false as const,
      keyVersion: 0,
      keySource: "unavailable" as const,
    };
  }

  async getToolRuntimeStatus(): Promise<ToolRuntimeStatus> {
    if (this.toolGateway.getRuntimeStatus === undefined) {
      return defaultToolRuntimeStatus();
    }

    return this.toolGateway.getRuntimeStatus();
  }

  async refreshToolRuntime(): Promise<ToolRuntimeStatus> {
    if (this.toolGateway.refreshRuntime === undefined) {
      return this.getToolRuntimeStatus();
    }

    return this.toolGateway.refreshRuntime();
  }

  getManagedTaskWorktreeService(): ManagedTaskWorktreeService | undefined {
    return this.managedTaskWorktreeService;
  }

  async replayUndeliveredOutbox(limit = 100): Promise<number> {
    const events = await this.store.listUndeliveredOutbox(limit);
    const uniqueRunIds = [...new Set(events.map((event) => event.runId))];
    for (const runId of uniqueRunIds) {
      await this.outbox.dispatchInline(runId);
    }

    return uniqueRunIds.length;
  }

  async getReplay(input: ReplayQuery): Promise<ReplayResult> {
    return this.replayService.replay(input);
  }
}

function defaultToolRuntimeStatus(): ToolRuntimeStatus {
  return {
    healthy: true,
    checkedAt: new Date().toISOString(),
    providers: {},
  };
}
