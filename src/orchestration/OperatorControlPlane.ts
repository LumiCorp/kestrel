import { randomUUID } from "node:crypto";

import type { ContextSummaryArtifactRecord, OperatorAttentionRecord } from "../kestrel/contracts/orchestration.js";

import type { ReplayStore } from "../kestrel/contracts/store.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { RunReplayService } from "../replay/RunReplayService.js";
import type {
  ReplayAdaptationSummary,
  ReplayEvidenceRecoverySummary,
  ReplayRuntimePlanSummary,
} from "../replay/RunReplayService.js";
import {
  OPERATOR_RUN_INDEX_VIEW_VERSION,
  OPERATOR_RUN_VIEW_VERSION,
} from "./contracts.js";
import {
  buildSupervisionSummary,
  defaultSupervisionGroupId,
  fanInCheckpointId,
  latestFanInDisposition,
  readSupervisionPolicy,
  toSupervisionChildSummary,
  updateDelegationOutcomePolicy,
} from "./Supervision.js";
import { enqueuePendingSteer } from "./SteeringQueue.js";
import type {
  AssemblyChangeProposalRecord,
  ContextCheckpointAction,
  ContextCheckpointRecord,
  DelegationRecord,
  FanInDispositionSummary,
  InteractionRequestRecord,
  OperatorInboxItem,
  OperatorInboxSnapshot,
  OperatorNextActionSummary,
  OperatorRuntimePlanSummary,
  OperatorRunIndexView,
  OperatorRunStatus,
  OperatorRunView,
  OperatorThreadView,
  OperatorChildBlockerChainEntry,
  OperatorContextPostureSummary,
  OperatorEvidenceRecoverySummary,
  OperatorChildResultSummary,
  ReplyToRequestInput,
  RetryThreadInput,
  SupersedeChildThreadInput,
  SteerThreadInput,
  SteerThreadResult,
  SubmitTurnResult,
  ThreadCompactionEventRecord,
  ThreadRecord,
  ThreadRuntimePort,
  ThreadStatusSnapshot,
  AdaptationSummary,
  ChildThreadPolicy,
  ChildThreadSupervisionPolicy,
} from "./contracts.js";

export class OperatorControlPlane {
  private readonly store: ReplayStore;
  private readonly replay: RunReplayService;
  private readonly runtime: Pick<
    ThreadRuntimePort,
    "getThreadStatus"
  > & Partial<Pick<ThreadRuntimePort, "replyToRequest" | "submitTurn" | "spawnDelegation">>;

