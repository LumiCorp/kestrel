import { createHash, randomUUID } from "node:crypto";

import type { TuiProfile } from "../../cli/contracts.js";
import type {
  RunEvent,
} from "../kestrel/contracts/events.js";
import type {
  ContextCheckpointRecord,
  ContextSummaryArtifactRecord,
  ThreadRecord,
} from "../kestrel/contracts/orchestration.js";
import type { NormalizedOutput } from "../kestrel/contracts/execution.js";
import type {
  ReplayStore,
  SessionRepository,
} from "../kestrel/contracts/store.js";
import type { DelegationServicePort } from "../../tools/contracts.js";
import { buildRuntimeIdentityMetadata } from "../profile/runtimeProfile.js";
import {
  resolveAllowedToolClasses,
  type ExecutionPolicyOverride,
} from "../mode/contracts.js";
import {
  asRuntimeError,
  contextCheckpointPendingFailure,
  createRuntimeFailure,
  delegationSupervisorUnavailableFailure,
  threadNotFoundFailure,
} from "../runtime/RuntimeFailure.js";
import { AssemblyCatalog } from "./AssemblyCatalog.js";
import { AssemblyPolicyEvaluator } from "./AssemblyPolicyEvaluator.js";
import { ContextPolicyManager, type ContextStructuredSummaryGenerator } from "./ContextPolicyManager.js";
import { DelegationSupervisor, type DelegationTaskUpdate } from "./DelegationSupervisor.js";
import { InteractionManager } from "./InteractionManager.js";
import { OperatorControlPlane } from "./OperatorControlPlane.js";
import { RuntimeComposer } from "./RuntimeComposer.js";
import {
  buildSupervisionSummary,
  classifyFanIn,
  defaultSupervisionGroupId,
  fanInCheckpointId,
  latestFanInDisposition,
  readSupervisionPolicy,
  toSupervisionChildSummary,
  updateDelegationOutcomePolicy,
} from "./Supervision.js";
import { listPendingSteers, removePendingSteer } from "./SteeringQueue.js";
import { TurnOrchestrator, mergeSubmittedHistoryMetadata } from "./TurnOrchestrator.js";
import type {
  AssemblyBundleRecord,
  ChildThreadBudget,
  DelegationRequest,
  FanInDispositionSummary,
  ReplyToRequestInput,
  ResumeBlockedTurnInput,
  SubmitTurnInput,
  SubmitTurnResult,
  SteerThreadResult,
  SupervisionChildSummary,
  SupervisionSummary,
  SupersedeChildThreadInput,
  ThreadAssemblyRecord,
  TurnExecutionResult,
  ThreadRuntimeEvent,
  ThreadRuntimePort,
  ThreadRuntimeSubscription,
  ThreadStatusSnapshot,
  TurnExecutor,
} from "./contracts.js";

export interface ThreadRuntimeOptions {
  sessionStore: SessionRepository;
  orchestrationStore?: ReplayStore | undefined;
  executor: TurnExecutor;
  profile?: TuiProfile | undefined;
  onTaskUpdate?: ((update: DelegationTaskUpdate) => void) | undefined;
  structuredSummaryGenerator?: ContextStructuredSummaryGenerator | undefined;
}

export class ThreadRuntime implements ThreadRuntimePort {
  private readonly sessionStore: SessionRepository;
  private readonly store: ReplayStore;
  private readonly interactionManager: InteractionManager;
  private readonly contextPolicyManager: ContextPolicyManager;
  private readonly turnOrchestrator: TurnOrchestrator;
  private readonly assemblyCatalog: AssemblyCatalog;
  private readonly assemblyPolicyEvaluator: AssemblyPolicyEvaluator;
  private readonly runtimeComposer: RuntimeComposer;
  private readonly operatorControlPlane: OperatorControlPlane;
  private readonly profile?: TuiProfile | undefined;
  private readonly delegationSupervisor?: DelegationSupervisor | undefined;
  private readonly listeners = new Set<(event: ThreadRuntimeEvent) => void>();
  private readonly pendingSteerProcessors = new Set<string>();

  constructor(options: ThreadRuntimeOptions) {
    this.sessionStore = options.sessionStore;
    this.store = options.orchestrationStore ?? (options.sessionStore as ReplayStore);
    this.profile = options.profile;
    this.interactionManager = new InteractionManager(this.store);
    this.contextPolicyManager = new ContextPolicyManager(this.store, {
      ...(options.structuredSummaryGenerator !== undefined
        ? { structuredSummaryGenerator: options.structuredSummaryGenerator }
        : {}),
    });
    this.assemblyCatalog = new AssemblyCatalog({
      store: this.store,
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
    });
    this.assemblyPolicyEvaluator = new AssemblyPolicyEvaluator();
    this.runtimeComposer = new RuntimeComposer({
      store: this.store,
      catalog: this.assemblyCatalog,
      policyEvaluator: this.assemblyPolicyEvaluator,
    });
    this.operatorControlPlane = new OperatorControlPlane({
      store: this.store,
      runtime: {
        getThreadStatus: (threadId) => this.getThreadStatus(threadId),
        replyToRequest: (input) => this.replyToRequest(input),
        submitTurn: (input) => this.submitTurn(input),
        spawnDelegation: (input) => this.spawnDelegation(input),
      },
    });
    this.turnOrchestrator = new TurnOrchestrator({
      executor: options.executor,
      store: this.store,
      interactionManager: this.interactionManager,
      contextPolicyManager: this.contextPolicyManager,
    });
    if (options.profile !== undefined) {
      this.delegationSupervisor = new DelegationSupervisor({
        profile: options.profile,
        runtimeStore: this.store,
        orchestrationStore: this.store,
        submitChildTurn: (input) => this.submitTurn(input),
        startChildThread: async (input) =>
          this.startThread({
            title: input.title,
            parentThreadId: input.parentThreadId,
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          }),
        onTaskUpdate: options.onTaskUpdate,
        onDelegationUpdated: async ({ record, finalizedPayload }) => {
          await this.handleDelegationUpdated(record, finalizedPayload);
        },
      });
    }
  }

  getDelegationService(): DelegationServicePort | undefined {
    return this.delegationSupervisor;
  }

