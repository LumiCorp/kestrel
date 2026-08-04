import { createHash, randomUUID } from "node:crypto";

import type { TuiProfile } from "../../cli/contracts.js";
import type {
  RunEvent,
} from "../kestrel/contracts/events.js";
import type { RuntimeError } from "../kestrel/contracts/base.js";
import type {
  ContextCheckpointRecord,
  ContextSummaryArtifactRecord,
  ConversationTurnFinalizedPayloadV1,
  ConversationTurnSubmissionKind,
  ConversationTurnTerminalEnvelopeV1,
  ConversationTurnRecord,
  RunTurnAttachment,
  ThreadRecord,
} from "../kestrel/contracts/orchestration.js";
import type { NormalizedOutput } from "../kestrel/contracts/execution.js";
import type {
  ReplayStore,
  SessionRepository,
} from "../kestrel/contracts/store.js";
import { stringifySanitizedJson } from "../runtime/jsonSanitizer.js";
import type { RuntimeTurnActor } from "../runtime/RuntimeTurn.js";
import type { DelegationServicePort, DialogServicePort } from "../../tools/contracts.js";
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
import {
  DelegationSupervisor,
  type DelegationSupervisorOptions,
  type DelegationTaskUpdate,
} from "./DelegationSupervisor.js";
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
import {
  enqueueFollowUp as enqueueFollowUpRecord,
  editFollowUp as editFollowUpRecord,
  markFollowUpStarting,
  pauseFollowUpQueue,
  readFollowUpQueue,
  removeFollowUp,
  resumeFollowUps,
} from "./FollowUpQueue.js";
import { TurnOrchestrator, mergeSubmittedHistoryMetadata } from "./TurnOrchestrator.js";
import type {
  AssemblyBundleRecord,
  DelegationRequest,
  EnqueueFollowUpInput,
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
import { ExecutionBoundaryPolicyRuntime } from "../security/ExecutionBoundaryPolicy.js";

export interface ThreadRuntimeOptions {
  sessionStore: SessionRepository;
  orchestrationStore?: ReplayStore | undefined;
  executor: TurnExecutor;
  profile?: TuiProfile | undefined;
  onTaskUpdate?: ((update: DelegationTaskUpdate) => void) | undefined;
  structuredSummaryGenerator?: ContextStructuredSummaryGenerator | undefined;
  resolveAttachments?: ((threadId: string, attachmentIds: string[]) => Promise<RunTurnAttachment[]>) | undefined;
  onDetachedTurnEvent?: ((event: DetachedTurnLifecycleEvent) => void) | undefined;
  executionBoundaryRuntime?: ExecutionBoundaryPolicyRuntime | undefined;
  evaluateHandoff?: DelegationSupervisorOptions["onHandoffCompleted"] | undefined;
}

export type DetachedTurnLifecycleEvent =
  | { type: "started"; threadId: string; sessionId: string; runId: string; eventType: string }
  | { type: "completed"; threadId: string; sessionId: string; runId: string; result: SubmitTurnResult }
  | { type: "failed"; threadId: string; sessionId: string; runId: string; result?: SubmitTurnResult | undefined; error: RuntimeError };

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
  private readonly followUpProcessors = new Set<string>();
  private readonly followUpMutations = new Map<string, Promise<void>>();
  private readonly activeThreadSubmissions = new Set<string>();
  private readonly resolveAttachments?: ThreadRuntimeOptions["resolveAttachments"];
  private readonly onDetachedTurnEvent?: ThreadRuntimeOptions["onDetachedTurnEvent"];

  constructor(options: ThreadRuntimeOptions) {
    this.sessionStore = options.sessionStore;
    this.store = options.orchestrationStore ?? (options.sessionStore as ReplayStore);
    this.profile = options.profile;
    this.resolveAttachments = options.resolveAttachments;
    this.onDetachedTurnEvent = options.onDetachedTurnEvent;
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
    const executionBoundaryRuntime =
      options.executionBoundaryRuntime ?? new ExecutionBoundaryPolicyRuntime();
    this.assemblyPolicyEvaluator = new AssemblyPolicyEvaluator(executionBoundaryRuntime);
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
      executionBoundaryRuntime,
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
        ...(options.evaluateHandoff !== undefined
          ? { onHandoffCompleted: options.evaluateHandoff }
          : {}),
        onDelegationUpdated: async ({ record, finalizedPayload }) => {
          await this.handleDelegationUpdated(record, finalizedPayload);
        },
        onDialogReply: async ({ record, message }) => {
          await this.enqueueFollowUp({
            threadId: record.parentThreadId,
            followUpId: message.messageId,
            message: `${message.name}: ${message.text}`,
            source: "dialog",
            dialogId: record.delegationId,
            dialogName: message.name,
            sourceMessageId: message.messageId,
          });
        },
      });
    }
  }

  getDelegationService(): DelegationServicePort | undefined {
    return this.delegationSupervisor;
  }

  getDialogService(): DialogServicePort | undefined {
    return this.delegationSupervisor;
  }

  async listConversationTurns(input: { threadId?: string | undefined; sessionId?: string | undefined; status?: ConversationTurnRecord["status"] | undefined; completedAfter?: { completedAt: string; turnId: string } | undefined; terminalMessagesOnly?: boolean | undefined; limit?: number | undefined } = {}) { return this.store.listConversationTurns?.(input) ?? []; }
  async listConversationTurnSegments(turnId: string) { return this.store.listConversationTurnSegments?.(turnId) ?? []; }

  async listCompletedConversationMessages(input: {
    threadId: string;
    completedAfter?: { completedAt: string; turnId: string } | undefined;
    limit: number;
  }): Promise<Array<{
    messageId: string;
    turnId: string;
    threadId: string;
    sessionId: string;
    runId: string;
    completedAt: string;
    result: { assistantText: string; output: NormalizedOutput };
  }>> {
    const turns = await this.listConversationTurns({
      threadId: input.threadId,
      status: "COMPLETED",
      terminalMessagesOnly: true,
      ...(input.completedAfter !== undefined ? { completedAfter: input.completedAfter } : {}),
      limit: input.limit,
    });
    return turns.flatMap((turn) => {
      const envelope = readTerminalEnvelope(turn.metadata?.terminalEnvelope);
      if (
        turn.completedAt === undefined
        || envelope?.status !== "COMPLETED"
        || envelope.handoff.state !== "delivered"
        || envelope.output === undefined
      ) return [];
      return [{
        messageId: `terminal:${envelope.runId}`,
        turnId: turn.turnId,
        threadId: turn.threadId,
        sessionId: turn.sessionId,
        runId: envelope.runId,
        completedAt: turn.completedAt,
        result: {
          assistantText: envelope.handoff.assistantText,
          output: envelope.output,
        },
      }];
    });
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
    if (this.activeThreadSubmissions.has(input.threadId)) {
      throw createRuntimeFailure(
        "THREAD_RUN_ALREADY_ACTIVE",
        `Thread '${input.threadId}' already has an active run.`,
        { threadId: input.threadId },
      );
    }
    this.activeThreadSubmissions.add(input.threadId);
    const cancelDialogs = () => this.delegationSupervisor?.cancelActiveDialogs(input.threadId);
    input.signal?.addEventListener("abort", cancelDialogs, { once: true });
    try {
      return await this.submitAcceptedTurn({
        ...input,
        actor: input.actor ?? localOperatorActor(),
      });
    } finally {
      input.signal?.removeEventListener("abort", cancelDialogs);
      this.activeThreadSubmissions.delete(input.threadId);
    }
  }

  private async submitAcceptedTurn(input: SubmitTurnInput): Promise<SubmitTurnResult> {
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
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(input.actSubmode !== undefined ? { actSubmode: input.actSubmode } : {}),
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
    const existingTurn = await this.store.getConversationTurn?.(turnId);
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
    }
    const assembly = await this.runtimeComposer.composeThreadAssembly({
      thread: activeThread,
      cause: "turn_start",
    });
    const contextPolicyId = assembly.bundle?.contextPolicyId;
    const contextPolicy = contextPolicyId === undefined
      ? undefined
      : await this.resolveContextPolicyDefinition(contextPolicyId);
    const submissionKind = resolveConversationTurnSubmissionKind(
      submittedMetadata,
      input.resumeBlockedRun,
    );
    const storedClaim = asRecord(existingTurn?.metadata?.executionClaim);
    const submittedTurnRequestIdentity = buildTurnRequestIdentity({
        turnId,
        threadId: activeThread.threadId,
        sessionId: activeThread.sessionId,
        eventType: input.eventType,
        message: input.message,
        startedAt: existingTurn?.startedAt ?? turnStartedAt,
        execution: buildTurnExecutionIdentity(input),
      });
    const turnRequestIdentity =
      submissionKind === "initial"
        ? submittedTurnRequestIdentity
        : readNonEmptyString(storedClaim?.turnRequestIdentity) ?? submittedTurnRequestIdentity;
    const submissionIdentity = buildSubmissionIdentity({
      turnId,
      submissionKind,
      eventType: input.eventType,
      message: input.message,
      metadata: submittedMetadata,
      execution: buildTurnExecutionIdentity(input),
    });
    const proposedRunId = input.runtimeTurn?.runId ?? randomUUID();
    const eventId = randomUUID();
    const segmentKind = resolveTurnSegmentKind(input.metadata, input.resumeBlockedRun);
    const claimResult = await this.store.claimConversationTurnExecution({
      turnId,
      threadId: activeThread.threadId,
      sessionId: activeThread.sessionId,
      turnRequestIdentity,
      submissionIdentity,
      submissionKind,
      proposedRunId,
      eventType: input.eventType,
      startedAt: turnStartedAt,
      segment: {
        segmentId: `turn-segment-${hashString(`${turnId}:${submissionIdentity}`)}`,
        turnId,
        threadId: activeThread.threadId,
        sessionId: activeThread.sessionId,
        runId: proposedRunId,
        kind: segmentKind,
        eventType: input.eventType,
        requestId: readNonEmptyString(input.metadata?.requestId),
        grantId: readNonEmptyString(input.metadata?.grantId),
        messageHash: hashString(input.message),
        createdAt: turnStartedAt,
        metadata: {
          ...mergedMetadata,
          submissionIdentity,
          submissionKind,
          ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
          ...(input.actSubmode !== undefined ? { actSubmode: input.actSubmode } : {}),
        },
      },
    });
    if (claimResult.kind === "already_running") {
      throw createRuntimeFailure(
        "THREAD_RUN_ALREADY_ACTIVE",
        `Turn '${turnId}' already has an executing or consumed submission.`,
        { threadId: activeThread.threadId, turnId, runId: claimResult.runId },
      );
    }
    if (claimResult.kind === "terminal") {
      return this.replayTerminalTurn(activeThread.threadId, claimResult.terminalEnvelope);
    }
    activeThread = await this.requireThread(activeThread.threadId);
    this.emit("thread.turn_submitted", activeThread.threadId, {
      eventType: input.eventType,
      runId: proposedRunId,
    });
    let result: SubmitTurnResult;
    try {
      result = await this.turnOrchestrator.execute(activeThread, {
        ...input,
        runtimeTurn: {
          ...(input.runtimeTurn ?? {
            sessionId: activeThread.sessionId,
            message: input.message,
            eventType: input.eventType,
          }),
          sessionId: activeThread.sessionId,
          runId: proposedRunId,
          eventId,
          message: input.message,
          eventType: input.eventType,
        },
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
          ...(assembly.bundle?.metadata?.harnessEconomics !== undefined
            ? { harnessEconomics: assembly.bundle.metadata.harnessEconomics }
            : {}),
          },
        },
      });
    } catch (error) {
      await this.recordTerminalHandoffFailure(turnId, asRuntimeError(error));
      throw error;
    }
    const turnUpdatedAt = new Date().toISOString();
    if (result.output.status === "COMPLETED" || result.output.status === "FAILED") {
      await this.recordDeliveredTerminalHandoff(turnId, result);
    }
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
    const latestStoredThread = await this.store.getThread(result.thread.threadId);
    const resultThread = latestStoredThread?.metadata?.operatorControl !== undefined
      ? {
          ...result.thread,
          metadata: {
            ...(result.thread.metadata ?? {}),
            operatorControl: latestStoredThread.metadata.operatorControl,
          },
        }
      : result.thread;
    const threadWithIdentity = this.applyRuntimeIdentityToThread(resultThread, effectiveAssembly?.bundle ?? assembly.bundle);
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
    if (result.output.status === "WAITING" || result.output.status === "FAILED") {
      await this.withFollowUpMutation(activeThread.threadId, async (latestThread) => {
        if (readFollowUpQueue(latestThread).items.length > 0) {
          const queue = readFollowUpQueue(latestThread);
          await this.store.upsertThread(pauseFollowUpQueue(
            latestThread,
            result.output.status === "WAITING"
              ? "waiting"
              : queue.pauseReason === "cancelled" ? "cancelled" : "failed",
          ));
        }
      });
    }
    void this.processPendingSteers(activeThread.threadId);
    if (result.output.status === "COMPLETED") void this.processFollowUps(activeThread.threadId);
    return {
      ...result,
      thread: threadWithIdentity,
    };
  }

  private async resolveContextPolicyDefinition(contextPolicyId: string) {
    if (this.store.getContextPolicyDefinition !== undefined) {
      return this.store.getContextPolicyDefinition(contextPolicyId);
    }
    const policies = await this.store.listContextPolicyDefinitions();
    return policies.find((policy) => policy.contextPolicyId === contextPolicyId) ?? null;
  }

  async enqueueFollowUp(input: EnqueueFollowUpInput) {
    const entry = {
      followUpId: input.followUpId,
      message: input.message,
      attachmentIds: input.attachmentIds ?? [],
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(input.actSubmode !== undefined ? { actSubmode: input.actSubmode } : {}),
      createdAt: new Date().toISOString(),
      state: "queued" as const,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.dialogId !== undefined ? { dialogId: input.dialogId } : {}),
      ...(input.dialogName !== undefined ? { dialogName: input.dialogName } : {}),
      ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
    };
    const thread = await this.withFollowUpMutation(input.threadId, async (current) => {
      const updated = enqueueFollowUpRecord(current, entry);
      await this.store.upsertThread(updated);
      return updated;
    });
    this.emit("thread.follow_up_queued", input.threadId, { followUpId: input.followUpId });
    if (thread.status !== "RUNNING") void this.processFollowUps(input.threadId);
    return this.requireOperatorThreadView(input.threadId);
  }

  async cancelFollowUp(input: { threadId: string; followUpId: string }) {
    const removed = await this.withFollowUpMutation(input.threadId, async (thread) => {
      const entry = readFollowUpQueue(thread).items.find((item) => item.followUpId === input.followUpId);
      if (entry === undefined) return false;
      if (entry.state === "starting") throw createRuntimeFailure("FOLLOW_UP_ALREADY_STARTING", `Follow-up '${input.followUpId}' is already starting.`);
      await this.store.upsertThread(removeFollowUp(thread, input.followUpId));
      return true;
    });
    if (removed === false) return this.requireOperatorThreadView(input.threadId);
    this.emit("thread.follow_up_cancelled", input.threadId, { followUpId: input.followUpId });
    return this.requireOperatorThreadView(input.threadId);
  }

  async editFollowUp(input: { threadId: string; followUpId: string; message: string }) {
    const message = input.message.trim();
    if (message.length === 0) throw createRuntimeFailure("FOLLOW_UP_MESSAGE_INVALID", "Follow-up message cannot be empty.");
    await this.withFollowUpMutation(input.threadId, async (thread) => {
      const entry = readFollowUpQueue(thread).items.find((item) => item.followUpId === input.followUpId);
      if (entry === undefined) throw createRuntimeFailure("FOLLOW_UP_NOT_FOUND", `Follow-up '${input.followUpId}' was not found.`);
      if (entry.state === "starting") throw createRuntimeFailure("FOLLOW_UP_ALREADY_STARTING", `Follow-up '${input.followUpId}' is already starting.`);
      await this.store.upsertThread(editFollowUpRecord(thread, input.followUpId, message));
    });
    this.emit("thread.follow_up_edited", input.threadId, { followUpId: input.followUpId });
    return this.requireOperatorThreadView(input.threadId);
  }

  async pauseFollowUpQueue(input: { threadId: string; reason: import("./contracts.js").FollowUpQueuePauseReason }) {
    await this.withFollowUpMutation(input.threadId, async (thread) => {
      if (readFollowUpQueue(thread).items.length === 0) return;
      await this.store.upsertThread(pauseFollowUpQueue(thread, input.reason));
    });
    this.emit("thread.follow_up_queue_paused", input.threadId, { reason: input.reason });
    return this.requireOperatorThreadView(input.threadId);
  }

  async resumeFollowUpQueue(input: { threadId: string }) {
    await this.withFollowUpMutation(input.threadId, async (thread) => {
      if (thread.status === "WAITING" || thread.currentRequestId !== undefined) {
        throw createRuntimeFailure(
          "FOLLOW_UP_QUEUE_WAITING_FOR_INPUT",
          "Resolve the thread's waiting action before resuming its follow-up queue.",
          { threadId: input.threadId, requestId: thread.currentRequestId },
        );
      }
      await this.store.upsertThread(resumeFollowUps(thread));
    });
    this.emit("thread.follow_up_queue_resumed", input.threadId, {});
    void this.processFollowUps(input.threadId);
    return this.requireOperatorThreadView(input.threadId);
  }

  async replyToRequest(input: ReplyToRequestInput): Promise<SubmitTurnResult> {
    const effectiveInput: ReplyToRequestInput = {
      ...input,
      actor: input.actor ?? localOperatorActor(),
    };
    const queueWasWaiting = readFollowUpQueue(await this.requireThread(input.threadId)).pauseReason === "waiting";
    const resolved = await this.interactionManager.resolveRequest(effectiveInput);
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
      if (queueWasWaiting) {
        await this.withFollowUpMutation(input.threadId, async (latest) => {
          await this.store.upsertThread(resumeFollowUps(latest));
        });
        void this.processFollowUps(input.threadId);
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
        ...(input.recoveryOptionId !== undefined
          ? { recoveryOptionId: input.recoveryOptionId }
          : {}),
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
      ...(input.recoveryOptionId !== undefined
        ? { recoveryOptionId: input.recoveryOptionId }
        : {}),
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
      ...(input.runtimeTurn !== undefined || input.recoveryOptionId !== undefined
        ? {
            runtimeTurn: {
              ...(input.runtimeTurn ?? {
                sessionId: thread.sessionId,
                message: input.message,
                eventType: resolved.request.eventType,
              }),
              ...(input.recoveryOptionId !== undefined
                ? { recoveryOptionId: input.recoveryOptionId }
                : {}),
            },
          }
        : {}),
      actor: effectiveInput.actor,
    });
    if (queueWasWaiting && result.output.status === "COMPLETED") {
      await this.withFollowUpMutation(input.threadId, async (latest) => {
        await this.store.upsertThread(resumeFollowUps(latest));
      });
      void this.processFollowUps(input.threadId);
    }
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
      actor: input.actor ?? {
        actorType: "operator",
        actorId: "kestrel-local-operator",
        displayName: "Local Kestrel Operator",
      },
      approve: true,
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

  async continueWaiting(input: { threadId: string }) {
    return this.operatorControlPlane.continueWaiting(input);
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

  private async replayTerminalTurn(
    threadId: string,
    envelope: ConversationTurnTerminalEnvelopeV1,
  ): Promise<SubmitTurnResult> {
    if (envelope.handoff.state === "pending") {
      throw createRuntimeFailure(
        "RUNTIME_TERMINAL_HANDOFF_INCOMPLETE",
        `Run '${envelope.runId}' completed before its terminal handoff was recorded.`,
        { threadId, runId: envelope.runId },
      );
    }
    if (envelope.handoff.state === "failed") {
      throw createRuntimeFailure(
        envelope.handoff.finalizationError.code,
        envelope.handoff.finalizationError.message,
        envelope.handoff.finalizationError.details,
      );
    }
    if (envelope.output === undefined) {
      throw createRuntimeFailure(
        "RUNTIME_TERMINAL_HANDOFF_INCOMPLETE",
        `Run '${envelope.runId}' has no replayable normalized output.`,
        { threadId, runId: envelope.runId },
      );
    }
    const thread = await this.requireThread(threadId);
    const finalizedPayload = envelope.handoff.finalizedPayload === undefined
      ? undefined
      : await this.readFinalizedPayload(thread.sessionId, envelope.handoff.finalizedPayload);
    return {
      thread,
      output: envelope.output,
      assistantText: envelope.handoff.assistantText,
      ...(finalizedPayload !== undefined ? { finalizedPayload } : {}),
    };
  }

  private async recordDeliveredTerminalHandoff(
    turnId: string,
    result: SubmitTurnResult,
  ): Promise<void> {
    try {
      const turn = await this.store.getConversationTurn?.(turnId);
      const envelope = readTerminalEnvelope(turn?.metadata?.terminalEnvelope);
      if (
        turn === null ||
        turn === undefined ||
        envelope === undefined ||
        envelope.runId !== result.output.runId ||
        envelope.status !== result.output.status
      ) {
        throw createRuntimeFailure(
          "RUNTIME_TERMINAL_HANDOFF_INCOMPLETE",
          `Turn '${turnId}' has no matching pending terminal envelope.`,
          { turnId, runId: result.output.runId, status: result.output.status },
        );
      }
      const finalizedPayload = result.finalizedPayload === undefined
        ? undefined
        : await this.persistFinalizedPayload(
            turn.sessionId,
            result.output.runId,
            result.finalizedPayload,
          );
      const delivered: ConversationTurnTerminalEnvelopeV1 =
        envelope.status === "COMPLETED"
          ? {
              ...envelope,
              output: result.output,
              handoff: {
                state: "delivered",
                assistantText: requireAssistantText(result.assistantText, turnId),
                ...(finalizedPayload !== undefined ? { finalizedPayload } : {}),
              },
            }
          : {
              ...envelope,
              output: result.output,
              handoff: {
                state: "delivered",
                assistantText: null,
                ...(finalizedPayload !== undefined ? { finalizedPayload } : {}),
              },
            };
      const updated = await this.store.updateConversationTurnTerminalEnvelope({
        turnId,
        runId: result.output.runId,
        terminalSubmissionIdentity: envelope.terminalSubmissionIdentity,
        envelope: delivered,
      });
      if (updated === false) {
        throw createRuntimeFailure(
          "RUNTIME_TERMINAL_HANDOFF_INCOMPLETE",
          `Turn '${turnId}' no longer owns the pending terminal handoff.`,
          { turnId, runId: result.output.runId },
        );
      }
    } catch (error) {
      await this.recordTerminalHandoffFailure(turnId, asRuntimeError(error));
      throw error;
    }
  }

  private async recordTerminalHandoffFailure(
    turnId: string,
    finalizationError: RuntimeError,
  ): Promise<void> {
    const turn = await this.store.getConversationTurn?.(turnId);
    const envelope = readTerminalEnvelope(turn?.metadata?.terminalEnvelope);
    if (
      turn === null ||
      turn === undefined ||
      envelope === undefined ||
      envelope.handoff.state !== "pending"
    ) {
      return;
    }
    const failed: ConversationTurnTerminalEnvelopeV1 = {
      ...envelope,
      handoff: { state: "failed", finalizationError },
    };
    await this.store.updateConversationTurnTerminalEnvelope({
      turnId,
      runId: envelope.runId,
      terminalSubmissionIdentity: envelope.terminalSubmissionIdentity,
      envelope: failed,
    });
  }

  private async persistFinalizedPayload(
    sessionId: string,
    runId: string,
    value: unknown,
  ): Promise<ConversationTurnFinalizedPayloadV1> {
    const serialized = stringifySanitizedJson(value);
    const sanitized = JSON.parse(serialized) as unknown;
    const byteCount = Buffer.byteLength(serialized, "utf8");
    const sha256 = createHash("sha256").update(serialized).digest("hex");
    if (byteCount <= 64 * 1024) {
      return { storage: "inline", value: sanitized, byteCount, sha256 };
    }
    const artifacts = await this.store.appendArtifacts(runId, sessionId, 0, [{
      type: "conversation_turn_finalized_payload.v1",
      payload: {
        version: "v1",
        finalizedPayload: sanitized,
        byteCount,
        sha256,
      },
    }]);
    const artifact = artifacts[0];
    if (artifact === undefined) {
      throw createRuntimeFailure(
        "RUNTIME_TERMINAL_HANDOFF_PAYLOAD_PERSIST_FAILED",
        `Finalized payload for run '${runId}' was not persisted.`,
        { runId, sessionId },
      );
    }
    return { storage: "artifact", artifactId: artifact.artifactId, byteCount, sha256 };
  }

  private async readFinalizedPayload(
    sessionId: string,
    reference: ConversationTurnFinalizedPayloadV1,
  ): Promise<unknown> {
    const value = reference.storage === "inline"
      ? reference.value
      : (await this.store.getArtifact({
          artifactId: reference.artifactId,
          sessionId,
        }))?.payload.finalizedPayload;
    if (value === undefined) {
      throw createRuntimeFailure(
        "RUNTIME_TERMINAL_HANDOFF_PAYLOAD_MISSING",
        "The finalized payload artifact is unavailable.",
        {
          sessionId,
          ...(reference.storage === "artifact" ? { artifactId: reference.artifactId } : {}),
        },
      );
    }
    const serialized = stringifySanitizedJson(value);
    const byteCount = Buffer.byteLength(serialized, "utf8");
    const sha256 = createHash("sha256").update(serialized).digest("hex");
    if (byteCount !== reference.byteCount || sha256 !== reference.sha256) {
      throw createRuntimeFailure(
        "RUNTIME_TERMINAL_HANDOFF_PAYLOAD_CORRUPT",
        "The finalized payload failed digest validation.",
        { expectedByteCount: reference.byteCount, actualByteCount: byteCount },
      );
    }
    return JSON.parse(serialized) as unknown;
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
          summaryThread: thread,
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
          const result = await this.executeDetachedTurn({
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

  private async executeDetachedTurn(input: SubmitTurnInput): Promise<SubmitTurnResult> {
    const thread = await this.requireThread(input.threadId);
    const runId = input.runtimeTurn?.runId ?? randomUUID();
    const runtimeTurn = {
      ...(input.runtimeTurn ?? {
        sessionId: thread.sessionId,
        message: input.message,
        eventType: input.eventType,
      }),
      sessionId: thread.sessionId,
      runId,
    };
    this.onDetachedTurnEvent?.({
      type: "started",
      threadId: thread.threadId,
      sessionId: thread.sessionId,
      runId,
      eventType: input.eventType,
    });
    try {
      const result = await this.submitTurn({ ...input, runtimeTurn });
      if (result.output.status === "FAILED") {
        this.onDetachedTurnEvent?.({
          type: "failed",
          threadId: thread.threadId,
          sessionId: thread.sessionId,
          runId,
          result,
          error: result.output.errors[0] ?? {
            code: "RUN_FAILED",
            message: "Detached run failed.",
          },
        });
      } else {
        this.onDetachedTurnEvent?.({
          type: "completed",
          threadId: thread.threadId,
          sessionId: thread.sessionId,
          runId,
          result,
        });
      }
      return result;
    } catch (error) {
      this.onDetachedTurnEvent?.({
        type: "failed",
        threadId: thread.threadId,
        sessionId: thread.sessionId,
        runId,
        error: asRuntimeError(error),
      });
      throw error;
    }
  }

  private async processFollowUps(threadId: string): Promise<void> {
    if (this.followUpProcessors.has(threadId)) return;
    this.followUpProcessors.add(threadId);
    try {
      while (true) {
        const status = await this.getThreadStatus(threadId);
        if (status === null || status.thread.status === "RUNNING") return;
        const queue = readFollowUpQueue(status.thread);
        if (queue.state === "paused") return;
        const next = queue.items[0];
        if (next === undefined) return;
        await this.withFollowUpMutation(threadId, async (thread) => {
          await this.store.upsertThread(markFollowUpStarting(thread, next.followUpId));
        });
        try {
          const attachments = next.attachmentIds.length === 0
            ? undefined
            : await this.resolveQueuedAttachments(threadId, next.attachmentIds);
          const result = await this.executeDetachedTurn({
            threadId,
            message: next.message,
            eventType: next.source === "dialog" ? "dialog.message" : "user.follow_up",
            ...(next.interactionMode !== undefined ? { interactionMode: next.interactionMode } : {}),
            ...(next.actSubmode !== undefined ? { actSubmode: next.actSubmode } : {}),
            ...(attachments !== undefined ? { attachments } : {}),
            metadata: {
              followUpId: next.followUpId,
              enqueuedAt: next.createdAt,
              ...(next.source !== undefined ? { source: next.source } : {}),
              ...(next.dialogId !== undefined ? { dialogId: next.dialogId } : {}),
              ...(next.dialogName !== undefined ? { dialogName: next.dialogName } : {}),
              ...(next.sourceMessageId !== undefined ? { sourceMessageId: next.sourceMessageId } : {}),
            },
            ...(next.source === "dialog" ? {
              runtimeTurn: {
                sessionId: threadId,
                message: next.message,
                eventType: "dialog.message",
                actor: { actorType: "service", actorId: next.dialogId ?? "dialog", ...(next.dialogName !== undefined ? { displayName: next.dialogName } : {}) },
                systemInstructions: [
                  "This input came from an open collaborator dialog, not from the human. Continue the private dialog with dialog.send when useful. Produce an ordinary user-facing response only when there is a user-relevant outcome, a question requiring the human, or final completion; otherwise the visible dialog exchange is sufficient.",
                ],
              },
            } : {}),
          });
          await this.withFollowUpMutation(threadId, async (latest) => {
            await this.store.upsertThread(removeFollowUp(latest, next.followUpId));
          });
          if (result.output.status === "WAITING" || result.output.status === "FAILED") return;
        } catch (error) {
          await this.withFollowUpMutation(threadId, async (latest) => {
            await this.store.upsertThread(pauseFollowUpQueue(latest, "failed"));
          });
          this.emit("thread.follow_up_failed", threadId, {
            followUpId: next.followUpId,
            code: asRuntimeError(error).code,
          });
          return;
        }
      }
    } finally {
      this.followUpProcessors.delete(threadId);
    }
  }

  private async resolveQueuedAttachments(
    threadId: string,
    attachmentIds: string[],
  ): Promise<RunTurnAttachment[]> {
    if (this.resolveAttachments === undefined) {
      throw createRuntimeFailure(
        "ATTACHMENT_RESOLVER_UNAVAILABLE",
        "Queued attachments cannot be resolved by this runtime.",
        { threadId, attachmentIds },
      );
    }
    return this.resolveAttachments(threadId, attachmentIds);
  }

  private async requireOperatorThreadView(threadId: string) {
    const view = await this.getOperatorThreadView(threadId);
    if (view === null) throw threadNotFoundFailure(threadId);
    return view;
  }

  private async withFollowUpMutation<T>(
    threadId: string,
    operation: (thread: ThreadRecord) => Promise<T>,
  ): Promise<T> {
    const previous = this.followUpMutations.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    this.followUpMutations.set(threadId, chain);
    await previous;
    try {
      return await operation(await this.requireThread(threadId));
    } finally {
      release();
      if (this.followUpMutations.get(threadId) === chain) this.followUpMutations.delete(threadId);
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
      await this.executeDetachedTurn({
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
      return ;
    }
    const existingRun = await this.store.getRun(runId);
    return existingRun === null ? undefined : runId;
  }
}

function localOperatorActor(): RuntimeTurnActor {
  return {
    actorType: "operator",
    actorId: "kestrel-local-operator",
    displayName: "Local Kestrel Operator",
  };
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
  return value === "cli_safe_local" ||
    value === "cli_dev_local" ||
    value === "web_balanced" ||
    value === "desktop_safe_local" ||
    value === "desktop_dev_local" ||
    value === "workspace_hosted"
    ? value
    : undefined;
}

function readAssemblyCapabilityPackIds(
  metadata: Record<string, unknown> | undefined,
  key: string,
): ThreadRecord["environmentCapabilityPackIds"] {
  const value = metadata?.[key];
  if (Array.isArray(value) === false) {
    return ;
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

function resolveConversationTurnSubmissionKind(
  metadata: Record<string, unknown> | undefined,
  resumeBlockedRun: boolean | undefined,
): ConversationTurnSubmissionKind {
  if (readNonEmptyString(metadata?.steerId) !== undefined) {
    return "steer";
  }
  if (readNonEmptyString(metadata?.followUpId) !== undefined) {
    return "follow_up";
  }
  if (
    resumeBlockedRun === true ||
    readNonEmptyString(metadata?.requestId) !== undefined ||
    readNonEmptyString(metadata?.grantId) !== undefined
  ) {
    return "resume";
  }
  return "initial";
}

function buildTurnRequestIdentity(input: {
  turnId: string;
  threadId: string;
  sessionId: string;
  eventType: string;
  message?: string | undefined;
  startedAt: string;
  execution: Record<string, unknown>;
}): string {
  return hashCanonicalValue(input.message !== undefined
    ? {
        kind: "initial_turn_request",
        turnId: input.turnId,
        threadId: input.threadId,
        sessionId: input.sessionId,
        eventType: input.eventType,
        message: input.message,
        execution: input.execution,
      }
    : {
        kind: "legacy_turn_request",
        turnId: input.turnId,
        threadId: input.threadId,
        sessionId: input.sessionId,
        eventType: input.eventType,
        startedAt: input.startedAt,
      });
}

function buildSubmissionIdentity(input: {
  turnId: string;
  submissionKind: ConversationTurnSubmissionKind;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown> | undefined;
  execution: Record<string, unknown>;
}): string {
  return hashCanonicalValue({
    kind: input.submissionKind,
    turnId: input.turnId,
    eventType: input.eventType,
    message: input.message,
    requestId: readNonEmptyString(input.metadata?.requestId),
    grantId: readNonEmptyString(input.metadata?.grantId),
    steerId: readNonEmptyString(input.metadata?.steerId),
    followUpId: readNonEmptyString(input.metadata?.followUpId),
    sourceMessageId: readNonEmptyString(input.metadata?.sourceMessageId),
    execution: input.execution,
  });
}

function buildTurnExecutionIdentity(
  input: Pick<
    SubmitTurnInput,
    | "attachments"
    | "interactionMode"
    | "actSubmode"
    | "executionPolicy"
    | "stepAgent"
    | "recoveryOptionId"
    | "manualCompaction"
    | "autoCompaction"
  >,
): Record<string, unknown> {
  return {
    attachments: input.attachments?.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      threadId: attachment.threadId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      kind: attachment.kind,
    })),
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    executionPolicy: input.executionPolicy,
    stepAgent: input.stepAgent,
    recoveryOptionId: input.recoveryOptionId,
    manualCompaction: input.manualCompaction,
    autoCompaction: input.autoCompaction,
  };
}

function requireAssistantText(value: string | null, turnId: string): string {
  const text = readNonEmptyString(value);
  if (text === undefined) {
    throw createRuntimeFailure(
      "RUNTIME_TERMINAL_HANDOFF_INVALID",
      `Completed turn '${turnId}' did not produce nonempty assistant text.`,
      { turnId },
    );
  }
  return text;
}

function readTerminalEnvelope(value: unknown): ConversationTurnTerminalEnvelopeV1 | undefined {
  const envelope = asRecord(value);
  const handoff = asRecord(envelope?.handoff);
  if (
    envelope?.version !== "v1" ||
    (envelope.status !== "COMPLETED" && envelope.status !== "FAILED") ||
    readNonEmptyString(envelope.turnRequestIdentity) === undefined ||
    readNonEmptyString(envelope.terminalSubmissionIdentity) === undefined ||
    readNonEmptyString(envelope.runId) === undefined ||
    (
      handoff?.state !== "pending" &&
      handoff?.state !== "delivered" &&
      handoff?.state !== "failed"
    )
  ) {
    return undefined;
  }
  if (
    handoff.state === "delivered" &&
    envelope.status === "COMPLETED" &&
    readNonEmptyString(handoff.assistantText) === undefined
  ) {
    return undefined;
  }
  if (
    handoff.state === "delivered" &&
    envelope.status === "FAILED" &&
    handoff.assistantText !== null
  ) {
    return undefined;
  }
  return value as ConversationTurnTerminalEnvelopeV1;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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

function hashCanonicalValue(value: unknown): string {
  return hashString(JSON.stringify(sortCanonicalValue(value)));
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortCanonicalValue(entry));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) {
      sorted[key] = sortCanonicalValue(entry);
    }
  }
  return sorted;
}

function canonicalMainThreadId(sessionId: string): string {
  return `thread-main:${sessionId}`;
}

function readThreadMainRole(thread: ThreadRecord): boolean {
  return thread.metadata?.mainThread === true;
}