  constructor(options: {
    store: ReplayStore;
    runtime: Pick<ThreadRuntimePort, "getThreadStatus"> &
      Partial<Pick<ThreadRuntimePort, "replyToRequest" | "submitTurn" | "spawnDelegation">>;
  }) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.replay = new RunReplayService(this.store);
  }

  async listOperatorInbox(input: {
    sessionId?: string | undefined;
    threadId?: string | undefined;
  }): Promise<OperatorInboxSnapshot> {
    const threads = await this.resolveThreads(input);
    const focusedThreadId = await this.resolveFocusedThreadId(threads, input);
    const items = (
      await Promise.all(threads.map((thread) => this.buildInboxItemsForThread(thread)))
    ).flat().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return {
      ...(focusedThreadId !== undefined ? { focusThreadId: focusedThreadId } : {}),
      items,
      summary: {
        total: items.length,
        actionable: items.filter((item) => item.actionable).length,
        approvals: items.filter((item) => item.kind === "approval_request").length,
        userInputs: items.filter((item) => item.kind === "user_input_request").length,
        checkpoints: items.filter((item) => item.kind === "context_checkpoint").length,
        childBlockers: items.filter((item) => item.kind === "child_thread_blocker").length,
        stalled: items.filter((item) => item.kind === "stalled_thread_attention").length,
        assemblyProposals: items.filter((item) => item.kind === "assembly_change_proposal").length,
        compatibilityAlerts: items.filter((item) => item.kind === "compatibility_downgrade_attention").length,
      },
    };
  }

  async getOperatorThreadView(threadId: string): Promise<OperatorThreadView | null> {
    const status = await this.runtime.getThreadStatus(threadId);
    if (status === null) {
      return null;
    }
    const session = await this.store.getSession(status.thread.sessionId);
    const doctor = await this.getDoctorForThread(status.thread);
    const replayEvents = await this.store.getReplayStream({
      threadId,
      limit: 200,
    });
    const latestSteering = [...replayEvents]
      .reverse()
      .find((event) => event.type === "operator.steered");
    const parentThread =
      status.thread.parentThreadId !== undefined
        ? await this.store.getThread(status.thread.parentThreadId)
        : null;
    const childThreads = await this.store.listThreads({ parentThreadId: threadId });
    const checkpoints = await this.store.listContextCheckpoints({ threadId });
    const assemblyProposals = await this.store.listAssemblyChangeProposals({
      threadId,
      status: "PENDING",
    });
    const childOutcomes = await this.listChildOutcomeSummaries(threadId);
    const childResults = childOutcomes.map(toOperatorChildResultSummary);
    const fanInCheckpoint = checkpoints.find(
      (entry) => entry.checkpointId === fanInCheckpointId(threadId, defaultSupervisionGroupId(threadId)),
    );
    const fanInDisposition = latestFanInDisposition({
      children: childOutcomes,
      ...(fanInCheckpoint !== undefined ? { checkpoint: fanInCheckpoint } : {}),
    });
    const supervision = buildSupervisionSummary({
      parentThreadId: threadId,
      children: childOutcomes,
      ...(fanInCheckpoint !== undefined ? { checkpoint: fanInCheckpoint } : {}),
      ...(fanInDisposition !== undefined ? { latestDecision: fanInDisposition } : {}),
    });
    const focus = await this.store.getOperatorFocus(status.thread.sessionId);
    const blockerChain = await this.buildChildBlockerChain(status.thread);
    const dominantChildBlocker = blockerChain[blockerChain.length - 1];
    const blocker = deriveBlockerSummary(
      status,
      doctor,
      checkpoints[0],
      dominantChildBlocker,
      doctor?.childBlocker,
    );
    const contextPosture = deriveContextPosture(status, checkpoints[0]);
    const runtimePlan = deriveRuntimePlanSummary(session?.state);
    const nextAction = deriveNextActionSummary(
      status,
      doctor?.wait?.kind,
      checkpoints[0],
      blocker,
      fanInDisposition,
      assemblyProposals[0],
    );
    return {
      thread: status.thread,
      ...(focus !== null ? { focusedThreadId: focus.threadId } : {}),
      ...(parentThread !== null ? { parentThread } : {}),
      childThreads,
      ...(supervision !== undefined ? { supervision } : {}),
      ...(childOutcomes.length > 0 ? { childOutcomes } : {}),
      ...(childResults.length > 0 ? { childResults } : {}),
      ...(fanInDisposition !== undefined ? { latestFanInDisposition: fanInDisposition } : {}),
      ...(doctor?.wait !== undefined ? { activeWait: doctor.wait } : {}),
      ...(blocker !== undefined ? { blocker } : {}),
      ...(dominantChildBlocker?.delegationId !== undefined
        ? {
            childBlocker: {
              delegationId: dominantChildBlocker.delegationId,
              childThreadId: dominantChildBlocker.threadId,
              status: dominantChildBlocker.status === "IDLE" ? "PENDING" : dominantChildBlocker.status,
              ...(dominantChildBlocker.reason !== undefined ? { reason: dominantChildBlocker.reason } : {}),
            },
          }
        : doctor?.childBlocker !== undefined
          ? { childBlocker: doctor.childBlocker }
          : {}),
      childBlockerChain: blockerChain,
      ...(latestSteering?.metadata !== undefined
        ? {
            latestSteering: {
              message: asString(latestSteering.metadata.message) ?? "operator steer",
              ...(asString(latestSteering.metadata.issuedBy) !== undefined
                ? { issuedBy: asString(latestSteering.metadata.issuedBy) }
                : {}),
              at: latestSteering.timestamp,
              ...(asString(latestSteering.metadata.runId) !== undefined
                ? { runId: asString(latestSteering.metadata.runId) }
                : {}),
            },
          }
        : {}),
      ...(doctor?.latestReasoning !== undefined ? { latestReasoning: doctor.latestReasoning } : {}),
      ...(doctor?.turn !== undefined ? { activeTurn: doctor.turn } : {}),
      ...(doctor?.modelProvenance !== undefined ? { modelProvenance: doctor.modelProvenance } : {}),
      operatorPhase: deriveOperatorPhase(doctor),
      ...(checkpoints[0] !== undefined ? { latestCheckpoint: checkpoints[0] } : {}),
      ...(findLatestCheckpointDisposition(checkpoints) !== undefined
        ? { latestCheckpointDisposition: findLatestCheckpointDisposition(checkpoints) }
        : {}),
      ...(status.activeAssembly !== undefined ? { activeAssembly: status.activeAssembly } : {}),
      ...(status.assemblyBundle !== undefined ? { assemblyBundle: status.assemblyBundle } : {}),
      ...(contextPosture !== undefined ? { contextPosture } : {}),
      ...(doctor?.latestAdaptation !== undefined
        ? { latestAdaptation: normalizeAdaptationSummary(doctor.latestAdaptation) }
        : {}),
      ...(doctor?.latestEvidenceRecovery !== undefined
        ? { latestEvidenceRecovery: normalizeEvidenceRecoverySummary(doctor.latestEvidenceRecovery) }
        : {}),
      ...(nextAction !== undefined
        ? { nextAction }
        : {}),
      ...(runtimePlan !== undefined ? { runtimePlan } : {}),
    };
  }

  async listOperatorRuns(input: {
    sessionId?: string | undefined;
    status?: OperatorRunStatus | undefined;
    limit?: number | undefined;
  } = {}): Promise<OperatorRunIndexView> {
    const limit = Math.max(1, Math.min(input.limit ?? 25, 50));
    const listedRuns = await this.store.listRunSummaries({
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      limit: limit + 1,
    });
    const hasMore = listedRuns.length > limit;
    const runs = listedRuns.slice(0, limit).map(({ run, eventCount, threadId }) => {
      const actionable = run.status === "WAITING" || run.status === "FAILED";
      return {
        run: {
          runId: run.runId,
          sessionId: run.sessionId,
          eventType: run.eventType,
          status: run.status,
          startedAt: run.startedAt,
          ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
          ...(run.error !== undefined
            ? {
                error: {
                  code: run.error.code,
                  message: run.error.message,
                },
              }
            : {}),
        },
        ...(threadId !== undefined ? { threadId } : {}),
        summary: {
          eventCount,
          truncated: false,
        },
        diagnosis: {
          status: run.status,
          ...(run.error !== undefined ? { terminalReasonCode: run.error.code } : {}),
          actionable,
          ...(run.error !== undefined
            ? {
                dominantFailure: {
                  classification: "terminal_failure" as const,
                  message: run.error.message,
                },
              }
            : {}),
        },
      } satisfies OperatorRunIndexView["runs"][number];
    });
    return {
      version: OPERATOR_RUN_INDEX_VIEW_VERSION,
      generatedAt: new Date().toISOString(),
      filters: {
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        limit,
      },
      hasMore,
      runs,
      sessions: buildOperatorSessionIndex(runs),
    };
  }

  async getOperatorRunView(runId: string): Promise<OperatorRunView | null> {
    const run = await this.store.getRun(runId);
    if (run === null) {
      return null;
    }
    const replay = await this.replay.replay({ runId, limit: 500 });
    const doctor = this.replay.doctor(replay);
    const providers = uniqueStrings(replay.modelProvenance.calls.map((call) => call.provider));
    const models = uniqueStrings(replay.modelProvenance.calls.map((call) => call.model));
    const threadId = replay.summary.threadId ?? replay.lineage.focusThread?.threadId;
    const runtimePlan = projectRuntimePlan(doctor.runtimePlan ?? replay.runtimePlan);
    return {
      version: OPERATOR_RUN_VIEW_VERSION,
      run: {
        runId: run.runId,
        sessionId: run.sessionId,
        eventType: run.eventType,
        status: run.status,
        startedAt: run.startedAt,
        ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
        ...(run.error !== undefined
          ? { error: { code: run.error.code, message: run.error.message } }
          : {}),
      },
      ...(threadId !== undefined ? { threadId } : {}),
      summary: {
        eventCount: replay.summary.eventCount,
        ...(replay.summary.firstEventAt !== undefined ? { firstEventAt: replay.summary.firstEventAt } : {}),
        ...(replay.summary.lastEventAt !== undefined ? { lastEventAt: replay.summary.lastEventAt } : {}),
        ...(replay.summary.terminalStatus !== undefined
          ? { terminalStatus: replay.summary.terminalStatus }
          : {}),
        stepsObserved: replay.summary.stepsObserved,
        progressToolCalls: replay.summary.progressToolCalls,
        waitingMilestones: replay.summary.waitingMilestones,
        truncated: replay.summary.truncated,
        ...(replay.summary.requestedLimit !== undefined
          ? { requestedLimit: replay.summary.requestedLimit }
          : {}),
      },
      diagnosis: {
        status: doctor.status,
        ...(doctor.finalStep !== undefined ? { finalStep: doctor.finalStep } : {}),
        ...(doctor.terminalReasonCode !== undefined
          ? { terminalReasonCode: doctor.terminalReasonCode }
          : {}),
        actionable: doctor.actionable,
        ...(doctor.dominantFailure !== undefined
          ? {
              dominantFailure: {
                classification: doctor.dominantFailure.classification,
                message: doctor.dominantFailure.message,
              },
            }
          : {}),
        ...(doctor.wait !== undefined
          ? {
              wait: {
                kind: doctor.wait.kind,
                actionable: doctor.wait.actionable,
                ...(doctor.wait.eventType !== undefined ? { eventType: doctor.wait.eventType } : {}),
                ...(doctor.wait.threadId !== undefined ? { threadId: doctor.wait.threadId } : {}),
                ...(doctor.wait.delegationId !== undefined
                  ? { delegationId: doctor.wait.delegationId }
                  : {}),
                ...(doctor.wait.requestId !== undefined ? { requestId: doctor.wait.requestId } : {}),
                ...(doctor.wait.enteredAt !== undefined ? { enteredAt: doctor.wait.enteredAt } : {}),
              },
            }
          : {}),
        ...(doctor.latestReasoning !== undefined
          ? {
              latestReasoning: {
                message: doctor.latestReasoning.message,
                at: doctor.latestReasoning.at,
              },
            }
          : {}),
      },
      modelProvenance: {
        retention: replay.modelProvenance.retention,
        callCount: replay.modelProvenance.callCount,
        actionCallCount: replay.modelProvenance.actionCallCount,
        maintenanceCallCount: replay.modelProvenance.maintenanceCallCount,
        providers,
        models,
      },
      ...(runtimePlan !== undefined ? { runtimePlan } : {}),
      timeline: replay.timeline.map((entry) => ({
        seq: entry.seq,
        at: entry.at,
        label: entry.label,
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
        source: entry.source,
        ...(entry.step !== undefined ? { step: entry.step } : {}),
        ...(entry.stepIndex !== undefined ? { stepIndex: entry.stepIndex } : {}),
      })),
    };
  }

  async steerThread(input: SteerThreadInput): Promise<SteerThreadResult> {
    const status = await this.requireThreadStatus(input.threadId);
    await this.persistFocus(status.thread.sessionId, input.threadId, input.issuedBy ?? "operator");
    if (status.thread.status === "RUNNING") {
      const pendingSteer = {
        steerId: `steer-${randomUUID()}`,
        message: input.message,
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        issuedBy: input.issuedBy ?? "operator",
        createdAt: new Date().toISOString(),
      };
      const queuedThread = enqueuePendingSteer(status.thread, pendingSteer);
      await this.store.upsertThread(queuedThread);
      return {
        thread: queuedThread,
        status: "queued",
        pendingSteer,
      };
    }
    const result = await this.requireAction("submitTurn")({
      threadId: input.threadId,
      message: input.message,
      eventType: "operator.steer",
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      metadata: {
        issuedBy: input.issuedBy ?? "operator",
        steering: true,
      },
    });
    await this.store.appendRunEvent({
      runId: result.output.runId,
      sessionId: status.thread.sessionId,
      type: "operator.steered",
      level: "INFO",
      timestamp: new Date().toISOString(),
      metadata: {
        threadId: input.threadId,
        message: input.message,
        issuedBy: input.issuedBy ?? "operator",
        runId: result.output.runId,
      },
    });
    return {
      thread: result.thread,
      status: "applied",
      result,
    };
  }

  async retryThread(input: RetryThreadInput): Promise<SubmitTurnResult> {
    const status = await this.requireThreadStatus(input.threadId);
    await this.persistFocus(status.thread.sessionId, input.threadId, "operator");
    const doctor = await this.getDoctorForThread(status.thread);
    const retryable =
      status.thread.lastRunStatus === "FAILED" ||
      doctor?.status === "STALLED" ||
      doctor?.dominantFailure?.classification === "scheduler_stall";
    if (retryable !== true) {
      throw createRuntimeFailure(
        "OPERATOR_THREAD_NOT_RETRYABLE",
        `Thread '${input.threadId}' is not retryable.`,
        {
          threadId: input.threadId,
          status: status.thread.status,
          lastRunStatus: status.thread.lastRunStatus,
          doctorStatus: doctor?.status,
        },
      );
    }
    return this.requireAction("submitTurn")({
      threadId: input.threadId,
      message: input.reason ?? "Retry the most recent failed or stalled thread work.",
      eventType: "operator.retry",
      metadata: {
        retryRequestedBy: "operator",
      },
    });
  }

  async resolveContextCheckpoint(input: {
    threadId: string;
    checkpointId: string;
    action: ContextCheckpointAction;
    issuedBy?: string | undefined;
  }): Promise<ThreadStatusSnapshot> {
    const checkpoint = await this.store.getContextCheckpoint(input.checkpointId);
    if (checkpoint === null || checkpoint.threadId !== input.threadId) {
      throw createRuntimeFailure(
        "OPERATOR_CONTEXT_CHECKPOINT_NOT_FOUND",
        `Context checkpoint '${input.checkpointId}' was not found for thread '${input.threadId}'.`,
        { checkpointId: input.checkpointId, threadId: input.threadId },
      );
    }
    if (checkpoint.status !== "PENDING") {
      throw createRuntimeFailure(
        "OPERATOR_CONTEXT_CHECKPOINT_NOT_PENDING",
        `Context checkpoint '${input.checkpointId}' for thread '${input.threadId}' is already ${checkpoint.status.toLowerCase()}.`,
        { checkpointId: input.checkpointId, threadId: input.threadId, status: checkpoint.status },
      );
    }
    const status = await this.requireThreadStatus(input.threadId);
    await this.persistFocus(status.thread.sessionId, input.threadId, input.issuedBy ?? "operator");
    const checkpointRunId =
      checkpoint.runId ?? status.thread.activeRunId ?? `checkpoint-${checkpoint.checkpointId}`;
    if (input.action === "compact") {
      await this.persistCheckpointSummaryAction({
        thread: status.thread,
        checkpoint,
        runId: checkpointRunId,
        action: "compact",
        source: "policy_checkpoint",
        issuedBy: input.issuedBy ?? "operator",
      });
    }
    if (input.action === "summarize_forward") {
      await this.persistCheckpointSummaryAction({
        thread: status.thread,
        checkpoint,
        runId: checkpointRunId,
        action: "summarize_forward",
        source: "summarize_forward",
        issuedBy: input.issuedBy ?? "operator",
      });
    }
    if (input.action === "handoff") {
      const handoffPrompt = asString(checkpoint.metadata?.handoffPrompt);
      if (handoffPrompt === undefined) {
        throw createRuntimeFailure(
          "OPERATOR_CONTEXT_CHECKPOINT_ACTION_UNAVAILABLE",
          `Context checkpoint '${input.checkpointId}' is missing handoff metadata for thread '${input.threadId}'.`,
          { checkpointId: input.checkpointId, threadId: input.threadId, action: input.action },
        );
      }
      const handoffTitle = asString(checkpoint.metadata?.handoffTitle) ?? `Handoff for ${status.thread.title}`;
      const handle = await this.requireAction("spawnDelegation")({
        parentThreadId: input.threadId,
        title: handoffTitle,
        prompt: handoffPrompt,
        launchedBy: "operator",
        policy: {
          sourceCheckpointId: checkpoint.checkpointId,
        },
      });
      const event = {
        eventId: `compaction-${randomUUID()}`,
        threadId: input.threadId,
        runId: checkpointRunId,
        action: "handoff",
        reason: checkpoint.reason,
        metadata: {
          checkpointId: checkpoint.checkpointId,
          delegationId: handle.delegationId,
          childThreadId: handle.childThreadId,
        },
        createdAt: new Date().toISOString(),
      } satisfies ThreadCompactionEventRecord;
      assertCompactionEventInvariant(event, { summaryRequired: false });
      await this.store.appendThreadCompactionEvent(event);
      await this.store.appendRunEvent({
        runId: checkpointRunId,
        sessionId: status.thread.sessionId,
        type: "context.adaptation_applied",
        level: "INFO",
        timestamp: new Date().toISOString(),
        metadata: {
          threadId: input.threadId,
          checkpointId: checkpoint.checkpointId,
          action: "handoff",
          delegationId: handle.delegationId,
          childThreadId: handle.childThreadId,
          reason: checkpoint.reason,
        },
      });
    }
    if (input.action === "split_into_child_thread") {
      const splitPrompt = asString(checkpoint.metadata?.splitPrompt);
      if (splitPrompt === undefined) {
        throw createRuntimeFailure(
          "OPERATOR_CONTEXT_CHECKPOINT_ACTION_UNAVAILABLE",
          `Context checkpoint '${input.checkpointId}' is missing split metadata for thread '${input.threadId}'.`,
          { checkpointId: input.checkpointId, threadId: input.threadId, action: input.action },
        );
      }
      const splitTitle = asString(checkpoint.metadata?.splitTitle) ?? `Split from ${status.thread.title}`;
      const handle = await this.requireAction("spawnDelegation")({
        parentThreadId: input.threadId,
        title: splitTitle,
        prompt: splitPrompt,
        launchedBy: "operator",
        policy: {
          sourceCheckpointId: checkpoint.checkpointId,
        },
      });
      const event = {
        eventId: `compaction-${randomUUID()}`,
        threadId: input.threadId,
        runId: checkpointRunId,
        action: "split_into_child_thread",
        reason: checkpoint.reason,
        metadata: {
          checkpointId: checkpoint.checkpointId,
          delegationId: handle.delegationId,
          childThreadId: handle.childThreadId,
          resolvedBy: input.issuedBy ?? "operator",
        },
        createdAt: new Date().toISOString(),
      } satisfies ThreadCompactionEventRecord;
      assertCompactionEventInvariant(event, { summaryRequired: false });
      await this.store.appendThreadCompactionEvent(event);
      await this.store.appendRunEvent({
        runId: checkpointRunId,
        sessionId: status.thread.sessionId,
        type: "context.adaptation_applied",
        level: "INFO",
        timestamp: new Date().toISOString(),
        metadata: {
          threadId: input.threadId,
          checkpointId: checkpoint.checkpointId,
          action: "split_into_child_thread",
          delegationId: handle.delegationId,
          childThreadId: handle.childThreadId,
          reason: checkpoint.reason,
        },
      });
    }
    const resolvedAt = new Date().toISOString();
    const resolved: ContextCheckpointRecord = {
      ...checkpoint,
      status: input.action === "continue" ? "DEFERRED" : "ACCEPTED",
      resolutionAction: input.action,
      resolvedBy: input.issuedBy ?? "operator",
      resolvedAt,
    };
    await this.store.upsertContextCheckpoint(resolved);
    await this.store.appendRunEvent({
      runId: checkpointRunId,
      sessionId: status.thread.sessionId,
      type: "context.checkpoint_resolved",
      level: "INFO",
      timestamp: resolvedAt,
      metadata: {
        threadId: input.threadId,
        checkpointId: input.checkpointId,
        action: input.action,
        issuedBy: input.issuedBy ?? "operator",
      },
    });
    return this.requireThreadStatus(input.threadId);
  }

  async focusThread(input: { threadId: string }): Promise<ThreadStatusSnapshot> {
    const status = await this.requireThreadStatus(input.threadId);
    await this.persistFocus(status.thread.sessionId, input.threadId, "operator");
    return status;
  }

  async approveAssemblyChange(input: {
    threadId: string;
    proposalId: string;
    issuedBy?: string | undefined;
    reason?: string | undefined;
  }): Promise<SubmitTurnResult> {
    const status = await this.requireThreadStatus(input.threadId);
    await this.persistFocus(status.thread.sessionId, input.threadId, input.issuedBy ?? "operator");
    const request = status.openRequests.find(
      (entry) =>
        entry.eventType === "runtime.assembly_change" &&
        entry.kind === "approval" &&
        entry.metadata?.proposalId === input.proposalId,
    );
    if (request === undefined) {
      throw createRuntimeFailure(
        "OPERATOR_ASSEMBLY_PROPOSAL_NOT_FOUND",
        `No pending assembly change proposal '${input.proposalId}' was found for thread '${input.threadId}'.`,
        { threadId: input.threadId, proposalId: input.proposalId },
      );
    }
    return this.requireAction("replyToRequest")({
      threadId: input.threadId,
      requestId: request.requestId,
      message: input.reason ?? "Approved runtime assembly change.",
      issuedBy: input.issuedBy ?? "operator",
      approve: true,
    });
  }

  async rejectAssemblyChange(input: {
    threadId: string;
    proposalId: string;
    issuedBy?: string | undefined;
    reason?: string | undefined;
  }): Promise<ThreadStatusSnapshot> {
    const status = await this.requireThreadStatus(input.threadId);
    await this.persistFocus(status.thread.sessionId, input.threadId, input.issuedBy ?? "operator");
    const request = status.openRequests.find(
      (entry) =>
        entry.eventType === "runtime.assembly_change" &&
        entry.kind === "approval" &&
        entry.metadata?.proposalId === input.proposalId,
    );
    if (request === undefined) {
      throw createRuntimeFailure(
        "OPERATOR_ASSEMBLY_PROPOSAL_NOT_FOUND",
        `No pending assembly change proposal '${input.proposalId}' was found for thread '${input.threadId}'.`,
        { threadId: input.threadId, proposalId: input.proposalId },
      );
    }
    await this.requireAction("replyToRequest")({
      threadId: input.threadId,
      requestId: request.requestId,
      message: input.reason ?? "Rejected runtime assembly change.",
      issuedBy: input.issuedBy ?? "operator",
      approve: false,
    });
    return this.requireThreadStatus(input.threadId);
  }

  async spawnChildThread(input: {
    threadId: string;
    prompt: string;
    title?: string | undefined;
    rolePrompt?: string | undefined;
    goal?: string | undefined;
    budget?: import("./contracts.js").ChildThreadBudget | undefined;
    resultContract?: string | undefined;
    supervisionGroupId?: string | undefined;
    reconciliationIntent?: "auto_when_safe" | "manual_review" | undefined;
    profileId?: string | undefined;
    provider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
    model?: string | undefined;
    skillPackId?: string | undefined;
    policy?: import("./contracts.js").ChildThreadPolicy | undefined;
    issuedBy?: string | undefined;
  }) {
    const status = await this.requireThreadStatus(input.threadId);
    await this.persistFocus(status.thread.sessionId, input.threadId, input.issuedBy ?? "operator");
    return this.requireAction("spawnDelegation")({
      parentThreadId: input.threadId,
      title: input.title ?? summarizeChildThreadTitle(input.prompt),
      prompt: input.prompt,
      ...(input.resultContract !== undefined ? { resultContract: input.resultContract } : {}),
      ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.skillPackId !== undefined ? { skillPackId: input.skillPackId } : {}),
      launchedBy: "operator",
      policy: buildSpawnChildThreadPolicy(input),
    });
  }

  async supersedeChildThread(input: SupersedeChildThreadInput): Promise<ThreadStatusSnapshot> {
    const status = await this.requireThreadStatus(input.threadId);
    await this.persistFocus(status.thread.sessionId, input.threadId, input.issuedBy ?? "operator");
    const delegation = await this.store.getDelegation(input.delegationId);
    if (delegation === null || delegation.parentThreadId !== input.threadId) {
      throw createRuntimeFailure(
        "OPERATOR_CHILD_DELEGATION_NOT_FOUND",
        `Delegation '${input.delegationId}' was not found for thread '${input.threadId}'.`,
        { threadId: input.threadId, delegationId: input.delegationId },
      );
    }
    const updated = updateDelegationOutcomePolicy({
      record: delegation,
      resultState: "superseded",
      outcomeReason: input.reason ?? "Superseded by operator.",
      supersededBy: input.issuedBy ?? "operator",
    });
    await this.store.upsertDelegation(updated);
    await this.store.appendRunEvent({
      runId: delegation.parentRunId ?? `delegation-${delegation.delegationId}`,
      sessionId: status.thread.sessionId,
      type: "delegation.superseded",
      level: "INFO",
      timestamp: new Date().toISOString(),
      metadata: {
        threadId: input.threadId,
        delegationId: input.delegationId,
        childThreadId: delegation.childThreadId,
        reason: input.reason ?? "Superseded by operator.",
      },
    });
    return this.requireThreadStatus(input.threadId);
  }

  async resolveFanInCheckpoint(input: import("./contracts.js").ResolveFanInCheckpointInput): Promise<ThreadStatusSnapshot> {
    const checkpoint = await this.store.getContextCheckpoint(input.checkpointId);
    if (checkpoint === null || checkpoint.threadId !== input.threadId) {
      throw createRuntimeFailure(
        "OPERATOR_FAN_IN_CHECKPOINT_NOT_FOUND",
        `Fan-in checkpoint '${input.checkpointId}' was not found for thread '${input.threadId}'.`,
        { checkpointId: input.checkpointId, threadId: input.threadId },
      );
    }
    if (checkpoint.status !== "PENDING") {
      throw createRuntimeFailure(
        "OPERATOR_FAN_IN_CHECKPOINT_NOT_PENDING",
        `Fan-in checkpoint '${input.checkpointId}' is already ${checkpoint.status.toLowerCase()}.`,
        { checkpointId: input.checkpointId, threadId: input.threadId, status: checkpoint.status },
      );
    }
    const status = await this.requireThreadStatus(input.threadId);
    await this.persistFocus(status.thread.sessionId, input.threadId, input.issuedBy ?? "operator");
    if (input.disposition === "defer") {
      await this.store.upsertContextCheckpoint({
        ...checkpoint,
        status: "DEFERRED",
        resolutionAction: "continue",
        resolvedBy: input.issuedBy ?? "operator",
        resolvedAt: new Date().toISOString(),
      });
      return this.requireThreadStatus(input.threadId);
    }
    const selectedDelegationIds =
      input.selectedDelegationIds ??
      (Array.isArray(checkpoint.metadata?.selectedDelegationIds)
        ? checkpoint.metadata.selectedDelegationIds.filter((value): value is string => typeof value === "string")
        : []);
    await this.store.appendRunEvent({
      runId: status.thread.activeRunId ?? `fanin-${input.threadId}`,
      sessionId: status.thread.sessionId,
      type: "delegation.reconciled",
      level: "INFO",
      timestamp: new Date().toISOString(),
      metadata: {
        threadId: input.threadId,
        checkpointId: checkpoint.checkpointId,
        selectedDelegationIds,
        disposition: "accepted",
        summary: input.summary ?? checkpoint.reason,
      },
    });
    await this.store.upsertContextCheckpoint({
      ...checkpoint,
      status: "ACCEPTED",
      resolutionAction: "operator_checkpoint",
      resolvedBy: input.issuedBy ?? "operator",
      resolvedAt: new Date().toISOString(),
    });
    return this.requireThreadStatus(input.threadId);
  }

  private async resolveThreads(input: {
    sessionId?: string | undefined;
    threadId?: string | undefined;
  }): Promise<ThreadRecord[]> {
    if (input.threadId !== undefined) {
      const thread = await this.store.getThread(input.threadId);
      return thread === null ? [] : [thread];
    }
    if (input.sessionId !== undefined) {
      const threads = await this.store.listThreads({ sessionId: input.sessionId });
      const ordered = sortThreadsForSession(threads);
      const focusThreadId = (await this.store.getOperatorFocus(input.sessionId))?.threadId;
      if (focusThreadId === undefined) {
        return ordered;
      }
      const focused = ordered.find((thread) => thread.threadId === focusThreadId);
      if (focused === undefined) {
        return ordered;
      }
      return [
        focused,
        ...ordered.filter((thread) => thread.threadId !== focused.threadId),
      ];
    }
    return this.store.listThreads();
  }

  private async resolveFocusedThreadId(
    threads: ThreadRecord[],
    input: { sessionId?: string | undefined; threadId?: string | undefined },
  ): Promise<string | undefined> {
    if (threads.length === 0) {
      return undefined;
    }
    if (input.threadId !== undefined) {
      return input.threadId;
    }
    if (input.sessionId !== undefined) {
      const focused = (await this.store.getOperatorFocus(input.sessionId))?.threadId;
      if (focused !== undefined && threads.some((thread) => thread.threadId === focused)) {
        return focused;
      }
    }
    const first = pickDefaultFocusThread(threads);
    if (first !== undefined) {
      await this.persistFocus(first.sessionId, first.threadId, "runtime");
      return first.threadId;
    }
    return undefined;
  }

  private async buildInboxItemsForThread(thread: ThreadRecord): Promise<OperatorInboxItem[]> {
    const items: OperatorInboxItem[] = [];
    const status = await this.runtime.getThreadStatus(thread.threadId);
    if (status === null) {
      return items;
    }
    for (const request of status.openRequests) {
      items.push(toRequestInboxItem(status.thread, request));
    }
    const assemblyProposals = await this.store.listAssemblyChangeProposals({
      threadId: thread.threadId,
      status: "PENDING",
    });
    for (const proposal of assemblyProposals) {
      items.push(toAssemblyProposalInboxItem(thread, proposal));
    }
    const doctor = await this.getDoctorForThread(thread);
    const compatibilityAlert = buildCompatibilityAlertInboxItem(thread, status);
    if (compatibilityAlert !== undefined) {
      items.push(compatibilityAlert);
    }
    const childOutcomes = await this.listChildOutcomeSummaries(thread.threadId);
    const fanInCheckpoint = status.contextCheckpoints.find(
      (entry) => entry.checkpointId === fanInCheckpointId(thread.threadId, defaultSupervisionGroupId(thread.threadId)),
    );
    if (fanInCheckpoint !== undefined) {
      items.push({
        itemId: fanInCheckpoint.checkpointId,
        kind: "fan_in_checkpoint",
        threadId: thread.threadId,
        sessionId: thread.sessionId,
        title: "Review child reconciliation before parent continues.",
        actionable: fanInCheckpoint.status === "PENDING",
        createdAt: fanInCheckpoint.createdAt,
        checkpointId: fanInCheckpoint.checkpointId,
        detail: fanInCheckpoint.reason,
      });
    }
    for (const child of childOutcomes.filter(
      (entry) => entry.outcomeState === "partial" || entry.outcomeState === "failed",
    )) {
      items.push({
        itemId: `child-outcome:${child.delegationId}`,
        kind: "child_outcome_review",
        threadId: thread.threadId,
        sessionId: thread.sessionId,
        title: `Review child outcome for ${child.title}.`,
        actionable: child.supersededAt === undefined,
        createdAt: child.updatedAt,
        delegationId: child.delegationId,
        childThreadId: child.threadId,
        detail: child.resultSummary ?? child.errorMessage ?? child.outcomeState,
      });
    }
    const attention = await this.syncOperatorAttention(thread, status, doctor);
    items.push(...attention.map((record) => toAttentionInboxItem(record)));
    return items;
  }

  private async listChildOutcomeSummaries(threadId: string) {
    const delegations = await this.store.listDelegations({
      parentThreadId: threadId,
    });
    return (
      await Promise.all(
        delegations.map(async (delegation) => {
          const childThread = await this.store.getThread(delegation.childThreadId);
          return toSupervisionChildSummary({
            delegation,
            childThread,
          });
        }),
      )
    ).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async persistFocus(sessionId: string, threadId: string, updatedBy: string): Promise<void> {
    await this.store.upsertOperatorFocus({
      sessionId,
      threadId,
      updatedAt: new Date().toISOString(),
      updatedBy,
    });
  }

  private async syncOperatorAttention(
    thread: ThreadRecord,
    status: ThreadStatusSnapshot,
    doctor: Awaited<ReturnType<OperatorControlPlane["getDoctorForThread"]>>,
  ): Promise<OperatorAttentionRecord[]> {
    const existing = await this.store.listOperatorAttention({
      threadId: thread.threadId,
    });
    const activeRecords: OperatorAttentionRecord[] = [];
    const activeKeys = new Set<string>();
    const pendingCheckpoints = status.contextCheckpoints.filter((entry) => entry.status === "PENDING");
    for (const checkpoint of pendingCheckpoints) {
      const record = await this.upsertAttentionRecord(
        existing,
        buildCheckpointAttention(thread, checkpoint),
      );
      activeRecords.push(record);
      activeKeys.add(attentionIdentity(record));
    }
    const blockerChain = await this.buildChildBlockerChain(thread);
    const dominantChildBlocker = blockerChain[blockerChain.length - 1];
    if (dominantChildBlocker?.delegationId !== undefined) {
      const record = await this.upsertAttentionRecord(
        existing,
        buildChildBlockerAttention(thread, dominantChildBlocker),
      );
      activeRecords.push(record);
      activeKeys.add(attentionIdentity(record));
    }
    if (doctor?.status === "STALLED") {
      const record = await this.upsertAttentionRecord(
        existing,
        buildStalledAttention(thread, doctor.dominantFailure?.message),
      );
      activeRecords.push(record);
      activeKeys.add(attentionIdentity(record));
    }
    for (const record of existing) {
      if (record.status !== "ACTIVE") {
        continue;
      }
      if (activeKeys.has(attentionIdentity(record))) {
        continue;
      }
      await this.store.upsertOperatorAttention({
        ...record,
        status: "RESOLVED",
        updatedAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
      });
    }
    return activeRecords.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async upsertAttentionRecord(
    existing: OperatorAttentionRecord[],
    next: OperatorAttentionRecord,
  ): Promise<OperatorAttentionRecord> {
    const prior = existing.find((record) => attentionIdentity(record) === attentionIdentity(next));
    const merged: OperatorAttentionRecord =
      prior === undefined
        ? next
        : {
            ...prior,
            ...next,
            attentionId: prior.attentionId,
            createdAt: prior.createdAt,
            status: "ACTIVE",
            resolvedAt: undefined,
          };
    await this.store.upsertOperatorAttention(merged);
    return merged;
  }

  private async buildChildBlockerChain(thread: ThreadRecord): Promise<OperatorChildBlockerChainEntry[]> {
    const chain: OperatorChildBlockerChainEntry[] = [];
    let currentThreadId = thread.threadId;
    const visited = new Set<string>();
    while (visited.has(currentThreadId) === false) {
      visited.add(currentThreadId);
      const next = await this.findDominantChildBlocker(currentThreadId);
      if (next === undefined) {
        break;
      }
      chain.push(next);
      currentThreadId = next.threadId;
    }
    return chain;
  }

  private async findDominantChildBlocker(threadId: string): Promise<OperatorChildBlockerChainEntry | undefined> {
    const delegations = (await this.store.listDelegations({
      parentThreadId: threadId,
    })).filter((delegation) => {
      const supervision = readSupervisionPolicy(delegation.policy);
      if (supervision?.resultState === "superseded") {
        return false;
      }
      return delegation.status === "WAITING" || delegation.status === "FAILED";
    });
    const candidates = await Promise.all(
      delegations.map(async (delegation) => {
        const child = await this.store.getThread(delegation.childThreadId);
        if (child === null) {
          return undefined;
        }
        return {
          delegation,
          child,
        };
      }),
    );
    const winner = candidates
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .sort((left, right) => {
        return right.child.updatedAt.localeCompare(left.child.updatedAt);
      })[0];
    if (winner === undefined) {
      return undefined;
    }
    return {
      threadId: winner.child.threadId,
      title: winner.child.title,
      status: winner.child.status,
      delegationId: winner.delegation.delegationId,
      ...(winner.child.waitFor?.eventType !== undefined ? { waitEventType: winner.child.waitFor.eventType } : {}),
      reason:
        winner.delegation.errorMessage ??
        winner.delegation.waitEventType ??
        winner.delegation.resultSummary,
    };
  }

  private async getDoctorForThread(thread: ThreadRecord) {
    if (thread.activeRunId === undefined) {
      return undefined;
    }
    const replay = await this.replay.replay({
      runId: thread.activeRunId,
      threadId: thread.threadId,
      limit: 200,
    });
    return this.replay.doctor(replay);
  }

  private async requireThreadStatus(threadId: string): Promise<ThreadStatusSnapshot> {
    const status = await this.runtime.getThreadStatus(threadId);
    if (status === null) {
      throw createRuntimeFailure("OPERATOR_THREAD_NOT_FOUND", `Thread '${threadId}' was not found.`, {
        threadId,
      });
    }
    return status;
  }

  private requireAction<TName extends "replyToRequest" | "submitTurn" | "spawnDelegation">(
    name: TName,
  ): NonNullable<(typeof this.runtime)[TName]> {
    const action = this.runtime[name];
    if (action === undefined) {
      throw createRuntimeFailure(
        "OPERATOR_CONTROL_ACTION_UNAVAILABLE",
        `Operator action '${name}' is unavailable in this runtime.`,
        { action: name },
      );
    }
    return action;
  }

  private async persistCheckpointSummaryAction(input: {
    thread: ThreadRecord;
    checkpoint: ContextCheckpointRecord;
    runId: string;
    action: "compact" | "summarize_forward";
    source: import("../kestrel/contracts/orchestration.js").ContextSummaryArtifactRecord["source"];
    issuedBy: string;
  }): Promise<void> {
    const artifactId = `context-summary-${randomUUID()}`;
    const priorSummary = (await this.store.listContextSummaryArtifacts(input.thread.threadId))
      .find((summary) => summary.artifactId !== artifactId);
    await this.store.saveContextSummaryArtifact({
      artifactId,
      threadId: input.thread.threadId,
      runId: input.runId,
      summary: buildCheckpointContinuationBrief(input.thread, input.checkpoint, priorSummary),
      source: input.source,
      metadata: {
        checkpointId: input.checkpoint.checkpointId,
        reason: input.checkpoint.reason,
        action: input.action,
      },
      createdAt: new Date().toISOString(),
    });
    const eventId = `compaction-${randomUUID()}`;
    const event: ThreadCompactionEventRecord = {
      eventId,
      threadId: input.thread.threadId,
      runId: input.runId,
      action: input.action,
      reason: input.checkpoint.reason,
      summaryArtifactId: artifactId,
      metadata: {
        checkpointId: input.checkpoint.checkpointId,
        resolvedBy: input.issuedBy,
      },
      createdAt: new Date().toISOString(),
    };
    assertCompactionEventInvariant(event, { summaryRequired: true });
    await this.store.appendThreadCompactionEvent(event);
    await this.store.appendRunEvent({
      runId: input.runId,
      sessionId: input.thread.sessionId,
      type: input.action === "compact" ? "context.compaction_applied" : "context.adaptation_applied",
      level: "INFO",
      timestamp: new Date().toISOString(),
      metadata: {
        threadId: input.thread.threadId,
        checkpointId: input.checkpoint.checkpointId,
        compactionEventId: eventId,
        summaryArtifactId: artifactId,
        action: input.action,
        reason: input.checkpoint.reason,
      },
    });
  }
}

function assertCompactionEventInvariant(
  event: ThreadCompactionEventRecord,
  options: { summaryRequired: boolean },
): void {
  const missing: string[] = [];
  if (event.threadId.trim().length === 0) {
    missing.push("threadId");
  }
  if (event.runId === undefined || event.runId.trim().length === 0) {
    missing.push("runId");
  }
  if (event.action.trim().length === 0) {
    missing.push("action");
  }
  if (event.reason.trim().length === 0) {
    missing.push("reason");
  }
  if (
    options.summaryRequired &&
    (event.summaryArtifactId === undefined || event.summaryArtifactId.trim().length === 0)
  ) {
    missing.push("summaryArtifactId");
  }
  if (missing.length > 0) {
    throw createRuntimeFailure(
      "COMPACTION_EVENT_INVALID",
      `Invalid compaction event record; missing ${missing.join(", ")}`,
      { missing },
    );
  }
}

function toRequestInboxItem(thread: ThreadRecord, request: InteractionRequestRecord): OperatorInboxItem {
  return {
    itemId: `request:${request.requestId}`,
    kind: request.kind === "approval" ? "approval_request" : "user_input_request",
    threadId: thread.threadId,
    sessionId: thread.sessionId,
    title: request.prompt ?? `${request.kind} required`,
    actionable: true,
    createdAt: request.createdAt,
    requestId: request.requestId,
    ...(request.delegationId !== undefined ? { delegationId: request.delegationId } : {}),
    recommendedAction: request.kind === "approval" ? "approve" : "reply",
    detail: request.eventType,
    ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
  };
}

function toAssemblyProposalInboxItem(
  thread: ThreadRecord,
  proposal: AssemblyChangeProposalRecord,
): OperatorInboxItem {
  return {
    itemId: `proposal:${proposal.proposalId}`,
    kind: "assembly_change_proposal",
    threadId: thread.threadId,
    sessionId: thread.sessionId,
    title: proposal.reason ?? `Assembly change proposed for '${thread.title}'.`,
    actionable: true,
    createdAt: proposal.createdAt,
    recommendedAction: "approve_assembly_change",
    detail:
      proposal.requestedBundleId ??
      proposal.requestedToolAllowlist?.join(", ") ??
      "Assembly proposal pending operator approval.",
    metadata: {
      proposalId: proposal.proposalId,
      proposedBy: proposal.proposedBy,
      ...(proposal.requestedBundleId !== undefined ? { requestedBundleId: proposal.requestedBundleId } : {}),
      ...(proposal.requestedToolAllowlist !== undefined ? { requestedToolAllowlist: proposal.requestedToolAllowlist } : {}),
    },
  };
}

function buildCompatibilityAlertInboxItem(
  thread: ThreadRecord,
  status: ThreadStatusSnapshot,
): OperatorInboxItem | undefined {
  const metadata = status.assemblyBundle?.metadata;
  if (metadata === undefined) {
    return undefined;
  }
  const compatibilityStatus = asString(metadata.compatibilityStatus);
  const downgradeReason = asString(metadata.downgradeReason);
  const capabilityLossReason = asString(metadata.capabilityLossReason);
  if (compatibilityStatus !== "downgraded" && downgradeReason === undefined && capabilityLossReason === undefined) {
    return undefined;
  }
  return {
    itemId: `compatibility:${thread.threadId}:${status.activeAssembly?.recordId ?? "active"}`,
    kind: "compatibility_downgrade_attention",
    threadId: thread.threadId,
    sessionId: thread.sessionId,
    title: `Runtime compatibility changed for '${thread.title}'.`,
    actionable: true,
    createdAt: status.activeAssembly?.createdAt ?? thread.updatedAt,
    recommendedAction: "focus_thread",
    detail: capabilityLossReason ?? downgradeReason ?? "Runtime compatibility downgraded.",
    metadata: {
      compatibilityStatus,
      ...(downgradeReason !== undefined ? { downgradeReason } : {}),
      ...(capabilityLossReason !== undefined ? { capabilityLossReason } : {}),
    },
  };
}

function toAttentionInboxItem(record: OperatorAttentionRecord): OperatorInboxItem {
  return {
    itemId: `attention:${record.attentionId}`,
    kind: record.kind,
    threadId: record.threadId,
    sessionId: record.sessionId,
    title: record.title,
    actionable: record.status === "ACTIVE",
    createdAt: record.createdAt,
    ...(record.checkpointId !== undefined ? { checkpointId: record.checkpointId } : {}),
    ...(record.delegationId !== undefined ? { delegationId: record.delegationId } : {}),
    ...(record.childThreadId !== undefined ? { childThreadId: record.childThreadId } : {}),
    ...(record.recommendedAction !== undefined ? { recommendedAction: record.recommendedAction } : {}),
    ...(record.detail !== undefined ? { detail: record.detail } : {}),
    ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
  };
}

function deriveNextActionSummary(
  status: ThreadStatusSnapshot,
  waitKind: string | undefined,
  checkpoint: ContextCheckpointRecord | undefined,
  blocker: OperatorThreadView["blocker"] | undefined,
  fanInDisposition: FanInDispositionSummary | undefined,
  assemblyProposal: AssemblyChangeProposalRecord | undefined,
): OperatorNextActionSummary | undefined {
  if (fanInDisposition?.status === "pending_checkpoint" && fanInDisposition.checkpointId !== undefined) {
    return {
      kind: "resolve_fan_in_checkpoint",
      summary: fanInDisposition.summary ?? "Resolve fan-in checkpoint.",
      threadId: status.thread.threadId,
      checkpointId: fanInDisposition.checkpointId,
    };
  }
  if (checkpoint?.status === "PENDING") {
    return {
      kind: "resolve_context_checkpoint",
      summary: `Resolve context checkpoint: ${checkpoint.recommendedAction}`,
      threadId: checkpoint.threadId,
      checkpointId: checkpoint.checkpointId,
    };
  }
  if (assemblyProposal !== undefined) {
    return {
      kind: "approve_assembly_change",
      summary: assemblyProposal.reason ?? "Review pending assembly change proposal.",
      threadId: status.thread.threadId,
      proposalId: assemblyProposal.proposalId,
    };
  }
  const approval = status.openRequests.find((request) => request.kind === "approval");
  if (approval !== undefined) {
    return {
      kind: "approve",
      summary: approval.prompt ?? "Approve pending request.",
      threadId: approval.threadId,
      requestId: approval.requestId,
    };
  }
  const reply = status.openRequests.find((request) => request.kind === "user_input");
  if (reply !== undefined) {
    return {
      kind: "reply",
      summary: reply.prompt ?? "Reply to pending user input request.",
      threadId: reply.threadId,
      requestId: reply.requestId,
    };
  }
  if (blocker?.kind === "child_thread" && blocker.childThreadId !== undefined) {
    return {
      kind: "switch_thread",
      summary: `Switch focus to child thread ${blocker.childThreadId}.`,
      threadId: blocker.threadId,
      childThreadId: blocker.childThreadId,
    };
  }
  if (status.thread.lastRunStatus === "FAILED") {
    return {
      kind: "retry",
      summary: "Retry the failed thread.",
      threadId: status.thread.threadId,
    };
  }
  if (waitKind !== undefined) {
    return {
      kind: "wait",
      summary: `Wait for ${waitKind}.`,
      threadId: status.thread.threadId,
    };
  }
  return undefined;
}

function deriveBlockerSummary(
  status: ThreadStatusSnapshot,
  doctor: Awaited<ReturnType<OperatorControlPlane["getDoctorForThread"]>> | undefined,
  checkpoint: ContextCheckpointRecord | undefined,
  childBlocker: OperatorChildBlockerChainEntry | undefined,
  doctorChildBlocker: NonNullable<
    Awaited<ReturnType<OperatorControlPlane["getDoctorForThread"]>>
  >["childBlocker"] | undefined,
): OperatorThreadView["blocker"] | undefined {
  if (checkpoint?.status === "PENDING") {
    return {
      kind: "checkpoint",
      summary: checkpoint.reason,
      actionable: true,
      threadId: checkpoint.threadId,
      checkpointId: checkpoint.checkpointId,
    };
  }
  if (status.openRequests[0] !== undefined) {
    const request = status.openRequests[0];
    return {
      kind: "wait",
      summary: request.prompt ?? request.eventType,
      actionable: true,
      threadId: request.threadId,
      requestId: request.requestId,
      ...(request.eventType !== undefined ? { eventType: request.eventType } : {}),
    };
  }
  if (childBlocker?.delegationId !== undefined) {
    return {
      kind: "child_thread",
      summary: childBlocker.reason ?? `Child thread ${childBlocker.threadId} is blocking progress.`,
      actionable: true,
      threadId: status.thread.threadId,
      childThreadId: childBlocker.threadId,
      delegationId: childBlocker.delegationId,
      ...(childBlocker.waitEventType !== undefined ? { eventType: childBlocker.waitEventType } : {}),
    };
  }
  if (doctorChildBlocker !== undefined) {
    return {
      kind: "child_thread",
      summary:
        doctorChildBlocker.reason ??
        `Child thread ${doctorChildBlocker.childThreadId} is blocking progress.`,
      actionable: true,
      threadId: status.thread.threadId,
      childThreadId: doctorChildBlocker.childThreadId,
      delegationId: doctorChildBlocker.delegationId,
    };
  }
  if (doctor?.status === "STALLED") {
    return {
      kind: "stalled",
      summary: doctor.dominantFailure?.message ?? "No forward progress detected.",
      actionable: true,
      threadId: status.thread.threadId,
    };
  }
  if (doctor?.wait !== undefined) {
    return {
      kind: "wait",
      summary: doctor.wait.detail ?? doctor.wait.eventType ?? "Waiting for input",
      actionable: doctor.wait.actionable,
      threadId: doctor.wait.threadId,
      ...(doctor.wait.requestId !== undefined ? { requestId: doctor.wait.requestId } : {}),
      ...(doctor.wait.eventType !== undefined ? { eventType: doctor.wait.eventType } : {}),
    };
  }
  return undefined;
}

function deriveContextPosture(
  status: ThreadStatusSnapshot,
  checkpoint: ContextCheckpointRecord | undefined,
): OperatorContextPostureSummary | undefined {
  if (checkpoint?.status === "PENDING") {
    return {
      status: "checkpoint_pending",
      summary: checkpoint.reason,
      checkpointId: checkpoint.checkpointId,
    };
  }
  const compactionState = asString(status.thread.metadata?.autoCompactionState);
  if (compactionState !== undefined) {
    return {
      status: compactionState === "applied" ? "compacted" : "degraded",
      summary: `Context posture: ${compactionState}`,
      compactionState,
    };
  }
  if (status.latestSummary !== undefined) {
    return {
      status: "compacted",
      summary: "Context summary artifact is authoritative.",
    };
  }
  return {
    status: "healthy",
    summary: "No active checkpoint or compaction posture recorded.",
  };
}

function normalizeAdaptationSummary(summary: ReplayAdaptationSummary): AdaptationSummary {
  const recommendedAction = summary.recommendedAction;
  return {
    ...summary,
    recommendedAction:
      recommendedAction === "compact" ||
      recommendedAction === "continue" ||
      recommendedAction === "summarize_forward" ||
      recommendedAction === "handoff" ||
      recommendedAction === "split_into_child_thread" ||
      recommendedAction === "operator_checkpoint"
        ? recommendedAction
        : undefined,
  };
}

function normalizeEvidenceRecoverySummary(
  summary: ReplayEvidenceRecoverySummary,
): OperatorEvidenceRecoverySummary {
  return {
    attempts: summary.attempts,
    consecutiveLowSignal: summary.consecutiveLowSignal,
    lowSignalAttempts: summary.lowSignalAttempts,
    broadenedSearchUsed: summary.broadenedSearchUsed,
    targetedFetchUsed: summary.targetedFetchUsed,
    ...(summary.family !== undefined ? { family: summary.family } : {}),
    ...(summary.latestQuality !== undefined ? { latestQuality: summary.latestQuality } : {}),
    ...(summary.latestIssues !== undefined ? { latestIssues: summary.latestIssues } : {}),
    ...(summary.terminalOutcome !== undefined ? { terminalOutcome: summary.terminalOutcome } : {}),
  };
}

function findLatestCheckpointDisposition(
  checkpoints: ContextCheckpointRecord[],
): OperatorThreadView["latestCheckpointDisposition"] | undefined {
  const resolved = checkpoints
    .filter((entry) => entry.status !== "PENDING")
    .sort((left, right) => {
      const leftAt = left.resolvedAt ?? left.createdAt;
      const rightAt = right.resolvedAt ?? right.createdAt;
      return rightAt.localeCompare(leftAt);
    });
  const selected = resolved.find((entry) => entry.resolutionAction !== undefined) ?? resolved[0];
  if (selected === undefined) {
    return undefined;
  }
  return {
    status: selected.status,
    ...(selected.resolutionAction !== undefined
      ? { action: selected.resolutionAction }
      : selected.recommendedAction !== undefined
        ? { action: selected.recommendedAction }
        : {}),
    ...(selected.resolvedAt !== undefined ? { resolvedAt: selected.resolvedAt } : {}),
    ...(selected.resolvedBy !== undefined ? { resolvedBy: selected.resolvedBy } : {}),
  };
}

function buildCheckpointAttention(
  thread: ThreadRecord,
  checkpoint: ContextCheckpointRecord,
): OperatorAttentionRecord {
  return {
    attentionId: `checkpoint:${checkpoint.checkpointId}`,
    sessionId: thread.sessionId,
    threadId: thread.threadId,
    kind: "context_checkpoint",
    status: "ACTIVE",
    title: checkpoint.reason,
    detail: checkpoint.reason,
    checkpointId: checkpoint.checkpointId,
    recommendedAction: checkpoint.recommendedAction,
    metadata: checkpoint.signals,
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.resolvedAt ?? checkpoint.createdAt,
  };
}

function buildChildBlockerAttention(
  thread: ThreadRecord,
  blocker: OperatorChildBlockerChainEntry,
): OperatorAttentionRecord {
  return {
    attentionId: `child:${thread.threadId}:${blocker.delegationId ?? blocker.threadId}`,
    sessionId: thread.sessionId,
    threadId: thread.threadId,
    kind: "child_thread_blocker",
    status: "ACTIVE",
    title: blocker.title,
    detail: blocker.reason ?? blocker.waitEventType ?? "Child thread is blocking progress.",
    delegationId: blocker.delegationId,
    childThreadId: blocker.threadId,
    recommendedAction: "switch_thread",
    metadata: {
      status: blocker.status,
      ...(blocker.waitEventType !== undefined ? { waitEventType: blocker.waitEventType } : {}),
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function buildStalledAttention(thread: ThreadRecord, detail: string | undefined): OperatorAttentionRecord {
  const now = new Date().toISOString();
  return {
    attentionId: `stalled:${thread.threadId}`,
    sessionId: thread.sessionId,
    threadId: thread.threadId,
    kind: "stalled_thread_attention",
    status: "ACTIVE",
    title: `Thread '${thread.title}' appears stalled.`,
    detail: detail ?? "No forward progress detected.",
    recommendedAction: "retry",
    createdAt: now,
    updatedAt: now,
  };
}

function attentionIdentity(record: Pick<OperatorAttentionRecord, "kind" | "threadId" | "checkpointId" | "delegationId" | "childThreadId">): string {
  return [
    record.kind,
    record.threadId,
    record.checkpointId ?? "",
    record.delegationId ?? "",
    record.childThreadId ?? "",
  ].join(":");
}

function delegationStatusRank(status: DelegationRecord["status"]): number {
  switch (status) {
    case "WAITING":
      return 0;
    case "FAILED":
      return 1;
    case "RUNNING":
      return 2;
    case "PENDING":
      return 3;
    case "COMPLETED":
      return 4;
    default:
      return 5;
  }
}

function buildCheckpointContinuationBrief(
  thread: ThreadRecord,
  checkpoint: ContextCheckpointRecord,
  priorSummary: ContextSummaryArtifactRecord | undefined,
): string {
  const history = readThreadHistory(thread);
  const firstUser = history.find((line) => line.role === "user");
  const latestUser = [...history].reverse().find((line) => line.role === "user");
  const latestAssistant = [...history]
    .reverse()
    .find((line): line is { role: "assistant"; text: string } => line.role === "assistant");
  const priorStructuredSummary = asRecord(priorSummary?.metadata?.structuredSummary);
  const priorSummaryText = asString(priorSummary?.summary);
  const priorCompleted = readStringArray(priorStructuredSummary?.completedWork);
  const priorDecisions = readStringArray(priorStructuredSummary?.decisions);
  const priorArtifacts = readStringArray(priorStructuredSummary?.artifactsFiles);
  const priorNextAction = asString(priorStructuredSummary?.nextAction);
  const signalSummary = summarizeCheckpointSignals(checkpoint.signals);
  const currentRequest =
    latestUser !== undefined && latestUser !== firstUser
      ? `The latest user request is: "${clampLine(latestUser.text, 240)}".`
      : undefined;
  const priorState = buildPriorStateLine({ latestAssistant, priorCompleted, priorSummaryText });
  const decisions = priorDecisions.length > 0
    ? `Decisions to preserve: ${clampLine(priorDecisions.slice(0, 3).join("; "), 320)}.`
    : undefined;
  const artifacts = priorArtifacts.length > 0
    ? `Files/artifacts already in play: ${clampLine(priorArtifacts.slice(0, 5).join("; "), 260)}.`
    : undefined;
  const nextAction = priorNextAction !== undefined
    ? `Next action from preserved state: ${clampLine(priorNextAction, 240)}.`
    : "Next behavior: continue from the latest concrete state, preserve decisions already made, verify before acting when context is ambiguous, and move the task forward.";
  const requiredLines = [
    "You are resuming an in-progress Kestrel thread after an accepted context checkpoint. Treat this as a continuation handoff, not a new task.",
    "Use the preserved transcript, current runtime state, tool results, and files as the source of truth. Use this handoff only to orient attention when older context is compressed.",
    firstUser !== undefined
      ? `Original task: ${clampLine(firstUser.text, 240)}`
      : `Thread: ${clampLine(thread.title, 160)}`,
    currentRequest,
    priorState,
    `Checkpoint: ${checkpoint.recommendedAction}; reason: ${clampLine(checkpoint.reason, 240)}.`,
    nextAction,
    "Do not restart the task, repeat prior summaries, invent missing state, or treat this checkpoint as evidence that the task is complete.",
  ].filter((line): line is string => line !== undefined);
  const optionalLines = [
    decisions,
    artifacts,
    signalSummary !== undefined ? `Runtime signals: ${signalSummary}.` : undefined,
  ].filter((line): line is string => line !== undefined);
  let brief = requiredLines.join("\n");
  for (const line of optionalLines) {
    const candidate = `${brief}\n${line}`;
    if (candidate.length <= 1_200) {
      brief = candidate;
    }
  }
  return brief;
}

function buildPriorStateLine(input: {
  latestAssistant: { role: "assistant"; text: string } | undefined;
  priorCompleted: string[];
  priorSummaryText: string | undefined;
}): string | undefined {
  if (input.priorCompleted.length > 0) {
    return `Work already done/current state: ${clampLine(input.priorCompleted.slice(0, 3).join("; "), 320)}.`;
  }
  if (input.priorSummaryText !== undefined) {
    return `Work already done/current state from the prior authoritative summary: ${clampLine(input.priorSummaryText, 320)}.`;
  }
  if (input.latestAssistant !== undefined) {
    return `The latest assistant-visible state before this checkpoint was: "${clampLine(input.latestAssistant.text, 280)}".`;
  }
  return undefined;
}

function readThreadHistory(thread: ThreadRecord): Array<{ role: "user" | "assistant"; text: string }> {
  const history = Array.isArray(thread.metadata?.history) ? thread.metadata.history : [];
  return history.flatMap((entry) => {
    const record = asRecord(entry);
    const role = record?.role;
    const text = asString(record?.text);
    if ((role !== "user" && role !== "assistant") || text === undefined) {
      return [];
    }
    return [{ role, text }];
  });
}

function summarizeCheckpointSignals(signals: Record<string, unknown> | undefined): string | undefined {
  if (signals === undefined) {
    return undefined;
  }
  const entries = Object.entries(signals)
    .filter(([, value]) => value !== undefined && value !== null)
    .slice(0, 4)
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.length > 0 ? clampLine(entries.join("; "), 240) : undefined;
}

function clampLine(value: string, limit: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, Math.max(0, limit - 3))}...`;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function summarizeChildThreadTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, " ").trim();
  if (normalized.length <= 72) {
    return normalized.length > 0 ? normalized : "Operator child thread";
  }
  return `${normalized.slice(0, 69)}...`;
}

function buildSpawnChildThreadPolicy(input: {
  threadId: string;
  rolePrompt?: string | undefined;
  goal?: string | undefined;
  budget?: import("./contracts.js").ChildThreadBudget | undefined;
  supervisionGroupId?: string | undefined;
  reconciliationIntent?: "auto_when_safe" | "manual_review" | undefined;
  policy?: ChildThreadPolicy | undefined;
}): ChildThreadPolicy {
  const existing = readSupervisionPolicy(input.policy);
  const supervision: ChildThreadSupervisionPolicy = {
    groupId: input.supervisionGroupId ?? existing?.groupId ?? defaultSupervisionGroupId(input.threadId),
    ...(input.rolePrompt !== undefined
      ? { rolePrompt: input.rolePrompt }
      : existing?.rolePrompt !== undefined
        ? { rolePrompt: existing.rolePrompt }
        : {}),
    ...(input.goal !== undefined
      ? { goal: input.goal }
      : existing?.goal !== undefined
        ? { goal: existing.goal }
        : {}),
    ...(input.budget !== undefined
      ? { budget: input.budget }
      : existing?.budget !== undefined
        ? { budget: existing.budget }
        : {}),
    reconciliationIntent: input.reconciliationIntent ?? existing?.reconciliationIntent ?? "auto_when_safe",
    resultState: "running",
  };
  return {
    ...(input.policy ?? {}),
    supervision,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value) === false) {
    return undefined;
  }
  const strings = value
    .map((entry) => asString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return strings.length > 0 ? strings : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined && value.length > 0))];
}

function buildOperatorSessionIndex(
  runs: OperatorRunIndexView["runs"],
): OperatorRunIndexView["sessions"] {
  const sessions = new Map<string, OperatorRunIndexView["sessions"][number]>();
  for (const entry of runs) {
    const existing = sessions.get(entry.run.sessionId);
    if (existing === undefined) {
      sessions.set(entry.run.sessionId, {
        sessionId: entry.run.sessionId,
        runCount: 1,
        statusCounts: {
          RUNNING: entry.run.status === "RUNNING" ? 1 : 0,
          WAITING: entry.run.status === "WAITING" ? 1 : 0,
          COMPLETED: entry.run.status === "COMPLETED" ? 1 : 0,
          FAILED: entry.run.status === "FAILED" ? 1 : 0,
        },
        latestRunId: entry.run.runId,
        latestStatus: entry.run.status,
        latestStartedAt: entry.run.startedAt,
      });
      continue;
    }
    existing.runCount += 1;
    existing.statusCounts[entry.run.status] += 1;
    if (entry.run.startedAt > existing.latestStartedAt) {
      existing.latestRunId = entry.run.runId;
      existing.latestStatus = entry.run.status;
      existing.latestStartedAt = entry.run.startedAt;
    }
  }
  return [...sessions.values()].sort(
    (left, right) => right.latestStartedAt.localeCompare(left.latestStartedAt),
  );
}

function projectRuntimePlan(
  plan: ReplayRuntimePlanSummary | undefined,
): OperatorRuntimePlanSummary | undefined {
  if (plan === undefined) {
    return undefined;
  }
  return {
    ...(plan.phase !== undefined ? { phase: plan.phase } : {}),
    ...(plan.currentChunk !== undefined ? { currentChunk: plan.currentChunk } : {}),
    ...(plan.status !== undefined ? { status: plan.status } : {}),
    ...(plan.expectedNextCommand !== undefined
      ? { expectedNextCommand: plan.expectedNextCommand }
      : {}),
    ...(plan.waitReason !== undefined ? { waitReason: plan.waitReason } : {}),
    ...(plan.blocker !== undefined ? { blocker: plan.blocker } : {}),
    ...(plan.commandBatchId !== undefined ? { commandBatchId: plan.commandBatchId } : {}),
    ...(plan.executionMode !== undefined ? { executionMode: plan.executionMode } : {}),
    ...(plan.commandNames !== undefined ? { commandNames: [...plan.commandNames] } : {}),
    ...(plan.lastCheckpoint !== undefined
      ? {
          lastCheckpoint: {
            ...(plan.lastCheckpoint.substate !== undefined
              ? { substate: plan.lastCheckpoint.substate }
              : {}),
            ...(plan.lastCheckpoint.currentStepAgent !== undefined
              ? { currentStepAgent: plan.lastCheckpoint.currentStepAgent }
              : {}),
            ...(plan.lastCheckpoint.nextStepAgent !== undefined
              ? { nextStepAgent: plan.lastCheckpoint.nextStepAgent }
              : {}),
            ...(plan.lastCheckpoint.updatedAtStepIndex !== undefined
              ? { updatedAtStepIndex: plan.lastCheckpoint.updatedAtStepIndex }
              : {}),
          },
        }
      : {}),
  };
}

function toOperatorChildResultSummary(
  child: NonNullable<OperatorThreadView["childOutcomes"]>[number],
): OperatorChildResultSummary {
  return {
    threadId: child.threadId,
    title: child.title,
    status: child.status,
    updatedAt: child.updatedAt,
    ...(child.delegationId !== undefined ? { delegationId: child.delegationId } : {}),
    ...(child.result?.status !== undefined ? { resultStatus: child.result.status } : {}),
    ...(child.result?.result !== undefined
      ? { result: child.result.result }
      : child.resultSummary !== undefined
        ? { result: child.resultSummary }
        : {}),
    ...(child.errorCode !== undefined
      ? { errorCode: child.errorCode }
      : child.result?.error?.code !== undefined
        ? { errorCode: child.result.error.code }
        : {}),
    ...(child.errorMessage !== undefined
      ? { errorMessage: child.errorMessage }
      : child.result?.error?.message !== undefined
        ? { errorMessage: child.result.error.message }
        : {}),
    ...(child.references !== undefined
      ? { references: child.references }
      : child.result?.references !== undefined
        ? { references: child.result.references }
        : {}),
    ...(child.waitEventType !== undefined ? { waitEventType: child.waitEventType } : {}),
  };
}

function deriveRuntimePlanSummary(state: Record<string, unknown> | undefined): OperatorRuntimePlanSummary | undefined {
  const react = asRecord(state?.react);
  if (react === undefined) {
    return undefined;
  }
  const workingPlan = asRecord(react.workingPlan);
  const commandProcessor = asRecord(react.commandProcessor);
  const lastCheckpoint = asRecord(commandProcessor?.lastCheckpoint);
  if (workingPlan === undefined && commandProcessor === undefined) {
    return undefined;
  }
  const checkpoint =
    lastCheckpoint === undefined
      ? undefined
      : {
          ...(asString(lastCheckpoint.substate) !== undefined ? { substate: asString(lastCheckpoint.substate) } : {}),
          ...(asString(lastCheckpoint.currentStepAgent) !== undefined
            ? { currentStepAgent: asString(lastCheckpoint.currentStepAgent) }
            : {}),
          ...(asString(lastCheckpoint.nextStepAgent) !== undefined
            ? { nextStepAgent: asString(lastCheckpoint.nextStepAgent) }
            : {}),
          ...(asNumber(lastCheckpoint.updatedAtStepIndex) !== undefined
            ? { updatedAtStepIndex: asNumber(lastCheckpoint.updatedAtStepIndex) }
            : {}),
        };
  return {
    ...(asString(react.phase) !== undefined ? { phase: asString(react.phase) } : {}),
    ...(asString(workingPlan?.currentChunk) !== undefined ? { currentChunk: asString(workingPlan?.currentChunk) } : {}),
    ...(asString(workingPlan?.status) !== undefined ? { status: asString(workingPlan?.status) } : {}),
    ...(asString(workingPlan?.expectedNextCommand) !== undefined
      ? { expectedNextCommand: asString(workingPlan?.expectedNextCommand) }
      : {}),
    ...(asString(workingPlan?.waitReason) !== undefined ? { waitReason: asString(workingPlan?.waitReason) } : {}),
    ...(asString(workingPlan?.blocker) !== undefined ? { blocker: asString(workingPlan?.blocker) } : {}),
    ...(asString(commandProcessor?.batchId) !== undefined ? { commandBatchId: asString(commandProcessor?.batchId) } : {}),
    ...(asString(commandProcessor?.executionMode) !== undefined
      ? { executionMode: asString(commandProcessor?.executionMode) }
      : {}),
    ...(asStringArray(commandProcessor?.commandNames) !== undefined
      ? { commandNames: asStringArray(commandProcessor?.commandNames) }
      : asStringArray(workingPlan?.commandNames) !== undefined
        ? { commandNames: asStringArray(workingPlan?.commandNames) }
        : {}),
    ...(checkpoint !== undefined && Object.keys(checkpoint).length > 0 ? { lastCheckpoint: checkpoint } : {}),
  };
}

function deriveOperatorPhase(
  doctor: Awaited<ReturnType<OperatorControlPlane["getDoctorForThread"]>> | undefined,
): NonNullable<OperatorThreadView["operatorPhase"]> {
  if (doctor?.status === "COMPLETED" || doctor?.finalStep?.includes("finalize") === true) {
    return "finalize";
  }
  if (doctor?.wait !== undefined) {
    return "wait";
  }
  const latestStep = doctor?.lastMeaningfulProgress?.step;
  if (latestStep?.includes("observe") === true) {
    return "observe";
  }
  if (latestStep?.includes("exec") === true || latestStep?.includes("act") === true) {
    return "act";
  }
  if (latestStep?.includes("deliberate") === true || latestStep?.includes("resolver") === true) {
    return "decide";
  }
  return "assemble";
}

function sortThreadsForSession(threads: ThreadRecord[]): ThreadRecord[] {
  return [...threads].sort((left, right) => {
    const leftRoot = left.parentThreadId === undefined ? 0 : 1;
    const rightRoot = right.parentThreadId === undefined ? 0 : 1;
    if (leftRoot !== rightRoot) {
      return leftRoot - rightRoot;
    }
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

function pickDefaultFocusThread(threads: ThreadRecord[]): ThreadRecord | undefined {
  return sortThreadsForSession(threads)[0];
}