  async startThread(input: {
    threadId?: string | undefined;
    sessionId?: string | undefined;
    title: string;
    parentThreadId?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<ThreadRecord> {
    const threadId = input.threadId ?? input.sessionId ?? `thread-${randomUUID()}`;
    const sessionId = input.sessionId ?? threadId;
    const now = new Date().toISOString();
    await this.sessionStore.ensureSession(sessionId);
    const existing = await this.store.getThread(threadId);
    const thread: ThreadRecord = existing ?? {
      threadId,
      sessionId,
      title: input.title,
      status: "IDLE",
      ...(input.parentThreadId !== undefined ? { parentThreadId: input.parentThreadId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.upsertThread(thread);
    const composedAssembly = await this.runtimeComposer.composeThreadAssembly({
      thread,
      cause: "thread_start",
    });
    const threadWithIdentity = this.applyRuntimeIdentityToThread(thread, composedAssembly.bundle);
    if (threadWithIdentity !== thread) {
      await this.store.upsertThread(threadWithIdentity);
    }
    this.emit("thread.started", thread.threadId, {
      sessionId: thread.sessionId,
      title: thread.title,
    });
    return threadWithIdentity;
  }

  async ensureMainThreadForSession(input: {
    sessionId: string;
    title?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<ThreadRecord> {
    const threads = await this.store.listThreads({ sessionId: input.sessionId });
    const rootThreads = threads.filter((thread) => thread.parentThreadId === undefined);
    const explicitMainThreads = rootThreads.filter((thread) => readThreadMainRole(thread) === true);

    if (explicitMainThreads.length > 1) {
      throw createRuntimeFailure(
        "THREAD_MAIN_RESOLUTION_FAILED",
        `Session '${input.sessionId}' has multiple canonical main threads.`,
        {
          sessionId: input.sessionId,
          threadIds: explicitMainThreads.map((thread) => thread.threadId),
        },
      );
    }
    if (explicitMainThreads.length === 1) {
      return explicitMainThreads[0] as ThreadRecord;
    }
    if (rootThreads.length === 1) {
      return rootThreads[0] as ThreadRecord;
    }
    if (rootThreads.length > 1) {
      throw createRuntimeFailure(
        "THREAD_MAIN_RESOLUTION_FAILED",
        `Session '${input.sessionId}' has multiple root threads and no canonical main thread.`,
        {
          sessionId: input.sessionId,
          threadIds: rootThreads.map((thread) => thread.threadId),
        },
      );
    }

    return this.startThread({
      threadId: canonicalMainThreadId(input.sessionId),
      sessionId: input.sessionId,
      title: input.title ?? input.sessionId,
      metadata: {
        ...(input.metadata ?? {}),
        mainThread: true,
      },
    });
  }

  async submitTurn(input: SubmitTurnInput): Promise<SubmitTurnResult> {
    const thread = await this.requireThread(input.threadId);
    const submittedMetadata = input.metadata;
    const submittedTurnId = readNonEmptyString(submittedMetadata?.turnId);
    const activeTurnId = readNonEmptyString(thread.metadata?.activeTurnId);
    const turnId =
      submittedTurnId ??
      (input.resumeBlockedRun === true ? activeTurnId : undefined) ??
      `turn-${randomUUID()}`;
    const turnStartedAt = new Date().toISOString();
    const latestSummary = (await this.store.listContextSummaryArtifacts(thread.threadId))[0];
    const turnMetadata = {
      ...(submittedMetadata ?? {}),
      ...(latestSummary !== undefined ? { authoritativeContextSummary: latestSummary } : {}),
      turnId,
      activeTurnId: turnId,
    };
    let mergedMetadata = mergeSubmittedHistoryMetadata(thread.metadata, turnMetadata) ?? {
      ...(thread.metadata ?? {}),
      ...turnMetadata,
    };
    let activeThread: ThreadRecord =
      input.metadata === undefined && thread.metadata?.activeTurnId === turnId
        ? thread
        : {
            ...thread,
            metadata: mergedMetadata,
            updatedAt: new Date().toISOString(),
          };
    if (activeThread !== thread) {
      await this.store.upsertThread(activeThread);
    }
    const existingTurn = await this.store.getConversationTurn?.(turnId);
    await this.store.upsertConversationTurn?.({
      turnId,
      threadId: activeThread.threadId,
      sessionId: activeThread.sessionId,
      ...(existingTurn?.rootRunId !== undefined ? { rootRunId: existingTurn.rootRunId } : {}),
      ...(existingTurn?.activeRunId !== undefined ? { activeRunId: existingTurn.activeRunId } : {}),
      ...(existingTurn?.terminalRunId !== undefined ? { terminalRunId: existingTurn.terminalRunId } : {}),
      ...(existingTurn?.terminalStatus !== undefined ? { terminalStatus: existingTurn.terminalStatus } : {}),
      status: "RUNNING",
      initialEventType: existingTurn?.initialEventType ?? input.eventType,
      startedAt: existingTurn?.startedAt ?? turnStartedAt,
      updatedAt: turnStartedAt,
      metadata: {
        ...(existingTurn?.metadata ?? {}),
        interactionMode: input.interactionMode,
        actSubmode: input.actSubmode,
      },
    });
    await this.resolveSubmitGateCheckpoints(activeThread);
    const resolvedLatestSummary = (await this.store.listContextSummaryArtifacts(activeThread.threadId))[0];
    if (resolvedLatestSummary !== undefined && resolvedLatestSummary.artifactId !== latestSummary?.artifactId) {
      mergedMetadata = mergeSubmittedHistoryMetadata(activeThread.metadata, {
        authoritativeContextSummary: resolvedLatestSummary,
        turnId,
        activeTurnId: turnId,
      }) ?? {
        ...(activeThread.metadata ?? {}),
        authoritativeContextSummary: resolvedLatestSummary,
        turnId,
        activeTurnId: turnId,
      };
      activeThread = {
        ...activeThread,
        metadata: mergedMetadata,
        updatedAt: new Date().toISOString(),
      };
      await this.store.upsertThread(activeThread);
    }
    const assembly = await this.runtimeComposer.composeThreadAssembly({
      thread: activeThread,
      cause: "turn_start",
    });
    this.emit("thread.turn_submitted", activeThread.threadId, {
      eventType: input.eventType,
    });
    const result = await this.turnOrchestrator.execute(activeThread, {
      ...input,
      metadata: {
        ...mergedMetadata,
        turnId,
        activeTurnId: turnId,
        ...(input.executionPolicy !== undefined ? { executionPolicy: input.executionPolicy } : {}),
        runtimeAssembly: {
          bundleId: assembly.record.bundleId,
          agentProfileId:
            readAssemblyString(assembly.bundle?.metadata, "agentProfileId") ??
            activeThread.agentProfileId,
          agentProfileLabel:
            readAssemblyString(assembly.bundle?.metadata, "agentProfileLabel") ??
            activeThread.agentProfileLabel,
          environmentShellKind:
            readAssemblyShellKind(assembly.bundle?.metadata, "environmentShellKind") ??
            activeThread.environmentShellKind,
          environmentPresetId:
            readAssemblyShellPresetId(assembly.bundle?.metadata, "environmentPresetId") ??
            activeThread.environmentPresetId,
          environmentCapabilityPackIds:
            readAssemblyCapabilityPackIds(assembly.bundle?.metadata, "environmentCapabilityPackIds") ??
            activeThread.environmentCapabilityPackIds,
          effectiveAssemblyId:
            readAssemblyString(assembly.bundle?.metadata, "effectiveAssemblyId") ??
            assembly.record.bundleId,
          effectiveAssemblyLabel:
            readAssemblyString(assembly.bundle?.metadata, "effectiveAssemblyLabel") ??
            assembly.bundle?.label,
          toolAllowlist: assembly.bundle?.toolAllowlist ?? [],
          specialistIds: assembly.bundle?.specialistIds ?? [],
          contextPolicyId: assembly.bundle?.contextPolicyId,
          approvalPolicyId: assembly.bundle?.approvalPolicyId,
          modelProvider: readAssemblyString(assembly.bundle?.metadata, "modelProvider"),
          model: readAssemblyString(assembly.bundle?.metadata, "model"),
          promptVariant: readAssemblyString(assembly.bundle?.metadata, "promptVariant"),
          compatibilityProfile: readAssemblyString(assembly.bundle?.metadata, "compatibilityProfile"),
          compatibilityStatus: readAssemblyString(assembly.bundle?.metadata, "compatibilityStatus"),
          compatibilityDecisionSource: readAssemblyString(
            assembly.bundle?.metadata,
            "compatibilityDecisionSource",
          ),
          downgradeReason: readAssemblyString(assembly.bundle?.metadata, "downgradeReason"),
          capabilityLossReason: readAssemblyString(assembly.bundle?.metadata, "capabilityLossReason"),
        },
      },
    });
    const turnUpdatedAt = new Date().toISOString();
    const turnStatus = result.output.status === "WAITING" ? "WAITING" : result.output.status;
    const outputRun = await this.store.getRun(result.output.runId);
    const missingPreStartFailure = isMissingRunPreStartFailureOutput(result.output) && outputRun === null;
    const existingRootRunId = missingPreStartFailure
      ? await this.resolveExistingRunId(existingTurn?.rootRunId)
      : existingTurn?.rootRunId;
    const existingActiveRunId = missingPreStartFailure
      ? await this.resolveExistingRunId(existingTurn?.activeRunId)
      : existingTurn?.activeRunId;
    const existingTerminalRunId = missingPreStartFailure
      ? await this.resolveExistingRunId(existingTurn?.terminalRunId)
      : existingTurn?.terminalRunId;
    const rootRunId = existingRootRunId ?? (missingPreStartFailure ? undefined : result.output.runId);
    const activeRunId = missingPreStartFailure ? existingActiveRunId : result.output.runId;
    const terminalRunId = missingPreStartFailure ? existingTerminalRunId : result.output.runId;
    await this.store.upsertConversationTurn?.({
      turnId,
      threadId: activeThread.threadId,
      sessionId: activeThread.sessionId,
      ...(rootRunId !== undefined ? { rootRunId } : {}),
      ...(activeRunId !== undefined ? { activeRunId } : {}),
      status: turnStatus,
      initialEventType: existingTurn?.initialEventType ?? input.eventType,
      ...(result.output.status === "COMPLETED" || result.output.status === "FAILED"
        ? {
            ...(terminalRunId !== undefined ? { terminalRunId } : {}),
            terminalStatus: result.output.status,
            completedAt: turnUpdatedAt,
          }
        : {}),
      startedAt: existingTurn?.startedAt ?? turnStartedAt,
      updatedAt: turnUpdatedAt,
      metadata: {
        ...(existingTurn?.metadata ?? {}),
        interactionMode: input.interactionMode,
        actSubmode: input.actSubmode,
        outputStatus: result.output.status,
        ...(missingPreStartFailure
          ? {
              preStartFailureRunId: result.output.runId,
              preStartFailureCode: "SESSION_BUSY",
            }
          : {}),
      },
    });
    await this.appendRunEventPreservingMissingPreStartFailure(result.output, {
      runId: result.output.runId,
      sessionId: activeThread.sessionId,
      type: "turn.started",
      level: "INFO",
      timestamp: turnStartedAt,
      metadata: {
        threadId: activeThread.threadId,
        turnId,
        eventType: input.eventType,
      },
    });
    await this.store.appendConversationTurnSegment?.({
      segmentId: `turn-segment-${randomUUID()}`,
      turnId,
      threadId: activeThread.threadId,
      sessionId: activeThread.sessionId,
      runId: result.output.runId,
      kind: resolveTurnSegmentKind(input.metadata, input.resumeBlockedRun),
      eventType: input.eventType,
      requestId: readNonEmptyString(input.metadata?.requestId),
      grantId: readNonEmptyString(input.metadata?.grantId),
      messageHash: hashString(input.message),
      createdAt: turnUpdatedAt,
      metadata: {
        outputStatus: result.output.status,
      },
    });
    await this.appendRunEventPreservingMissingPreStartFailure(result.output, {
      runId: result.output.runId,
      sessionId: activeThread.sessionId,
      type: "turn.segment",
      level: "INFO",
      timestamp: turnUpdatedAt,
      metadata: {
        threadId: activeThread.threadId,
        turnId,
        segmentKind: resolveTurnSegmentKind(input.metadata, input.resumeBlockedRun),
        messageHash: hashString(input.message),
        outputStatus: result.output.status,
      },
    });
    if (result.output.status === "COMPLETED" || result.output.status === "FAILED") {
      await this.appendRunEventPreservingMissingPreStartFailure(result.output, {
        runId: result.output.runId,
        sessionId: activeThread.sessionId,
        type: "turn.completed",
        level: result.output.status === "FAILED" ? "WARN" : "INFO",
        timestamp: turnUpdatedAt,
        metadata: {
          threadId: activeThread.threadId,
          turnId,
          status: result.output.status,
        },
      });
    }
    const effectiveAssembly = await this.runtimeComposer.getActiveAssembly(thread.threadId);
    const threadWithIdentity = this.applyRuntimeIdentityToThread(result.thread, effectiveAssembly?.bundle ?? assembly.bundle);
    if (threadWithIdentity !== result.thread) {
      await this.store.upsertThread(threadWithIdentity);
    }
    if (result.wait?.request !== undefined) {
      await this.appendRunEventPreservingMissingPreStartFailure(result.output, {
        runId: result.output.runId,
        sessionId: activeThread.sessionId,
        type: "interaction.requested",
        level: "INFO",
        timestamp: new Date().toISOString(),
        metadata: {
          runId: result.output.runId,
          threadId: activeThread.threadId,
          requestId: result.wait.request.requestId,
          kind: result.wait.request.kind,
          assemblyBundleId: effectiveAssembly?.record.bundleId ?? assembly.record.bundleId,
          ...(result.wait.request.delegationId !== undefined
            ? { delegationId: result.wait.request.delegationId }
            : {}),
        },
      });
    }
    if (result.output.status === "WAITING" && result.wait !== undefined) {
      if (result.wait.request !== undefined) {
        this.emit("interaction.requested", activeThread.threadId, {
          requestId: result.wait.request.requestId,
          kind: result.wait.request.kind,
        });
      }
      this.emit("thread.waiting", activeThread.threadId, {
        eventType: result.wait.waitFor.eventType,
        ...(result.wait.request !== undefined ? { requestId: result.wait.request.requestId } : {}),
      });
    } else if (result.output.status === "FAILED") {
      this.emit("thread.failed", activeThread.threadId, {
        runId: result.output.runId,
      });
    } else {
      this.emit("thread.turn_completed", activeThread.threadId, {
        runId: result.output.runId,
        status: result.output.status,
      });
    }
    if (result.compactionAction === "compact") {
      this.emit("context.compaction_applied", activeThread.threadId, {
        runId: result.output.runId,
      });
    }
    await this.appendRunEventPreservingMissingPreStartFailure(result.output, {
      runId: result.output.runId,
      sessionId: activeThread.sessionId,
      type: "runtime.assembly.changed",
      level: "INFO",
      timestamp: new Date().toISOString(),
      metadata: {
        threadId: activeThread.threadId,
        bundleId: effectiveAssembly?.record.bundleId ?? assembly.record.bundleId,
        cause: effectiveAssembly?.record.cause ?? assembly.record.cause,
        authority: effectiveAssembly?.record.authority ?? assembly.record.authority,
        agentProfileId:
          readAssemblyString(effectiveAssembly?.bundle?.metadata, "agentProfileId") ??
          readAssemblyString(assembly.bundle?.metadata, "agentProfileId") ??
          threadWithIdentity.agentProfileId,
        agentProfileLabel:
          readAssemblyString(effectiveAssembly?.bundle?.metadata, "agentProfileLabel") ??
          readAssemblyString(assembly.bundle?.metadata, "agentProfileLabel") ??
          threadWithIdentity.agentProfileLabel,
        environmentShellKind:
          readAssemblyShellKind(effectiveAssembly?.bundle?.metadata, "environmentShellKind") ??
          readAssemblyShellKind(assembly.bundle?.metadata, "environmentShellKind") ??
          threadWithIdentity.environmentShellKind,
        environmentPresetId:
          readAssemblyShellPresetId(effectiveAssembly?.bundle?.metadata, "environmentPresetId") ??
          readAssemblyShellPresetId(assembly.bundle?.metadata, "environmentPresetId") ??
          threadWithIdentity.environmentPresetId,
        environmentCapabilityPackIds:
          readAssemblyCapabilityPackIds(effectiveAssembly?.bundle?.metadata, "environmentCapabilityPackIds") ??
          readAssemblyCapabilityPackIds(assembly.bundle?.metadata, "environmentCapabilityPackIds") ??
          threadWithIdentity.environmentCapabilityPackIds,
        effectiveAssemblyId:
          readAssemblyString(effectiveAssembly?.bundle?.metadata, "effectiveAssemblyId") ??
          readAssemblyString(assembly.bundle?.metadata, "effectiveAssemblyId") ??
          effectiveAssembly?.record.bundleId ??
          assembly.record.bundleId,
        effectiveAssemblyLabel:
          readAssemblyString(effectiveAssembly?.bundle?.metadata, "effectiveAssemblyLabel") ??
          readAssemblyString(assembly.bundle?.metadata, "effectiveAssemblyLabel") ??
          effectiveAssembly?.bundle?.label ??
          assembly.bundle?.label,
        toolAllowlist: effectiveAssembly?.bundle?.toolAllowlist ?? assembly.bundle?.toolAllowlist ?? [],
        modelProvider:
          readAssemblyString(effectiveAssembly?.bundle?.metadata, "modelProvider") ??
          readAssemblyString(assembly.bundle?.metadata, "modelProvider"),
        model:
          readAssemblyString(effectiveAssembly?.bundle?.metadata, "model") ??
          readAssemblyString(assembly.bundle?.metadata, "model"),
        promptVariant:
          readAssemblyString(effectiveAssembly?.bundle?.metadata, "promptVariant") ??
          readAssemblyString(assembly.bundle?.metadata, "promptVariant"),
      },
    });
    void this.processPendingSteers(activeThread.threadId);
    return {
      ...result,
      thread: threadWithIdentity,
    };
  }

  async replyToRequest(input: ReplyToRequestInput): Promise<SubmitTurnResult> {
    const resolved = await this.interactionManager.resolveRequest(input);
    this.emit("interaction.resolved", input.threadId, {
      requestId: resolved.request.requestId,
      kind: resolved.request.kind,
    });
    const thread = await this.requireThread(input.threadId);
    if (resolved.request.eventType === "runtime.assembly_change") {
      const proposalId = typeof resolved.request.metadata?.proposalId === "string"
        ? resolved.request.metadata.proposalId
        : undefined;
      let appliedAssembly;
      if (input.approve !== false && proposalId !== undefined) {
        appliedAssembly = await this.runtimeComposer.applyApprovedProposal({
          threadId: input.threadId,
          proposalId,
        });
      }
      const updatedThread: ThreadRecord = {
        ...thread,
        ...(thread.currentRequestId === resolved.request.requestId ? { currentRequestId: undefined } : {}),
        updatedAt: new Date().toISOString(),
      };
      const threadWithIdentity = this.applyRuntimeIdentityToThread(updatedThread, appliedAssembly?.bundle);
      await this.store.upsertThread(threadWithIdentity);
      if (appliedAssembly !== undefined) {
        await this.appendRunEventForExistingRun({
          runId: thread.activeRunId ?? `assembly-${resolved.request.requestId}`,
          sessionId: updatedThread.sessionId,
          type: "runtime.assembly.changed",
          level: "INFO",
          timestamp: new Date().toISOString(),
          metadata: {
            threadId: updatedThread.threadId,
            bundleId: appliedAssembly.record.bundleId,
            cause: appliedAssembly.record.cause,
            authority: appliedAssembly.record.authority,
            proposalId,
            agentProfileId:
              readAssemblyString(appliedAssembly.bundle?.metadata, "agentProfileId") ??
              threadWithIdentity.agentProfileId,
            agentProfileLabel:
              readAssemblyString(appliedAssembly.bundle?.metadata, "agentProfileLabel") ??
              threadWithIdentity.agentProfileLabel,
            environmentShellKind:
              readAssemblyShellKind(appliedAssembly.bundle?.metadata, "environmentShellKind") ??
              threadWithIdentity.environmentShellKind,
            environmentPresetId:
              readAssemblyShellPresetId(appliedAssembly.bundle?.metadata, "environmentPresetId") ??
              threadWithIdentity.environmentPresetId,
            environmentCapabilityPackIds:
              readAssemblyCapabilityPackIds(appliedAssembly.bundle?.metadata, "environmentCapabilityPackIds") ??
              threadWithIdentity.environmentCapabilityPackIds,
            effectiveAssemblyId:
              readAssemblyString(appliedAssembly.bundle?.metadata, "effectiveAssemblyId") ??
              appliedAssembly.record.bundleId,
            effectiveAssemblyLabel:
              readAssemblyString(appliedAssembly.bundle?.metadata, "effectiveAssemblyLabel") ??
              appliedAssembly.bundle?.label,
            toolAllowlist: appliedAssembly.bundle?.toolAllowlist ?? [],
          },
        });
      }
      return {
        thread: threadWithIdentity,
        output: buildSyntheticOutput({
          sessionId: threadWithIdentity.sessionId,
          runId: `assembly-${resolved.request.requestId}`,
        }),
        assistantText: null,
      };
    }
    await this.appendRunEventForExistingRun({
      runId: thread.activeRunId ?? `interaction-${resolved.request.requestId}`,
      sessionId: thread.sessionId,
      type: "interaction.resolved",
      level: "INFO",
      timestamp: new Date().toISOString(),
      metadata: {
        runId: thread.activeRunId,
        threadId: input.threadId,
        requestId: resolved.request.requestId,
        kind: resolved.request.kind,
        ...(resolved.request.delegationId !== undefined ? { delegationId: resolved.request.delegationId } : {}),
      },
    });
    if (resolved.grant !== undefined) {
      this.emit("approval.granted", input.threadId, {
        requestId: resolved.request.requestId,
        grantId: resolved.grant.grantId,
      });
      await this.appendRunEventForExistingRun({
        runId: thread.activeRunId ?? `approval-${resolved.grant.grantId}`,
        sessionId: thread.sessionId,
        type: "approval.granted",
        level: "INFO",
        timestamp: new Date().toISOString(),
        metadata: {
          runId: thread.activeRunId,
          threadId: input.threadId,
          requestId: resolved.request.requestId,
          grantId: resolved.grant.grantId,
          ...(resolved.grant.delegationId !== undefined ? { delegationId: resolved.grant.delegationId } : {}),
        },
      });
    }
    const result = await this.submitTurn({
      threadId: input.threadId,
      message: input.message,
      eventType: resolved.request.eventType,
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(input.actSubmode !== undefined ? { actSubmode: input.actSubmode } : {}),
      ...(input.executionPolicy !== undefined ? { executionPolicy: input.executionPolicy } : {}),
      resumeBlockedRun: true,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      metadata: {
        requestId: resolved.request.requestId,
        ...(resolved.grant !== undefined ? { grantId: resolved.grant.grantId } : {}),
        ...(resolved.request.delegationId !== undefined ? { delegationId: resolved.request.delegationId } : {}),
      },
      ...(input.runtimeTurn !== undefined ? { runtimeTurn: input.runtimeTurn } : {}),
    });
    await this.interactionManager.expireTurnScopedGrants(input.threadId);
    return result;
  }

  async resumeBlockedTurn(input: ResumeBlockedTurnInput): Promise<SubmitTurnResult> {
    const status = await this.getThreadStatus(input.threadId);
    const request = status?.openRequests.find(
      (candidate) => candidate.requestId === input.requestId,
    );
    if (request === undefined) {
      throw createRuntimeFailure(
        "THREAD_RESUME_REQUEST_NOT_FOUND",
        `Pending request '${input.requestId}' was not found for thread '${input.threadId}'.`,
        {
          threadId: input.threadId,
          requestId: input.requestId,
        },
      );
    }
    return this.replyToRequest({
      threadId: input.threadId,
      requestId: request.requestId,
      message: input.message,
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(input.actSubmode !== undefined ? { actSubmode: input.actSubmode } : {}),
      ...(input.executionPolicy !== undefined ? { executionPolicy: input.executionPolicy } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      issuedBy: input.actor?.actorId ?? input.actor?.displayName ?? "operator",
      approve: true,
      allowedToolClasses: resolveAllowedToolClasses(
        {
          interactionMode: input.interactionMode ?? "chat",
          ...(input.actSubmode !== undefined ? { actSubmode: input.actSubmode } : {}),
        },
        input.executionPolicy,
      ),
      allowedCapabilities: extractAllowedCapabilities(input.executionPolicy),
      ...(input.runtimeTurn !== undefined ? { runtimeTurn: input.runtimeTurn } : {}),
    });
  }

  async spawnDelegation(input: DelegationRequest): Promise<{ delegationId: string; childThreadId: string }> {
    if (this.delegationSupervisor === undefined) {
      throw delegationSupervisorUnavailableFailure();
    }
    const handle = await this.delegationSupervisor.spawnDelegation(input);
    this.emit("delegation.requested", input.parentThreadId, {
      delegationId: handle.delegationId,
      childThreadId: handle.childThreadId,
    });
    return handle;
  }

  async handleCapabilityLoss(input: {
    threadId: string;
    availableToolNames: string[];
  }): Promise<{
    record: ThreadAssemblyRecord;
    bundle?: AssemblyBundleRecord | undefined;
  } | null> {
    return this.runtimeComposer.recomposeForCapabilityLoss(input);
  }

  async listDelegations(threadId: string) {
    return this.store.listDelegations({
      parentThreadId: threadId,
    });
  }

  async listChildOutcomes(parentThreadId: string): Promise<SupervisionChildSummary[]> {
    return this.listSupervisionChildren(parentThreadId);
  }

  async getSupervisionView(threadId: string): Promise<SupervisionSummary | null> {
    return this.buildSupervisionView(threadId);
  }

  async getActiveAssembly(threadId: string): Promise<{
    record: ThreadAssemblyRecord;
    bundle?: AssemblyBundleRecord | undefined;
  } | null> {
    return this.runtimeComposer.getActiveAssembly(threadId);
  }

  async listAssemblyHistory(threadId: string) {
    return this.store.listThreadAssemblyRecords(threadId);
  }

  async proposeAssemblyChange(input: {
    threadId: string;
    requestedBundleId?: string | undefined;
    requestedToolAllowlist?: string[] | undefined;
    requestedProvider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
    requestedModel?: string | undefined;
    requestedPromptVariant?: string | undefined;
    requestedSpecialistIds?: string[] | undefined;
    requestedContextPolicyId?: string | undefined;
    requestedApprovalPolicyId?: string | undefined;
    proposedBy: "operator" | "model" | "policy";
    reason?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }) {
    const thread = await this.requireThread(input.threadId);
    const result = await this.runtimeComposer.proposeAssemblyChange({
      thread,
      ...(input.requestedBundleId !== undefined ? { requestedBundleId: input.requestedBundleId } : {}),
      ...(input.requestedToolAllowlist !== undefined ? { requestedToolAllowlist: input.requestedToolAllowlist } : {}),
      ...(input.requestedProvider !== undefined ? { requestedProvider: input.requestedProvider } : {}),
      ...(input.requestedModel !== undefined ? { requestedModel: input.requestedModel } : {}),
      ...(input.requestedPromptVariant !== undefined ? { requestedPromptVariant: input.requestedPromptVariant } : {}),
      ...(input.requestedSpecialistIds !== undefined ? { requestedSpecialistIds: input.requestedSpecialistIds } : {}),
      ...(input.requestedContextPolicyId !== undefined ? { requestedContextPolicyId: input.requestedContextPolicyId } : {}),
      ...(input.requestedApprovalPolicyId !== undefined ? { requestedApprovalPolicyId: input.requestedApprovalPolicyId } : {}),
      proposedBy: input.proposedBy,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });

    let request;
    if (result.decision.result === "APPROVAL_REQUIRED") {
      request = {
        requestId: `assembly-request:${result.proposal.proposalId}`,
        threadId: input.threadId,
        kind: "approval" as const,
        status: "PENDING" as const,
        eventType: "runtime.assembly_change",
        prompt: `Approve runtime assembly change for thread '${thread.title}'.`,
        metadata: {
          proposalId: result.proposal.proposalId,
          requestedBundleId: result.proposal.requestedBundleId,
          requestedProvider: result.proposal.requestedProvider,
          requestedModel: result.proposal.requestedModel,
          requestedPromptVariant: result.proposal.requestedPromptVariant,
        },
        createdAt: new Date().toISOString(),
      };
      await this.store.upsertInteractionRequest(request);
      await this.store.upsertThread({
        ...thread,
        currentRequestId: request.requestId,
        updatedAt: request.createdAt,
      });
    }

    return {
      proposal: result.proposal,
      decision: result.decision,
      ...(request !== undefined ? { request } : {}),
      ...(result.activeAssembly !== undefined ? { activeAssembly: result.activeAssembly } : {}),
      ...(result.bundle !== undefined ? { bundle: result.bundle } : {}),
    };
  }

  async getThreadStatus(threadId: string): Promise<ThreadStatusSnapshot | null> {
    const thread = await this.store.getThread(threadId);
    if (thread === null) {
      return null;
    }
    const [
      openRequests,
      activeGrants,
      contextCheckpoints,
      delegations,
      summaries,
      assembly,
    ] = await Promise.all([
      this.store.listInteractionRequests({
        threadId,
        status: "PENDING",
      }),
      this.store.listApprovalGrants({
        threadId,
        status: "ACTIVE",
      }),
      this.store.listContextCheckpoints({
        threadId,
      }),
      this.store.listDelegations({
        parentThreadId: threadId,
      }),
      this.store.listContextSummaryArtifacts(threadId),
      this.runtimeComposer.getActiveAssembly(threadId),
    ]);
    return {
      thread,
      openRequests,
      activeGrants,
      contextCheckpoints,
      delegations,
      ...(assembly?.record !== undefined ? { activeAssembly: assembly.record } : {}),
      ...(assembly?.bundle !== undefined ? { assemblyBundle: assembly.bundle } : {}),
      ...(summaries[0] !== undefined ? { latestSummary: summaries[0] } : {}),
    };
  }

  async listOperatorInbox(input: {
    sessionId?: string | undefined;
    threadId?: string | undefined;
  }) {
    return this.operatorControlPlane.listOperatorInbox(input);
  }

  async getOperatorThreadView(threadId: string) {
    return this.operatorControlPlane.getOperatorThreadView(threadId);
  }

  async listOperatorRuns(input: {
    sessionId?: string | undefined;
    status?: import("./contracts.js").OperatorRunStatus | undefined;
    limit?: number | undefined;
  } = {}) {
    return this.operatorControlPlane.listOperatorRuns(input);
  }

  async getOperatorRunView(runId: string) {
    return this.operatorControlPlane.getOperatorRunView(runId);
  }

  async steerThread(input: import("./contracts.js").SteerThreadInput): Promise<SteerThreadResult> {
    return this.operatorControlPlane.steerThread(input);
  }

  async retryThread(input: import("./contracts.js").RetryThreadInput) {
    return this.operatorControlPlane.retryThread(input);
  }

  async focusThread(input: import("./contracts.js").FocusThreadInput) {
    return this.operatorControlPlane.focusThread(input);
  }

  async approveAssemblyChange(input: import("./contracts.js").ResolveAssemblyProposalInput) {
    return this.operatorControlPlane.approveAssemblyChange(input);
  }

  async rejectAssemblyChange(input: import("./contracts.js").ResolveAssemblyProposalInput) {
    return this.operatorControlPlane.rejectAssemblyChange(input);
  }

  async spawnChildThread(input: import("./contracts.js").SpawnChildThreadInput) {
    return this.operatorControlPlane.spawnChildThread(input);
  }

  async supersedeChildThread(input: SupersedeChildThreadInput) {
    return this.operatorControlPlane.supersedeChildThread(input);
  }

  async resolveFanInCheckpoint(input: import("./contracts.js").ResolveFanInCheckpointInput) {
    return this.operatorControlPlane.resolveFanInCheckpoint(input);
  }

  async resolveContextCheckpoint(input: {
    threadId: string;
    checkpointId: string;
    action: import("./contracts.js").ContextCheckpointAction;
    issuedBy?: string | undefined;
  }) {
    return this.operatorControlPlane.resolveContextCheckpoint(input);
  }

  subscribe(
    target: { threadId?: string | undefined; groupId?: string | undefined },
    listener: (event: ThreadRuntimeEvent) => void,
  ): ThreadRuntimeSubscription {
    const wrapped = (event: ThreadRuntimeEvent) => {
      if (target.threadId !== undefined && target.threadId !== event.threadId) {
        return;
      }
      listener(event);
    };
    this.listeners.add(wrapped);
    return {
      unsubscribe: () => {
        this.listeners.delete(wrapped);
      },
    };
  }

  private async requireThread(threadId: string): Promise<ThreadRecord> {
    const thread = await this.store.getThread(threadId);
    if (thread === null) {
      throw threadNotFoundFailure(threadId);
    }
    return thread;
  }

  private async resolveSubmitGateCheckpoints(thread: ThreadRecord): Promise<void> {
    const pending = (await this.store.listContextCheckpoints({
      threadId: thread.threadId,
      status: "PENDING",
    })).filter((checkpoint) => isFanInCheckpoint(checkpoint) === false);
    let blockingCheckpoint: ContextCheckpointRecord | undefined;
    for (const checkpoint of pending) {
      if (checkpoint.recommendedAction === "compact" || checkpoint.recommendedAction === "summarize_forward") {
        if (checkpoint.recommendedAction === "compact") {
          const summaries = await this.store.listContextSummaryArtifacts(thread.threadId);
          if (hasUsableCheckpointContinuationEvidence(thread, summaries) === false) {
            blockingCheckpoint ??= {
              ...checkpoint,
              reason:
                "Continuation brief unavailable: compact checkpoint needs an original user task and prior assistant state or summary before auto-resolution.",
            };
            continue;
          }
        }
        await this.operatorControlPlane.resolveContextCheckpoint({
          threadId: thread.threadId,
          checkpointId: checkpoint.checkpointId,
          action: checkpoint.recommendedAction,
          issuedBy: "runtime.auto",
        });
        const timestamp = new Date().toISOString();
        const runId = checkpoint.runId ?? thread.activeRunId ?? `checkpoint-${checkpoint.checkpointId}`;
        await this.appendRunEventForExistingRun({
          runId,
          sessionId: thread.sessionId,
          type: "context.checkpoint_auto_resolved",
          level: "INFO",
          timestamp,
          metadata: {
            threadId: thread.threadId,
            checkpointId: checkpoint.checkpointId,
            recommendedAction: checkpoint.recommendedAction,
            reason: checkpoint.reason,
          },
        });
        this.emit("context.checkpoint_auto_resolved", thread.threadId, {
          runId,
          checkpointId: checkpoint.checkpointId,
          recommendedAction: checkpoint.recommendedAction,
        });
        continue;
      }
      if (blockingCheckpoint === undefined) {
        blockingCheckpoint = checkpoint;
      }
    }
    if (blockingCheckpoint !== undefined) {
      throw contextCheckpointPendingFailure({
        threadId: thread.threadId,
        checkpointId: blockingCheckpoint.checkpointId,
        recommendedAction: blockingCheckpoint.recommendedAction,
        reason: blockingCheckpoint.reason,
      });
    }
  }

  private async processPendingSteers(threadId: string): Promise<void> {
    if (this.pendingSteerProcessors.has(threadId)) {
      return;
    }
    this.pendingSteerProcessors.add(threadId);
    try {
      while (true) {
        const status = await this.getThreadStatus(threadId);
        if (status === null || status.thread.status === "RUNNING") {
          return;
        }
        const nextSteer = listPendingSteers(status.thread)[0];
        if (nextSteer === undefined) {
          return;
        }
        const updatedThread = removePendingSteer(status.thread, nextSteer.steerId);
        await this.store.upsertThread(updatedThread);
        try {
          const result = await this.submitTurn({
            threadId,
            message: nextSteer.message,
            eventType: "operator.steer",
            ...(nextSteer.attachments !== undefined ? { attachments: nextSteer.attachments } : {}),
            metadata: {
              issuedBy: nextSteer.issuedBy ?? "operator",
              steering: true,
              steerId: nextSteer.steerId,
              enqueuedAt: nextSteer.createdAt,
            },
          });
          await this.appendRunEventForExistingRun({
            runId: result.output.runId,
            sessionId: result.thread.sessionId,
            type: "operator.steered",
            level: "INFO",
            timestamp: new Date().toISOString(),
            metadata: {
              threadId,
              message: nextSteer.message,
              issuedBy: nextSteer.issuedBy ?? "operator",
              runId: result.output.runId,
              steerId: nextSteer.steerId,
              enqueuedAt: nextSteer.createdAt,
            },
          });
        } catch {
          // Steering follow-ups are additive. Leave subsequent turns available even if one fails.
        }
      }
    } finally {
      this.pendingSteerProcessors.delete(threadId);
    }
  }

  private emit(type: ThreadRuntimeEvent["type"], threadId: string, payload: Record<string, unknown>): void {
    const event: ThreadRuntimeEvent = {
      type,
      threadId,
      timestamp: new Date().toISOString(),
      payload,
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async handleDelegationUpdated(
    record: import("./contracts.js").DelegationRecord,
    finalizedPayload?: unknown,
  ): Promise<void> {
    await this.reconcileChildSupervision({
      parentThreadId: record.parentThreadId,
      parentRunId: record.parentRunId,
      finalizedPayload,
    });
  }

  private async reconcileChildSupervision(input: {
    parentThreadId: string;
    parentRunId?: string | undefined;
    finalizedPayload?: unknown;
  }): Promise<void> {
    const parent = await this.store.getThread(input.parentThreadId);
    if (parent === null) {
      return;
    }
    const children = await this.listSupervisionChildren(input.parentThreadId);
    const existingCheckpoint = await this.store.getContextCheckpoint(
      fanInCheckpointId(input.parentThreadId, defaultSupervisionGroupId(input.parentThreadId)),
    );
    const fanIn = classifyFanIn({
      parentThreadId: input.parentThreadId,
      children,
      ...(existingCheckpoint !== null ? { checkpoint: existingCheckpoint } : {}),
    });
    if (fanIn.kind === "pending_checkpoint") {
      const checkpointCreatedAt = existingCheckpoint?.createdAt ?? new Date().toISOString();
      await this.store.upsertContextCheckpoint({
        checkpointId: fanIn.checkpointId,
        threadId: input.parentThreadId,
        ...(input.parentRunId !== undefined ? { runId: input.parentRunId } : {}),
        status: existingCheckpoint?.status === "PENDING" ? existingCheckpoint.status : "PENDING",
        recommendedAction: "operator_checkpoint",
        reason: fanIn.reason,
        metadata: {
          kind: "fan_in",
          supervisionGroupId: defaultSupervisionGroupId(input.parentThreadId),
          selectedDelegationIds: fanIn.selectedDelegationIds,
        },
        createdAt: checkpointCreatedAt,
      });
      return;
    }
    if (fanIn.kind !== "auto_apply") {
      return;
    }
    const selected = new Set(fanIn.selectedDelegationIds);
    const alreadyApplied = children.some((child) =>
      selected.has(child.delegationId) && child.latestFanInDisposition === "auto_applied",
    );
    if (alreadyApplied) {
      return;
    }
    const now = new Date().toISOString();
    if (existingCheckpoint !== null && existingCheckpoint.status === "PENDING") {
      await this.store.upsertContextCheckpoint({
        ...existingCheckpoint,
        status: "ACCEPTED",
        resolutionAction: "operator_checkpoint",
        resolvedBy: "runtime",
        resolvedAt: now,
      });
    }
    const delegations = await this.store.listDelegations({
      parentThreadId: input.parentThreadId,
    });
    for (const delegation of delegations) {
      if (selected.has(delegation.delegationId) === false) {
        continue;
      }
      const updated = updateDelegationOutcomePolicy({
        record: delegation,
        resultState: readSupervisionPolicy(delegation.policy)?.resultState ?? "completed",
        latestFanInDisposition: "auto_applied",
        latestFanInCheckpointId: existingCheckpoint?.checkpointId,
      });
      await this.store.upsertDelegation(updated);
    }
    await this.appendRunEventForExistingRun({
      runId: input.parentRunId ?? `fanin-${input.parentThreadId}`,
      sessionId: parent.sessionId,
      type: "delegation.reconciled",
      level: "INFO",
      timestamp: now,
      metadata: {
        threadId: input.parentThreadId,
        supervisionGroupId: defaultSupervisionGroupId(input.parentThreadId),
        selectedDelegationIds: fanIn.selectedDelegationIds,
        summary: fanIn.summary,
        disposition: "auto_applied",
      },
    });
    try {
      await this.submitTurn({
        threadId: input.parentThreadId,
        message: `Child reconciliation summary: ${fanIn.summary}`,
        eventType: "operator.reconcile_children",
        metadata: {
          supervision: true,
          autoReconciled: true,
          selectedDelegationIds: fanIn.selectedDelegationIds,
        },
      });
    } catch (error) {
      const runtimeError = asRuntimeError(error);
      await this.appendRunEventForExistingRun({
        runId: input.parentRunId ?? `fanin-${input.parentThreadId}`,
        sessionId: parent.sessionId,
        type: "normalized.failure",
        level: "WARN",
        timestamp: new Date().toISOString(),
        metadata: {
          threadId: input.parentThreadId,
          code: runtimeError.code,
          message: runtimeError.message,
          source: "supervision.auto_reconcile",
        },
      });
    }
  }

  private async listSupervisionChildren(parentThreadId: string): Promise<SupervisionChildSummary[]> {
    const delegations = await this.store.listDelegations({
      parentThreadId,
    });
    const children = await Promise.all(
      delegations.map(async (delegation) => {
        const childThread = await this.store.getThread(delegation.childThreadId);
        return toSupervisionChildSummary({
          delegation,
          childThread,
        });
      }),
    );
    return children.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async buildSupervisionView(threadId: string): Promise<SupervisionSummary | null> {
    const children = await this.listSupervisionChildren(threadId);
    if (children.length === 0) {
      return null;
    }
    const checkpoint = await this.store.getContextCheckpoint(
      fanInCheckpointId(threadId, defaultSupervisionGroupId(threadId)),
    );
    return (
      buildSupervisionSummary({
        parentThreadId: threadId,
        children,
        ...(checkpoint !== null ? { checkpoint } : {}),
        ...(latestFanInDisposition({
          children,
          ...(checkpoint !== null ? { checkpoint } : {}),
        }) !== undefined
          ? {
              latestDecision: latestFanInDisposition({
                children,
                ...(checkpoint !== null ? { checkpoint } : {}),
              }) as FanInDispositionSummary,
            }
          : {}),
      }) ?? null
    );
  }

  private applyRuntimeIdentityToThread(
    thread: ThreadRecord,
    bundle?: AssemblyBundleRecord | undefined,
  ): ThreadRecord {
    const profileIdentity = this.profile === undefined
      ? undefined
      : buildRuntimeIdentityMetadata({
          agentProfileId: this.profile.agentProfileId ?? this.profile.id,
          agentProfileLabel: this.profile.agentProfileLabel ?? this.profile.label,
          legacyProfileLabel: this.profile.label,
          shellKind: this.profile.environmentShellKind ?? this.profile.shellKind,
          presetId: this.profile.environmentPresetId ?? this.profile.presetId,
          capabilityPacks: this.profile.environmentCapabilityPackIds ?? this.profile.capabilityPacks,
        });
    const next: ThreadRecord = {
      ...thread,
      ...(readAssemblyString(bundle?.metadata, "agentProfileId") ??
        thread.agentProfileId ??
        profileIdentity?.agentProfileId) !== undefined
        ? {
            agentProfileId:
              readAssemblyString(bundle?.metadata, "agentProfileId") ??
              thread.agentProfileId ??
              profileIdentity?.agentProfileId,
          }
        : {},
      ...(readAssemblyString(bundle?.metadata, "agentProfileLabel") ??
        thread.agentProfileLabel ??
        profileIdentity?.agentProfileLabel) !== undefined
        ? {
            agentProfileLabel:
              readAssemblyString(bundle?.metadata, "agentProfileLabel") ??
              thread.agentProfileLabel ??
              profileIdentity?.agentProfileLabel,
          }
        : {},
      ...(readAssemblyString(bundle?.metadata, "environmentShellKind") ??
        thread.environmentShellKind ??
        profileIdentity?.environmentShellKind) !== undefined
        ? {
            environmentShellKind:
              readAssemblyShellKind(bundle?.metadata, "environmentShellKind") ??
              thread.environmentShellKind ??
              profileIdentity?.environmentShellKind,
          }
        : {},
      ...(readAssemblyShellPresetId(bundle?.metadata, "environmentPresetId") ??
        thread.environmentPresetId ??
        profileIdentity?.environmentPresetId) !== undefined
        ? {
            environmentPresetId:
              readAssemblyShellPresetId(bundle?.metadata, "environmentPresetId") ??
              thread.environmentPresetId ??
              profileIdentity?.environmentPresetId,
          }
        : {},
      ...(readAssemblyCapabilityPackIds(bundle?.metadata, "environmentCapabilityPackIds") ??
        thread.environmentCapabilityPackIds ??
        profileIdentity?.environmentCapabilityPackIds) !== undefined
        ? {
            environmentCapabilityPackIds:
              readAssemblyCapabilityPackIds(bundle?.metadata, "environmentCapabilityPackIds") ??
              thread.environmentCapabilityPackIds ??
              profileIdentity?.environmentCapabilityPackIds,
          }
        : {},
      ...(readAssemblyString(bundle?.metadata, "effectiveAssemblyId") ??
        thread.effectiveAssemblyId ??
        bundle?.bundleId) !== undefined
        ? {
            effectiveAssemblyId:
              readAssemblyString(bundle?.metadata, "effectiveAssemblyId") ??
              thread.effectiveAssemblyId ??
              bundle?.bundleId,
          }
        : {},
      ...(readAssemblyString(bundle?.metadata, "effectiveAssemblyLabel") ??
        thread.effectiveAssemblyLabel ??
        bundle?.label) !== undefined
        ? {
            effectiveAssemblyLabel:
              readAssemblyString(bundle?.metadata, "effectiveAssemblyLabel") ??
              thread.effectiveAssemblyLabel ??
              bundle?.label,
          }
        : {},
    };

    return runtimeIdentityChanged(thread, next) ? next : thread;
  }

  private async appendRunEventPreservingMissingPreStartFailure(
    output: NormalizedOutput,
    event: RunEvent,
  ): Promise<void> {
    try {
      await this.store.appendRunEvent(event);
    } catch (error) {
      if (
        isRunEventRunForeignKeyViolation(error) &&
        isMissingRunPreStartFailureOutput(output)
      ) {
        return;
      }
      throw error;
    }
  }

  private async appendRunEventForExistingRun(event: RunEvent): Promise<void> {
    try {
      await this.store.appendRunEvent(event);
    } catch (error) {
      if (isRunEventRunForeignKeyViolation(error)) {
        return;
      }
      throw error;
    }
  }

  private async resolveExistingRunId(runId: string | undefined): Promise<string | undefined> {
    if (runId === undefined) {
      return undefined;
    }
    const existingRun = await this.store.getRun(runId);
    return existingRun === null ? undefined : runId;
  }
}

function isMissingRunPreStartFailureOutput(output: NormalizedOutput): boolean {
  if (output.status !== "FAILED") {
    return false;
  }
  return output.errors.some((error) => error.code === "SESSION_BUSY");
}

function isRunEventRunForeignKeyViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as Record<string, unknown>;
  if (record.code !== "23503") {
    return false;
  }
  if (record.constraint === "run_events_run_id_fkey") {
    return true;
  }
  const message = typeof record.message === "string" ? record.message : "";
  return message.includes("run_events_run_id_fkey");
}

function buildSyntheticOutput(input: { sessionId: string; runId: string }): NormalizedOutput {
  return {
    status: "COMPLETED",
    sessionId: input.sessionId,
    runId: input.runId,
    quality: {
      citationCoverage: 1,
      unresolvedClaims: 0,
      reworkRate: 0,
      thrashIndex: 0,
    },
    errors: [],
    telemetry: {
      stepsExecuted: 0,
      toolCalls: 0,
      modelCalls: 0,
      durationMs: 0,
    },
  };
}

export function createTurnExecutor(options: {
  runTurn: (input: SubmitTurnInput & { sessionId: string }) => Promise<TurnExecutionResult>;
  getSession: TurnExecutor["getSession"];
}): TurnExecutor {
  return {
    executeTurn: async (input) => {
      const result = await options.runTurn(input);
      return {
        output: result.output,
        assistantText: result.assistantText ?? null,
        ...(result.session !== undefined ? { session: result.session } : {}),
        ...(result.finalizedPayload !== undefined ? { finalizedPayload: result.finalizedPayload } : {}),
      };
    },
    getSession: options.getSession,
  };
}

function readAssemblyString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function readAssemblyStringArray(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const value = metadata?.[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : undefined;
}

function readAssemblyShellKind(
  metadata: Record<string, unknown> | undefined,
  key: string,
): ThreadRecord["environmentShellKind"] {
  const value = metadata?.[key];
  return value === "cli" || value === "web" || value === "desktop" ? value : undefined;
}

function readAssemblyShellPresetId(
  metadata: Record<string, unknown> | undefined,
  key: string,
): ThreadRecord["environmentPresetId"] {
  const value = metadata?.[key];
  return value === "cli_dev_local" || value === "web_balanced" || value === "desktop_dev_local"
    ? value
    : undefined;
}

function readAssemblyCapabilityPackIds(
  metadata: Record<string, unknown> | undefined,
  key: string,
): ThreadRecord["environmentCapabilityPackIds"] {
  const value = metadata?.[key];
  if (Array.isArray(value) === false) {
    return undefined;
  }
  const packs = value.filter(
    (entry): entry is NonNullable<ThreadRecord["environmentCapabilityPackIds"]>[number] =>
      entry === "balanced" ||
      entry === "filesystem" ||
      entry === "dev_shell" ||
      entry === "sandbox_code",
  );
  return packs.length > 0 ? [...new Set(packs)] : [];
}

function runtimeIdentityChanged(previous: ThreadRecord, next: ThreadRecord): boolean {
  return previous.agentProfileId !== next.agentProfileId ||
    previous.agentProfileLabel !== next.agentProfileLabel ||
    previous.environmentShellKind !== next.environmentShellKind ||
    previous.environmentPresetId !== next.environmentPresetId ||
    sameStringArrays(previous.environmentCapabilityPackIds, next.environmentCapabilityPackIds) === false ||
    previous.effectiveAssemblyId !== next.effectiveAssemblyId ||
    previous.effectiveAssemblyLabel !== next.effectiveAssemblyLabel;
}

function sameStringArrays(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined || left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => entry === right[index]);
}

function isFanInCheckpoint(
  checkpoint: ContextCheckpointRecord,
): boolean {
  return checkpoint.metadata?.kind === "fan_in";
}

function hasUsableCheckpointContinuationEvidence(
  thread: ThreadRecord,
  summaries: ContextSummaryArtifactRecord[],
): boolean {
  const history = Array.isArray(thread.metadata?.history) ? thread.metadata.history : [];
  let hasOriginalUserTask = false;
  let hasAssistantState = false;
  for (const entry of history) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const text = readNonEmptyString(record.text);
    if (text === undefined) {
      continue;
    }
    if (record.role === "user" && hasOriginalUserTask === false) {
      hasOriginalUserTask = true;
    }
    const data = typeof record.data === "object" && record.data !== null && Array.isArray(record.data) === false
      ? record.data as Record<string, unknown>
      : undefined;
    if (record.role === "assistant" || (record.role === "system" && data?.kind === "runtime.waiting_prompt")) {
      hasAssistantState = true;
    }
  }
  const hasPriorSummaryState = summaries.some((summary) => readNonEmptyString(summary.summary) !== undefined);
  return hasOriginalUserTask && (hasAssistantState || hasPriorSummaryState);
}

function resolveTurnSegmentKind(
  metadata: Record<string, unknown> | undefined,
  resumeBlockedRun: boolean | undefined,
): "submission" | "resume" | "approval_reply" | "user_reply" | "system_resume" {
  if (readNonEmptyString(metadata?.grantId) !== undefined) {
    return "approval_reply";
  }
  if (readNonEmptyString(metadata?.requestId) !== undefined) {
    return "user_reply";
  }
  if (resumeBlockedRun === true) {
    return "resume";
  }
  return "submission";
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function extractAllowedCapabilities(
  policy: ExecutionPolicyOverride | undefined,
): string[] {
  const capabilityPolicy = policy?.capabilityPolicy;
  if (capabilityPolicy === undefined) {
    return [];
  }
  return Object.entries(capabilityPolicy)
    .filter(([, allowed]) => allowed === true)
    .map(([capability]) => capability);
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalMainThreadId(sessionId: string): string {
  return `thread-main:${sessionId}`;
}

function readThreadMainRole(thread: ThreadRecord): boolean {
  return thread.metadata?.mainThread === true;
}
