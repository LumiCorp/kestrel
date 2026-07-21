import type {
  TransitionStatus,
} from "../kestrel/contracts/base.js";
import type {
  RunEvent,
} from "../kestrel/contracts/events.js";
import type {
  AssemblyBundleRecord,
  AssemblyChangeDecisionRecord,
  AssemblyChangeProposalRecord,
  ApprovalGrantRecord,
  ConversationTurnRecord,
  ConversationTurnSegmentRecord,
  ContextCheckpointRecord,
  ContextSummaryArtifactRecord,
  ContextPolicyDefinitionRecord,
  DelegationRecord,
  InteractionRequestRecord,
  ModelCallProvenanceRecord,
  SpecialistDefinitionRecord,
  ThreadCompactionEventRecord,
  ThreadAssemblyRecord,
  ThreadRecord,
} from "../kestrel/contracts/orchestration.js";
import type { ReplayStore } from "../kestrel/contracts/store.js";
import { readAssemblyCompatibilityMetadata } from "../orchestration/AssemblyCompatibility.js";
import {
  normalizeEvidenceRecoverySummary,
  type EvidenceRecoveryFamily,
} from "../runtime/evidenceQuality.js";

export interface ReplayQuery {
  runId?: string | undefined;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  delegationId?: string | undefined;
  fromTimestamp?: string | undefined;
  toTimestamp?: string | undefined;
  limit?: number | undefined;
}

export interface ReplayTransitionRecord {
  at: string;
  eventType: string;
  domain: "engine" | "agent" | "wait" | "scheduler" | "terminal" | "tooling";
  phase:
    | "selected"
    | "started"
    | "committed"
    | "transitioned"
    | "waiting"
    | "resumed"
    | "claimed"
    | "spawned"
    | "synced"
    | "loop_guard"
    | "terminal"
    | "other";
  step?: string | undefined;
  nextStep?: string | undefined;
  status?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ReplayTimelineEntry {
  seq: number;
  at: string;
  label: string;
  detail?: string | undefined;
  source: ReplayTransitionRecord["domain"];
  step?: string | undefined;
  stepIndex?: number | undefined;
}

export interface ReplaySummary {
  runId?: string | undefined;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  delegationId?: string | undefined;
  eventCount: number;
  firstEventAt?: string | undefined;
  lastEventAt?: string | undefined;
  terminalStatus?: TransitionStatus | undefined;
  stepsObserved: number;
  regionsStarted: number;
  regionsCompleted: number;
  syncNodesHit: number;
  mergeConflicts: number;
  progressStages: number;
  progressToolCalls: number;
  waitingMilestones: number;
  heartbeatLiveOnlyCount: number;
  schedulerActions: number;
  waitsEntered: number;
  waitsResumed: number;
  loopGuards: number;
  truncated: boolean;
  requestedLimit?: number | undefined;
}

export type ReplayGroupKind =
  | "step"
  | "wait"
  | "approval"
  | "assembly"
  | "delegation"
  | "compaction"
  | "scheduler"
  | "terminal"
  | "loop"
  | "other";

export interface ReplayTransitionGroup {
  seq: number;
  at: string;
  kind: ReplayGroupKind;
  label: string;
  detail?: string | undefined;
  source: ReplayTransitionRecord["domain"];
  runId: string;
  threadId?: string | undefined;
  delegationId?: string | undefined;
  requestId?: string | undefined;
  grantId?: string | undefined;
  step?: string | undefined;
  stepIndex?: number | undefined;
  eventTypes: string[];
}

export interface ThreadLineageReport {
  focusThread?: ThreadRecord | undefined;
  parentThread?: ThreadRecord | undefined;
  childThreads: ThreadRecord[];
  focusDelegation?: DelegationRecord | undefined;
  parentDelegation?: DelegationRecord | undefined;
  childDelegations: DelegationRecord[];
  relatedRunIds: string[];
  relatedDelegationIds: string[];
}

export type ReplayBlockingKind =
  | "approval"
  | "user_input"
  | "delegation"
  | "scheduler_wait"
  | "compaction_checkpoint"
  | "unknown";

export interface ActiveWaitReport {
  kind: ReplayBlockingKind;
  status: "active" | "resolved";
  actionable: boolean;
  eventType?: string | undefined;
  sourceEventType?: string | undefined;
  threadId?: string | undefined;
  runId?: string | undefined;
  delegationId?: string | undefined;
  requestId?: string | undefined;
  grantId?: string | undefined;
  resumeStepAgent?: string | undefined;
  enteredAt?: string | undefined;
  resolvedAt?: string | undefined;
  detail?: string | undefined;
  lineage: string[];
  metadata?: Record<string, unknown> | undefined;
}

export interface ApprovalChainReport {
  request: InteractionRequestRecord;
  grants: ApprovalGrantRecord[];
  latestGrant?: ApprovalGrantRecord | undefined;
  status: "pending" | "granted" | "resolved_without_grant";
  actionable: boolean;
}

export type DelegationOutcomeState =
  | "pending"
  | "running"
  | "blocked"
  | "partial"
  | "failed"
  | "completed"
  | "superseded"
  | "cancelled"
  | "unknown";

export interface DelegationOutcomeSummary {
  state: DelegationOutcomeState;
  summary?: string | undefined;
  reason?: string | undefined;
  resultContract?: string | undefined;
  supersededByDelegationId?: string | undefined;
  supersedesDelegationId?: string | undefined;
  supersededAt?: string | undefined;
}

export interface DelegationFanInDecision {
  at: string;
  eventType: string;
  decision: string;
  groupId?: string | undefined;
  delegationId?: string | undefined;
  childThreadId?: string | undefined;
  decidedBy?: string | undefined;
  reason?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ReplayDominantBlocker {
  delegationId: string;
  childThreadId: string;
  status: DelegationRecord["status"];
  reason?: string | undefined;
  groupId?: string | undefined;
}

export interface DelegationReport {
  delegation: DelegationRecord;
  childThread?: ThreadRecord | undefined;
  milestones: ReplayTransitionGroup[];
  blockedBy?: ActiveWaitReport | undefined;
  supervisionGroupId?: string | undefined;
  supervisionMetadata?: Record<string, unknown> | undefined;
  outcome: DelegationOutcomeSummary;
  fanInDecisions: DelegationFanInDecision[];
}

export interface ReplaySupervisionGroupReport {
  groupId: string;
  metadata?: Record<string, unknown> | undefined;
  childOutcomes: DelegationOutcomeSummaryWithIdentity[];
  fanInDecisions: DelegationFanInDecision[];
  dominantBlocker?: ReplayDominantBlocker | undefined;
}

export interface DelegationOutcomeSummaryWithIdentity extends DelegationOutcomeSummary {
  delegationId: string;
  parentThreadId: string;
  childThreadId: string;
  status: DelegationRecord["status"];
}

export interface ReplaySupervisionReport {
  groups: ReplaySupervisionGroupReport[];
  fanInDecisions: DelegationFanInDecision[];
  dominantBlocker?: ReplayDominantBlocker | undefined;
  supersededLineage: Array<{
    delegationId: string;
    supersededByDelegationId: string;
    supersededAt?: string | undefined;
  }>;
}

export interface CompactionReport {
  summaries: ContextSummaryArtifactRecord[];
  events: ThreadCompactionEventRecord[];
  latestSummary?: ContextSummaryArtifactRecord | undefined;
  latestEvent?: ThreadCompactionEventRecord | undefined;
  authoritativeSummary?: ContextSummaryArtifactRecord | undefined;
}

export interface ReplayAssemblyEntry {
  record: ThreadAssemblyRecord;
  bundle?: AssemblyBundleRecord | undefined;
}

export interface ReplayAssemblyReport {
  mode: "explicit" | "implicit_legacy";
  active?: ReplayAssemblyEntry | undefined;
  history: ReplayAssemblyEntry[];
  proposals: AssemblyChangeProposalRecord[];
  decisions: AssemblyChangeDecisionRecord[];
  specialists: SpecialistDefinitionRecord[];
  contextPolicies: ContextPolicyDefinitionRecord[];
}

export interface ReplayCompatibilitySummary {
  provider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
  model?: string | undefined;
  promptVariant?: string | undefined;
  profile?: string | undefined;
  status?: "compatible" | "downgraded" | "incompatible" | undefined;
  decisionSource?: "profile" | "policy" | "operator" | "model" | "runtime" | undefined;
  downgradeReason?: string | undefined;
  capabilityLossReason?: string | undefined;
}

export interface ReplayAdaptationSummary {
  status: "auto_applied" | "pending_checkpoint" | "accepted" | "deferred" | "not_recorded";
  recommendedAction?: string | undefined;
  reason: string;
  sourceSignals?: Record<string, unknown> | undefined;
  checkpointId?: string | undefined;
  eventId?: string | undefined;
  summaryArtifactId?: string | undefined;
  childThreadId?: string | undefined;
  delegationId?: string | undefined;
  at: string;
}

export interface ReplayEvidenceRecoverySummary {
  family?: EvidenceRecoveryFamily | undefined;
  attempts: number;
  lowSignalAttempts: number;
  consecutiveLowSignal: number;
  broadenedSearchUsed: boolean;
  targetedFetchUsed: boolean;
  duplicateEvents?: number | undefined;
  latestDuplicateKind?: string | undefined;
  latestDuplicateCount?: number | undefined;
  latestDuplicateMatchedPriorStep?: number | undefined;
  latestQuality?: string | undefined;
  latestIssues?: string[] | undefined;
  terminalOutcome?: string | undefined;
}

export interface ReplayResult {
  query: ReplayQuery;
  summary: ReplaySummary;
  events: RunEvent[];
  transitions: ReplayTransitionRecord[];
  timeline: ReplayTimelineEntry[];
  groups: ReplayTransitionGroup[];
  lineage: ThreadLineageReport;
  waits: {
    active?: ActiveWaitReport | undefined;
    history: ActiveWaitReport[];
  };
  approvals: ApprovalChainReport[];
  delegations: DelegationReport[];
  supervision: ReplaySupervisionReport;
  compaction: CompactionReport;
  assembly: ReplayAssemblyReport;
  turn?: ReplayTurnReport | undefined;
  modelProvenance: ReplayModelProvenanceSummary;
  compatibility?: ReplayCompatibilitySummary | undefined;
  adaptation?: ReplayAdaptationSummary | undefined;
  evidenceRecovery?: ReplayEvidenceRecoverySummary | undefined;
  runtimePlan?: ReplayRuntimePlanSummary | undefined;
}

export interface ReplayRuntimePlanSummary {
  phase?: string | undefined;
  currentChunk?: string | undefined;
  status?: string | undefined;
  expectedNextCommand?: string | undefined;
  waitReason?: string | undefined;
  blocker?: string | undefined;
  commandBatchId?: string | undefined;
  executionMode?: string | undefined;
  commandNames?: string[] | undefined;
  lastCheckpoint?: {
    substate?: string | undefined;
    currentStepAgent?: string | undefined;
    nextStepAgent?: string | undefined;
    updatedAtStepIndex?: number | undefined;
  } | undefined;
  latestNarration?: {
    stepAgent?: string | undefined;
    currentChunk?: string | undefined;
    status?: string | undefined;
    expectedNextCommand?: string | undefined;
    waitReason?: string | undefined;
    blocker?: string | undefined;
    latest?: string | undefined;
    outcome?: string | undefined;
    next?: string | undefined;
    waitingOn?: string | undefined;
  } | undefined;
}

export interface ReplayDoctorReport {
  focus: {
    runId?: string | undefined;
    sessionId?: string | undefined;
    threadId?: string | undefined;
    delegationId?: string | undefined;
  };
  compatibility?: ReplayCompatibilitySummary | undefined;
  latestAdaptation?: ReplayAdaptationSummary | undefined;
  latestEvidenceRecovery?: ReplayEvidenceRecoverySummary | undefined;
  status: TransitionStatus | "RUNNING" | "UNKNOWN" | "STALLED";
  finalStep?: string | undefined;
  terminalReasonCode?: string | undefined;
  wait?: ActiveWaitReport | undefined;
  blockingResource?: {
    kind: ReplayBlockingKind;
    actionable: boolean;
    threadId?: string | undefined;
    runId?: string | undefined;
    delegationId?: string | undefined;
    requestId?: string | undefined;
    grantId?: string | undefined;
    eventType?: string | undefined;
    detail?: string | undefined;
  } | undefined;
  lastMeaningfulProgress?: ReplayTransitionGroup | undefined;
  childBlocker?: {
    delegationId: string;
    childThreadId: string;
    status: DelegationRecord["status"];
    reason?: string | undefined;
    groupId?: string | undefined;
  } | undefined;
  dominantChildBlocker?: ReplayDominantBlocker | undefined;
  scheduler: {
    claims: number;
    spawns: number;
    syncs: number;
    waits: number;
    lastAction?: string | undefined;
  };
  loops: Array<{
    at: string;
    guardType?: string | undefined;
    message?: string | undefined;
  }>;
  dominantFailure?: {
    classification:
      | "approval_wait"
      | "user_input_wait"
      | "delegation_blocked"
      | "delegation_failed"
      | "scheduler_stall"
      | "compaction_checkpoint"
      | "loop_guard"
      | "capability_loss_pruned_tool"
      | "terminal_failure"
      | "unknown";
    message: string;
  } | undefined;
  activeAssembly?: {
    mode: ReplayAssemblyReport["mode"];
    bundleId?: string | undefined;
    label?: string | undefined;
    source?: string | undefined;
    authority?: ThreadAssemblyRecord["authority"] | undefined;
    cause?: ThreadAssemblyRecord["cause"] | undefined;
    toolAllowlist: string[];
    specialistIds: string[];
    contextPolicyId?: string | undefined;
    approvalPolicyId?: string | undefined;
    lastChangedAt?: string | undefined;
    latestProposalStatus?: AssemblyChangeProposalRecord["status"] | undefined;
    latestDecisionResult?: AssemblyChangeDecisionRecord["result"] | undefined;
    provider?: {
      id: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio";
      model: string;
      promptVariant?: string | undefined;
      compatibilityProfile?: string | undefined;
    } | undefined;
    compatibility?: {
      status?: "compatible" | "downgraded" | "incompatible" | undefined;
      decisionSource?: "profile" | "policy" | "operator" | "model" | "runtime" | undefined;
      downgradeReason?: string | undefined;
      capabilityLossReason?: string | undefined;
    } | undefined;
  } | undefined;
  latestReasoning?: {
    message: string;
    at: string;
    runId?: string | undefined;
  } | undefined;
  turn?: ReplayTurnReport | undefined;
  modelProvenance?: ReplayModelProvenanceSummary | undefined;
  runtimePlan?: ReplayRuntimePlanSummary | undefined;
  actionable: boolean;
}

export interface ReplayTurnReport {
  active?: ConversationTurnRecord | undefined;
  segments: ConversationTurnSegmentRecord[];
}

export interface ReplayModelProvenanceSummary {
  retention: "hash_only";
  callCount: number;
  actionCallCount: number;
  maintenanceCallCount: number;
  calls: Array<{
    callId: string;
    runId: string;
    turnId?: string | undefined;
    stepAgent?: string | undefined;
    phase?: string | undefined;
    model?: string | undefined;
    provider?: string | undefined;
	    providerPayloadHash: string;
	    componentHash: string;
	    sourceBucketHashes?: Record<string, string> | undefined;
	    metadata?: {
	      modelBudgetClass?: "action" | "maintenance" | undefined;
	      droppedSections?: unknown[] | undefined;
	      summaryArtifactId?: string | undefined;
	      freshness?: Record<string, unknown> | undefined;
	      promptDump?: {
	        jsonPath?: string | undefined;
	      } | undefined;
	    } | undefined;
    status: ModelCallProvenanceRecord["status"];
    latencyMs?: number | undefined;
  }>;
}

interface ReplayContext {
  focusThread?: ThreadRecord | undefined;
  focusDelegation?: DelegationRecord | undefined;
  parentDelegation?: DelegationRecord | undefined;
}

export class RunReplayService {
  private readonly store: ReplayStore;

  constructor(store: ReplayStore) {
    this.store = store;
  }

  async replay(query: ReplayQuery): Promise<ReplayResult> {
    const requestedLimit = query.limit;
    const fetchLimit =
      typeof requestedLimit === "number" && Number.isFinite(requestedLimit)
        ? requestedLimit + 1
        : undefined;
    const rawEvents = await this.store.getReplayStream({
      ...(query.runId !== undefined ? { runId: query.runId } : {}),
      ...(query.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
      ...(query.threadId !== undefined ? { threadId: query.threadId } : {}),
      ...(query.delegationId !== undefined ? { delegationId: query.delegationId } : {}),
      ...(query.fromTimestamp !== undefined ? { fromTimestamp: query.fromTimestamp } : {}),
      ...(query.toTimestamp !== undefined ? { toTimestamp: query.toTimestamp } : {}),
      ...(fetchLimit !== undefined ? { limit: fetchLimit } : {}),
    });
    const truncated =
      typeof requestedLimit === "number" &&
      Number.isFinite(requestedLimit) &&
      rawEvents.length > requestedLimit;
    const events = truncated ? rawEvents.slice(0, requestedLimit) : rawEvents;

    const transitions = events.map((event) => this.toTransitionRecord(event));
    const timeline = transitions.map((transition, index) => ({
      seq: index + 1,
      at: transition.at,
      label: this.timelineLabel(transition),
      ...(this.timelineDetail(transition) !== undefined
        ? { detail: this.timelineDetail(transition) }
        : {}),
      source: transition.domain,
      ...(transition.step !== undefined ? { step: transition.step } : {}),
      ...(typeof events[index]?.stepIndex === "number" ? { stepIndex: events[index]?.stepIndex } : {}),
    }));
    const groups = transitions.map((transition, index) =>
      this.toTransitionGroup(events[index] ?? events[0], transition, timeline[index]),
    );

    const summary = this.buildSummary(query, events, requestedLimit, truncated);
    const context = await this.resolveContext(query, events);
    const lineage = await this.buildLineageReport(events, context);
    const approvals = await this.buildApprovalChains(lineage, query);
    const compaction = await this.buildCompactionReport(lineage.focusThread);
    const checkpoints =
      lineage.focusThread === undefined
        ? []
        : await this.store.listContextCheckpoints({
            threadId: lineage.focusThread.threadId,
          });
    const assembly = await this.buildAssemblyReport(lineage.focusThread);
    const turn = await this.buildTurnReport(events, lineage.focusThread);
    const modelProvenance = await this.buildModelProvenanceReport({
      query,
      events,
      turnId: turn?.active?.turnId,
    });
    const evidenceRecovery = await this.buildEvidenceRecoverySummary(
      lineage.focusThread,
      checkpoints,
      compaction,
    );
    const adaptation = this.buildAdaptationSummary(checkpoints, compaction, evidenceRecovery);
    const runtimePlan = await this.buildRuntimePlanSummary(query, events);
    const waits = this.buildWaitReports({
      events,
      groups,
      approvals,
      lineage,
      compaction,
    });
    const delegations = await this.buildDelegationReports(lineage, groups, waits.history, events);
    const supervision = this.buildSupervisionReport(delegations, events);

    return {
      query,
      summary,
      events,
      transitions,
      timeline,
      groups,
      lineage,
      waits: {
        active: this.selectActiveWait(waits.history, delegations, compaction),
        history: waits.history,
      },
      approvals,
      delegations,
      supervision,
      compaction,
      assembly,
      ...(turn !== undefined ? { turn } : {}),
      modelProvenance,
      ...(this.buildCompatibilitySummary(assembly.active) !== undefined
        ? { compatibility: this.buildCompatibilitySummary(assembly.active) }
        : {}),
      ...(adaptation !== undefined ? { adaptation } : {}),
      ...(evidenceRecovery !== undefined ? { evidenceRecovery } : {}),
      ...(runtimePlan !== undefined ? { runtimePlan } : {}),
    };
  }

  doctor(replay: ReplayResult): ReplayDoctorReport {
    const terminal = [...replay.events].reverse().find((event) => event.type === "terminal.normalized");
    const terminalMetadata = asRecord(terminal?.metadata);
    const schedulerEvents = replay.events.filter((event) => event.type.startsWith("region.scheduler."));
    const loopEvents = replay.events.filter((event) => event.type === "loop.guard_triggered");
    const lastScheduler = schedulerEvents[schedulerEvents.length - 1];
    const wait = replay.waits.active;
    const lastMeaningfulProgress = [...replay.groups]
      .reverse()
      .find((group) => group.eventTypes.includes("progress.heartbeat") === false);
    const childBlocker = this.selectDominantChildBlocker(replay.delegations, replay.supervision);

    const status = this.resolveDoctorStatus(replay, wait, childBlocker);
    const dominantFailure = this.classifyDoctorState(replay, wait, childBlocker);
    const activeAssembly = this.buildDoctorAssemblySummary(replay.assembly);
    const latestReasoning = this.buildDoctorLatestReasoning(replay.events);

    return {
      focus: {
        ...(replay.summary.runId !== undefined ? { runId: replay.summary.runId } : {}),
        ...(replay.summary.sessionId !== undefined ? { sessionId: replay.summary.sessionId } : {}),
        ...(replay.lineage.focusThread?.threadId !== undefined
          ? { threadId: replay.lineage.focusThread.threadId }
          : {}),
        ...(replay.lineage.focusDelegation?.delegationId !== undefined
          ? { delegationId: replay.lineage.focusDelegation.delegationId }
          : {}),
      },
      status,
      ...(typeof terminalMetadata?.finalStep === "string"
        ? { finalStep: terminalMetadata.finalStep }
        : typeof terminalMetadata?.finalStepAgent === "string"
          ? { finalStep: terminalMetadata.finalStepAgent }
          : {}),
      ...(typeof terminalMetadata?.reasonCode === "string"
        ? { terminalReasonCode: terminalMetadata.reasonCode }
        : {}),
      ...(wait !== undefined ? { wait } : {}),
      ...(wait !== undefined
        ? {
            blockingResource: {
              kind: wait.kind,
              actionable: wait.actionable,
              ...(wait.threadId !== undefined ? { threadId: wait.threadId } : {}),
              ...(wait.runId !== undefined ? { runId: wait.runId } : {}),
              ...(wait.delegationId !== undefined ? { delegationId: wait.delegationId } : {}),
              ...(wait.requestId !== undefined ? { requestId: wait.requestId } : {}),
              ...(wait.grantId !== undefined ? { grantId: wait.grantId } : {}),
              ...(wait.eventType !== undefined ? { eventType: wait.eventType } : {}),
              ...(wait.detail !== undefined ? { detail: wait.detail } : {}),
            },
          }
        : childBlocker !== undefined
          ? {
              blockingResource: {
                kind:
                  childBlocker.delegation.status === "WAITING" ? "delegation" : "unknown",
                actionable: false,
                threadId: childBlocker.childThread?.threadId,
                delegationId: childBlocker.delegation.delegationId,
                detail:
                  childBlocker.delegation.errorMessage ??
                  childBlocker.delegation.waitEventType ??
                  childBlocker.delegation.status,
              },
            }
          : {}),
      ...(lastMeaningfulProgress !== undefined ? { lastMeaningfulProgress } : {}),
      ...(childBlocker !== undefined
        ? {
            childBlocker: {
              delegationId: childBlocker.delegation.delegationId,
              childThreadId: childBlocker.delegation.childThreadId,
              status: childBlocker.delegation.status,
              ...(childBlocker.delegation.errorMessage !== undefined
                ? { reason: childBlocker.delegation.errorMessage }
                : childBlocker.delegation.waitEventType !== undefined
                  ? { reason: childBlocker.delegation.waitEventType }
                  : childBlocker.outcome.reason !== undefined
                    ? { reason: childBlocker.outcome.reason }
                  : {}),
              ...(childBlocker.supervisionGroupId !== undefined
                ? { groupId: childBlocker.supervisionGroupId }
                : {}),
            },
          }
        : {}),
      ...(replay.supervision.dominantBlocker !== undefined
        ? { dominantChildBlocker: replay.supervision.dominantBlocker }
        : {}),
      scheduler: {
        claims: replay.events.filter((event) => event.type === "region.scheduler.claimed").length,
        spawns: replay.events.filter((event) => event.type === "region.scheduler.spawned").length,
        syncs: replay.events.filter((event) => event.type === "region.scheduler.synced").length,
        waits: replay.events.filter((event) => event.type === "region.scheduler.waiting").length,
        ...(lastScheduler !== undefined ? { lastAction: lastScheduler.type } : {}),
      },
      loops: loopEvents.map((event) => {
        const metadata = asRecord(event.metadata);
        const details = asRecord(metadata?.details);
        return {
          at: event.timestamp,
          ...(typeof details?.guardType === "string" ? { guardType: details.guardType } : {}),
          ...(typeof metadata?.message === "string" ? { message: metadata.message } : {}),
        };
      }),
      ...(dominantFailure !== undefined ? { dominantFailure } : {}),
      ...(activeAssembly !== undefined ? { activeAssembly } : {}),
      ...(this.buildCompatibilitySummary(replay.assembly.active) !== undefined
        ? { compatibility: this.buildCompatibilitySummary(replay.assembly.active) }
        : {}),
      ...(replay.adaptation !== undefined ? { latestAdaptation: replay.adaptation } : {}),
      ...(replay.evidenceRecovery !== undefined ? { latestEvidenceRecovery: replay.evidenceRecovery } : {}),
      ...(latestReasoning !== undefined ? { latestReasoning } : {}),
      ...(replay.turn !== undefined ? { turn: replay.turn } : {}),
      ...(replay.modelProvenance.callCount > 0 ? { modelProvenance: replay.modelProvenance } : {}),
      ...(replay.runtimePlan !== undefined ? { runtimePlan: replay.runtimePlan } : {}),
      actionable: wait?.actionable === true,
    };
  }

  private async buildRuntimePlanSummary(
    query: ReplayQuery,
    events: RunEvent[],
  ): Promise<ReplayRuntimePlanSummary | undefined> {
    const runId = query.runId ?? [...events].reverse().map((event) => event.runId).find((value) => value !== undefined);
    if (runId === undefined) {
      return ;
    }
    const runState = await this.store.getRunState(runId);
    if (runState === null) {
      return ;
    }
    const state = asRecord(runState.state);
    const react = asRecord(state?.react);
    const workingPlan = asRecord(react?.workingPlan);
    const commandProcessor = asRecord(react?.commandProcessor);
    if (workingPlan === undefined && commandProcessor === undefined) {
      return ;
    }
    const lastCheckpoint = asRecord(commandProcessor?.lastCheckpoint);
    const checkpoint =
      lastCheckpoint === undefined
        ? undefined
        : {
            ...(readString(lastCheckpoint.substate) !== undefined ? { substate: readString(lastCheckpoint.substate) } : {}),
            ...(readString(lastCheckpoint.currentStepAgent) !== undefined
              ? { currentStepAgent: readString(lastCheckpoint.currentStepAgent) }
              : {}),
            ...(readString(lastCheckpoint.nextStepAgent) !== undefined
              ? { nextStepAgent: readString(lastCheckpoint.nextStepAgent) }
              : {}),
            ...(typeof lastCheckpoint.updatedAtStepIndex === "number"
              ? { updatedAtStepIndex: lastCheckpoint.updatedAtStepIndex }
              : {}),
          };
    return {
      ...(readString(react?.phase) !== undefined ? { phase: readString(react?.phase) } : {}),
      ...(readString(workingPlan?.currentChunk) !== undefined ? { currentChunk: readString(workingPlan?.currentChunk) } : {}),
      ...(readString(workingPlan?.status) !== undefined ? { status: readString(workingPlan?.status) } : {}),
      ...(readString(workingPlan?.expectedNextCommand) !== undefined
        ? { expectedNextCommand: readString(workingPlan?.expectedNextCommand) }
        : {}),
      ...(readString(workingPlan?.waitReason) !== undefined ? { waitReason: readString(workingPlan?.waitReason) } : {}),
      ...(readString(workingPlan?.blocker) !== undefined ? { blocker: readString(workingPlan?.blocker) } : {}),
      ...(readString(commandProcessor?.batchId) !== undefined ? { commandBatchId: readString(commandProcessor?.batchId) } : {}),
      ...(readString(commandProcessor?.executionMode) !== undefined
        ? { executionMode: readString(commandProcessor?.executionMode) }
        : {}),
      ...(readStringArray(commandProcessor?.commandNames).length > 0
        ? { commandNames: readStringArray(commandProcessor?.commandNames) }
        : readStringArray(workingPlan?.commandNames).length > 0
          ? { commandNames: readStringArray(workingPlan?.commandNames) }
          : {}),
      ...(checkpoint !== undefined && Object.keys(checkpoint).length > 0 ? { lastCheckpoint: checkpoint } : {}),
    };
  }

  private buildSummary(
    query: ReplayQuery,
    events: RunEvent[],
    requestedLimit: number | undefined,
    truncated: boolean,
  ): ReplaySummary {
    const stepIndices = new Set<number>();
    for (const event of events) {
      if (typeof event.stepIndex === "number") {
        stepIndices.add(event.stepIndex);
      }
    }

    const terminal = [...events].reverse().find((event) => event.type === "terminal.normalized");
    const firstEvent = events[0];
    const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
    const regionsStarted = events.filter((event) => event.type === "region.started").length;
    const regionsCompleted = events.filter((event) => event.type === "region.completed").length;
    const syncNodesHit = events.filter((event) => event.type === "region.synced").length;
    const mergeConflicts = events.filter((event) => event.type === "region.merge_conflict").length;
    const progressStages = events.filter((event) => event.type === "progress.stage").length;
    const progressToolCalls = events.filter((event) => event.type === "progress.tool").length;
    const waitingMilestones = events.filter((event) => event.type === "progress.waiting").length;
    const heartbeatLiveOnlyCount = events.filter((event) => event.type === "progress.heartbeat").length;
    const schedulerActions = events.filter((event) => event.type.startsWith("region.scheduler.")).length;
    const waitsEntered = events.filter((event) => event.type === "wait.entered").length;
    const waitsResumed = events.filter((event) => event.type === "wait.resumed").length;
    const loopGuards = events.filter((event) => event.type === "loop.guard_triggered").length;
    const terminalMetadata = asRecord(terminal?.metadata);

    return {
      ...(query.runId !== undefined ? { runId: query.runId } : {}),
      ...(query.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
      ...(query.threadId !== undefined ? { threadId: query.threadId } : {}),
      ...(query.delegationId !== undefined ? { delegationId: query.delegationId } : {}),
      eventCount: events.length,
      ...(firstEvent?.timestamp !== undefined ? { firstEventAt: firstEvent.timestamp } : {}),
      ...(lastEvent?.timestamp !== undefined ? { lastEventAt: lastEvent.timestamp } : {}),
      ...(typeof terminalMetadata?.status === "string"
        ? { terminalStatus: terminalMetadata.status as TransitionStatus }
        : {}),
      stepsObserved: stepIndices.size,
      regionsStarted,
      regionsCompleted,
      syncNodesHit,
      mergeConflicts,
      progressStages,
      progressToolCalls,
      waitingMilestones,
      heartbeatLiveOnlyCount,
      schedulerActions,
      waitsEntered,
      waitsResumed,
      loopGuards,
      truncated,
      ...(requestedLimit !== undefined ? { requestedLimit } : {}),
    };
  }

  private async resolveContext(query: ReplayQuery, events: RunEvent[]): Promise<ReplayContext> {
    const run =
      query.runId !== undefined
        ? await this.store.getRun(query.runId)
        : events.length === 1 && events[0] !== undefined
          ? await this.store.getRun(events[0].runId)
          : null;
    const focusDelegation =
      query.delegationId !== undefined ? await this.store.getDelegation(query.delegationId) : null;

    let focusThread: ThreadRecord | null = null;
    if (query.threadId !== undefined) {
      focusThread = await this.store.getThread(query.threadId);
    } else if (focusDelegation !== null) {
      focusThread = await this.store.getThread(focusDelegation.childThreadId);
    } else if (run !== null) {
      const sessionThreads = await this.store.listThreads({
        sessionId: run.sessionId,
      });
      focusThread =
        sessionThreads.find((thread) => thread.activeRunId === run.runId) ??
        (sessionThreads.length === 1 ? sessionThreads[0] ?? null : null);
    } else if (query.sessionId !== undefined) {
      const sessionThreads = await this.store.listThreads({
        sessionId: query.sessionId,
      });
      focusThread = sessionThreads.length === 1 ? sessionThreads[0] ?? null : null;
    } else {
      const eventSessionIds = [...new Set(events.map((event) => event.sessionId))];
      if (query.runId !== undefined && eventSessionIds.length === 1) {
        const sessionThreads = await this.store.listThreads({
          sessionId: eventSessionIds[0],
        });
        focusThread =
          sessionThreads.find((thread) => thread.activeRunId === query.runId) ??
          (sessionThreads.length === 1 ? sessionThreads[0] ?? null : null);
      }
      const eventThreadIds = [
        ...new Set(
          events
            .map((event) => asRecord(event.metadata)?.threadId)
            .filter((value): value is string => typeof value === "string"),
        ),
      ];
      if (focusThread === null && eventThreadIds.length === 1) {
        focusThread = await this.store.getThread(eventThreadIds[0] ?? "");
      }
    }

    const parentDelegation =
      focusThread !== null ? await this.store.getDelegationByChildThreadId(focusThread.threadId) : null;

    return {
      ...(focusThread !== null ? { focusThread } : {}),
      ...(focusDelegation !== null ? { focusDelegation } : {}),
      ...(parentDelegation !== null ? { parentDelegation } : {}),
    };
  }

  private async buildLineageReport(
    events: RunEvent[],
    context: ReplayContext,
  ): Promise<ThreadLineageReport> {
    const focusThread = context.focusThread;
    const canonicalThread =
      focusThread !== undefined
        ? await this.resolveCanonicalFocusThread(focusThread)
        : undefined;
    const childThreads =
      canonicalThread !== undefined
        ? await this.store.listThreads({
            parentThreadId: canonicalThread.threadId,
          })
        : [];
    const parentThread =
      focusThread?.parentThreadId !== undefined
        ? await this.store.getThread(focusThread.parentThreadId)
        : null;
    const childDelegations =
      canonicalThread !== undefined
        ? await this.store.listDelegations({
            parentThreadId: canonicalThread.threadId,
          })
        : [];
    const runIds = new Set(events.map((event) => event.runId));
    if (focusThread?.activeRunId !== undefined) {
      runIds.add(focusThread.activeRunId);
    }
    if (canonicalThread?.activeRunId !== undefined) {
      runIds.add(canonicalThread.activeRunId);
    }
    if (context.focusDelegation?.parentRunId !== undefined) {
      runIds.add(context.focusDelegation.parentRunId);
    }
    if (context.focusDelegation?.childRunId !== undefined) {
      runIds.add(context.focusDelegation.childRunId);
    }
    for (const delegation of childDelegations) {
      if (delegation.parentRunId !== undefined) {
        runIds.add(delegation.parentRunId);
      }
      if (delegation.childRunId !== undefined) {
        runIds.add(delegation.childRunId);
      }
    }

    const delegationIds = new Set<string>();
    for (const event of events) {
      const metadata = asRecord(event.metadata);
      if (typeof metadata?.delegationId === "string") {
        delegationIds.add(metadata.delegationId);
      }
    }
    if (context.focusDelegation?.delegationId !== undefined) {
      delegationIds.add(context.focusDelegation.delegationId);
    }
    if (context.parentDelegation?.delegationId !== undefined) {
      delegationIds.add(context.parentDelegation.delegationId);
    }
    for (const delegation of childDelegations) {
      delegationIds.add(delegation.delegationId);
    }

    return {
      ...(focusThread !== undefined ? { focusThread } : {}),
      ...(parentThread !== null ? { parentThread } : {}),
      childThreads,
      ...(context.focusDelegation !== undefined ? { focusDelegation: context.focusDelegation } : {}),
      ...(context.parentDelegation !== undefined ? { parentDelegation: context.parentDelegation } : {}),
      childDelegations,
      relatedRunIds: [...runIds],
      relatedDelegationIds: [...delegationIds],
    };
  }

  private async resolveCanonicalFocusThread(
    focusThread: ThreadRecord,
  ): Promise<ThreadRecord> {
    if (focusThread.threadId !== focusThread.sessionId) {
      return focusThread;
    }
    const sessionThreads = await this.store.listThreads({
      sessionId: focusThread.sessionId,
    });
    const canonical = sessionThreads.find((thread) => {
      if (thread.threadId === focusThread.threadId) {
        return false;
      }
      if (focusThread.activeRunId !== undefined && thread.activeRunId === focusThread.activeRunId) {
        return true;
      }
      return thread.parentThreadId === undefined;
    });
    return canonical ?? focusThread;
  }

  private async buildApprovalChains(
    lineage: ThreadLineageReport,
    query: ReplayQuery,
  ): Promise<ApprovalChainReport[]> {
    if (lineage.focusThread === undefined) {
      return [];
    }

    const requests = await this.store.listInteractionRequests({
      threadId: lineage.focusThread.threadId,
    });
    const filteredRequests =
      query.delegationId === undefined
        ? requests
        : requests.filter((request) => request.delegationId === query.delegationId);
    const grants = await this.store.listApprovalGrants({
      threadId: lineage.focusThread.threadId,
    });

    return filteredRequests
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((request) => {
        const chainGrants = grants
          .filter((grant) => grant.requestId === request.requestId)
          .sort((left, right) => left.issuedAt.localeCompare(right.issuedAt));
        const latestGrant = chainGrants[chainGrants.length - 1];
        return {
          request,
          grants: chainGrants,
          ...(latestGrant !== undefined ? { latestGrant } : {}),
          status:
            request.status === "PENDING"
              ? "pending"
              : latestGrant !== undefined
                ? "granted"
                : "resolved_without_grant",
          actionable: request.status === "PENDING",
        };
      });
  }

  private async buildCompactionReport(
    focusThread: ThreadRecord | undefined,
  ): Promise<CompactionReport> {
    if (focusThread === undefined) {
      return {
        summaries: [],
        events: [],
      };
    }
    const summaries = await this.store.listContextSummaryArtifacts(focusThread.threadId);
    const events = await this.store.listThreadCompactionEvents(focusThread.threadId);
    const latestSummary = summaries[0];
    const latestEvent = events[0];
    const authoritativeSummary =
      latestEvent?.summaryArtifactId !== undefined
        ? summaries.find((summary) => summary.artifactId === latestEvent.summaryArtifactId)
        : latestSummary;

    return {
      summaries,
      events,
      ...(latestSummary !== undefined ? { latestSummary } : {}),
      ...(latestEvent !== undefined ? { latestEvent } : {}),
      ...(authoritativeSummary !== undefined ? { authoritativeSummary } : {}),
    };
  }

  private async buildEvidenceRecoverySummary(
    focusThread: ThreadRecord | undefined,
    checkpoints: ContextCheckpointRecord[],
    compaction: CompactionReport,
  ): Promise<ReplayEvidenceRecoverySummary | undefined> {
    if (focusThread === undefined) {
      return ;
    }
    const session = await this.store.getSession(focusThread.sessionId);
    const reactState = asRecord(session?.state)?.react;
    const postToolVerification = asRecord(asRecord(reactState)?.postToolVerification);
    const terminalReason = readString(asRecord(asRecord(reactState)?.terminal)?.reasonCode);
    const finalOutputData = asRecord(asRecord(asRecord(reactState)?.finalOutput)?.data);
    const researchStalled = finalOutputData?.researchStalled === true;
    const terminalOutcome = terminalReason ?? (researchStalled ? "research_stalled_partial" : undefined);
    const sessionSummary = extractEvidenceRecoverySummary(
      postToolVerification?.evidenceRecoverySummary,
      terminalOutcome,
    );
    if (sessionSummary !== undefined) {
      return sessionSummary;
    }

    const checkpointMatches = checkpoints
      .slice()
      .sort((left, right) => {
        const leftAt = left.resolvedAt ?? left.createdAt;
        const rightAt = right.resolvedAt ?? right.createdAt;
        return rightAt.localeCompare(leftAt);
      })
      .map((checkpoint) => asRecord(checkpoint.signals)?.evidenceRecovery)
      .map((value) => extractEvidenceRecoverySummary(value))
      .find((value) => value !== undefined);
    if (checkpointMatches !== undefined) {
      return checkpointMatches;
    }

    const compactionEvidence = [
      ...compaction.events.map((event) => asRecord(event.metadata)?.sourceSignals),
      ...compaction.events.map((event) => asRecord(event.metadata)),
      ...compaction.summaries.map((artifact) => asRecord(artifact.metadata)?.sourceSignals),
      ...compaction.summaries.map((artifact) => asRecord(artifact.metadata)),
    ]
      .map((record) => asRecord(record)?.evidenceRecovery)
      .map((value) => extractEvidenceRecoverySummary(value))
      .find((value) => value !== undefined);
    if (compactionEvidence !== undefined) {
      return compactionEvidence;
    }
    return ;
  }

  private buildAdaptationSummary(
    checkpoints: ContextCheckpointRecord[],
    compaction: CompactionReport,
    evidenceRecovery: ReplayEvidenceRecoverySummary | undefined,
  ): ReplayAdaptationSummary | undefined {
    return selectAdaptationSummary(checkpoints, compaction, evidenceRecovery);
  }

  private async buildAssemblyReport(
    focusThread: ThreadRecord | undefined,
  ): Promise<ReplayAssemblyReport> {
    if (focusThread === undefined) {
      return {
        mode: "implicit_legacy",
        history: [],
        proposals: [],
        decisions: [],
        specialists: [],
        contextPolicies: [],
      };
    }
    const historyRecords = await this.store.listThreadAssemblyRecords(focusThread.threadId);
    const history = await Promise.all(
      historyRecords.map(async (record) => {
        const bundle = await this.store.getAssemblyBundle(record.bundleId);
        return {
          record,
          ...(bundle !== null ? { bundle } : {}),
        };
      }),
    );
    const proposals = await this.store.listAssemblyChangeProposals({
      threadId: focusThread.threadId,
    });
    const decisions = await this.store.listAssemblyChangeDecisions({
      threadId: focusThread.threadId,
    });
    const specialists = await this.store.listSpecialistDefinitions();
    const contextPolicies = await this.store.listContextPolicyDefinitions();
    const active = selectLatestAssemblyEntry(history);

    return {
      mode: active !== undefined ? "explicit" : "implicit_legacy",
      ...(active !== undefined ? { active } : {}),
      history,
      proposals,
      decisions,
      specialists,
      contextPolicies,
    };
  }

  private async buildTurnReport(
    events: RunEvent[],
    focusThread: ThreadRecord | undefined,
  ): Promise<ReplayTurnReport | undefined> {
    const turnId = events
      .map((event) => readString(asRecord(event.metadata)?.turnId))
      .find((value) => value !== undefined);
    if (turnId !== undefined && this.store.getConversationTurn !== undefined) {
      const active = await this.store.getConversationTurn(turnId);
      const segments = this.store.listConversationTurnSegments !== undefined
        ? await this.store.listConversationTurnSegments(turnId)
        : [];
      return {
        ...(active !== null ? { active } : {}),
        segments,
      };
    }
    if (focusThread !== undefined && this.store.listConversationTurns !== undefined) {
      const turns = await this.store.listConversationTurns({
        threadId: focusThread.threadId,
        limit: 1,
      });
      const active = turns[0];
      if (active !== undefined) {
        const segments = this.store.listConversationTurnSegments !== undefined
          ? await this.store.listConversationTurnSegments(active.turnId)
          : [];
        return { active, segments };
      }
    }
    return ;
  }

  private async buildModelProvenanceReport(input: {
    query: ReplayQuery;
    events: RunEvent[];
    turnId?: string | undefined;
  }): Promise<ReplayModelProvenanceSummary> {
    const eventCalls = input.events
      .filter((event) => event.type === "model.provenance")
      .map((event) => asRecord(event.metadata))
      .filter((metadata): metadata is Record<string, unknown> => metadata !== undefined)
      .map((metadata) => ({
        callId: readString(metadata.callId) ?? "unknown",
        runId: input.query.runId ?? readString(metadata.runId) ?? "",
        ...(readString(metadata.turnId) !== undefined ? { turnId: readString(metadata.turnId) } : {}),
        ...(readModelBudgetClassFromMetadata(metadata) !== undefined
          ? { metadata: { modelBudgetClass: readModelBudgetClassFromMetadata(metadata) } }
          : {}),
        providerPayloadHash: readString(metadata.providerPayloadHash) ?? "",
        componentHash: readString(metadata.componentHash) ?? "",
        status: "REQUESTED" as const,
      }));
    const storedCalls =
      this.store.listModelCallProvenance !== undefined
        ? await this.store.listModelCallProvenance({
            ...(input.query.runId !== undefined ? { runId: input.query.runId } : {}),
            ...(input.query.sessionId !== undefined ? { sessionId: input.query.sessionId } : {}),
            ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
          })
        : [];
    const calls = storedCalls.length > 0
      ? storedCalls.map((call) => ({
          callId: call.callId,
          runId: call.runId,
          ...(call.turnId !== undefined ? { turnId: call.turnId } : {}),
          ...(call.stepAgent !== undefined ? { stepAgent: call.stepAgent } : {}),
          ...(call.phase !== undefined ? { phase: call.phase } : {}),
          ...(call.model !== undefined ? { model: call.model } : {}),
          ...(call.provider !== undefined ? { provider: call.provider } : {}),
          providerPayloadHash: call.providerPayloadHash,
          componentHash: call.componentHash,
          ...(call.sourceBucketHashes !== undefined ? { sourceBucketHashes: call.sourceBucketHashes } : {}),
          ...(sanitizeModelProvenanceMetadata(call.metadata) !== undefined
            ? { metadata: sanitizeModelProvenanceMetadata(call.metadata) }
            : {}),
          status: call.status,
          ...(call.latencyMs !== undefined ? { latencyMs: call.latencyMs } : {}),
        }))
      : eventCalls;
    return {
      retention: "hash_only",
      callCount: calls.length,
      actionCallCount: calls.filter((call) => readModelBudgetClassFromReplayCall(call) === "action").length,
      maintenanceCallCount: calls.filter((call) => readModelBudgetClassFromReplayCall(call) === "maintenance").length,
      calls,
    };
  }

  private buildWaitReports(input: {
    events: RunEvent[];
    groups: ReplayTransitionGroup[];
    approvals: ApprovalChainReport[];
    lineage: ThreadLineageReport;
    compaction: CompactionReport;
  }): {
    history: ActiveWaitReport[];
  } {
    const history: ActiveWaitReport[] = [];

    for (const chain of input.approvals) {
      const waitLineage = input.groups
        .filter(
          (group) =>
            group.requestId === chain.request.requestId ||
            (group.threadId === chain.request.threadId && group.label === "entered wait"),
        )
        .map((group) => this.renderLineageEntry(group));
      const hasActiveGrant =
        chain.latestGrant?.status === "ACTIVE" &&
        input.lineage.focusThread?.status === "WAITING";
      history.push({
        kind: chain.request.kind === "approval" ? "approval" : "user_input",
        status: chain.request.status === "PENDING" || hasActiveGrant ? "active" : "resolved",
        actionable: chain.request.status === "PENDING",
        eventType: chain.request.eventType,
        sourceEventType: "interaction.requested",
        threadId: chain.request.threadId,
        ...(chain.request.runId !== undefined ? { runId: chain.request.runId } : {}),
        ...(chain.request.delegationId !== undefined
          ? { delegationId: chain.request.delegationId }
          : {}),
        requestId: chain.request.requestId,
        ...(chain.latestGrant?.grantId !== undefined ? { grantId: chain.latestGrant.grantId } : {}),
        enteredAt: chain.request.createdAt,
        ...(chain.request.resolvedAt !== undefined ? { resolvedAt: chain.request.resolvedAt } : {}),
        ...(chain.request.prompt !== undefined ? { detail: chain.request.prompt } : {}),
        lineage: waitLineage,
        ...(chain.request.metadata !== undefined ? { metadata: chain.request.metadata } : {}),
      });
    }

    const threadWait = input.lineage.focusThread?.waitFor;
    if (
      threadWait !== undefined &&
      history.some((entry) => entry.status === "active" && entry.kind !== "delegation") === false
    ) {
      const waitLineage = input.groups
        .filter(
          (group) =>
            group.kind === "wait" &&
            group.threadId === input.lineage.focusThread?.threadId,
        )
        .map((group) => this.renderLineageEntry(group));
      history.push({
        kind: mapWaitKind(threadWait.kind, threadWait.eventType),
        status: input.lineage.focusThread?.status === "WAITING" ? "active" : "resolved",
        actionable: threadWait.kind === "approval" || threadWait.kind === "user",
        eventType: threadWait.eventType,
        sourceEventType: "run.waiting",
        ...(input.lineage.focusThread?.threadId !== undefined
          ? { threadId: input.lineage.focusThread.threadId }
          : {}),
        ...(input.lineage.focusThread?.activeRunId !== undefined
          ? { runId: input.lineage.focusThread.activeRunId }
          : {}),
        ...(input.lineage.parentDelegation?.delegationId !== undefined
          ? { delegationId: input.lineage.parentDelegation.delegationId }
          : {}),
        ...(input.lineage.focusThread?.currentRequestId !== undefined
          ? { requestId: input.lineage.focusThread.currentRequestId }
          : {}),
        lineage: waitLineage,
        ...(threadWait.metadata !== undefined ? { metadata: threadWait.metadata } : {}),
      });
    }

    for (const delegation of input.lineage.childDelegations) {
      if (delegation.status !== "WAITING") {
        continue;
      }
      const delegationLineage = input.groups
        .filter((group) => group.delegationId === delegation.delegationId)
        .map((group) => this.renderLineageEntry(group));
      history.push({
        kind: "delegation",
        status: "active",
        actionable: false,
        eventType: delegation.waitEventType,
        sourceEventType: "delegation.waiting",
        threadId: delegation.childThreadId,
        ...(delegation.childRunId !== undefined ? { runId: delegation.childRunId } : {}),
        delegationId: delegation.delegationId,
        enteredAt: delegation.updatedAt,
        detail: delegation.waitEventType ?? delegation.status,
        lineage: delegationLineage,
      });
    }

    if (input.compaction.latestEvent?.action === "operator_checkpoint") {
      history.push({
        kind: "compaction_checkpoint",
        status: "active",
        actionable: true,
        sourceEventType: "context.compaction_applied",
        ...(input.lineage.focusThread?.threadId !== undefined
          ? { threadId: input.lineage.focusThread.threadId }
          : {}),
        ...(input.compaction.latestEvent.runId !== undefined ? { runId: input.compaction.latestEvent.runId } : {}),
        enteredAt: input.compaction.latestEvent.createdAt,
        detail: input.compaction.latestEvent.reason,
        lineage: [
          `${input.compaction.latestEvent.createdAt} compaction checkpoint :: ${input.compaction.latestEvent.reason}`,
        ],
      });
    }

    const lastSchedulerWait = [...input.groups]
      .reverse()
      .find((group) => group.eventTypes.includes("region.scheduler.waiting"));
    if (
      lastSchedulerWait !== undefined &&
      history.some((entry) => entry.status === "active") === false
    ) {
      history.push({
        kind: "scheduler_wait",
        status: "active",
        actionable: false,
        sourceEventType: "region.scheduler.waiting",
        ...(lastSchedulerWait.threadId !== undefined ? { threadId: lastSchedulerWait.threadId } : {}),
        ...(lastSchedulerWait.runId !== undefined ? { runId: lastSchedulerWait.runId } : {}),
        ...(lastSchedulerWait.delegationId !== undefined
          ? { delegationId: lastSchedulerWait.delegationId }
          : {}),
        enteredAt: lastSchedulerWait.at,
        detail: lastSchedulerWait.detail,
        lineage: [this.renderLineageEntry(lastSchedulerWait)],
      });
    }

    return {
      history: dedupeWaitHistory(history),
    };
  }

  private selectActiveWait(
    waits: ActiveWaitReport[],
    delegations: DelegationReport[],
    compaction: CompactionReport,
  ): ActiveWaitReport | undefined {
    const active = waits.filter((entry) => entry.status === "active");
    const orderedKinds: ReplayBlockingKind[] = [
      "approval",
      "user_input",
      "compaction_checkpoint",
      "delegation",
      "scheduler_wait",
      "unknown",
    ];
    for (const kind of orderedKinds) {
      const match = active.find((entry) => entry.kind === kind);
      if (match !== undefined) {
        return match;
      }
    }
    const delegationWait = delegations.find((entry) => entry.delegation.status === "WAITING");
    if (delegationWait !== undefined) {
      return {
        kind: "delegation",
        status: "active",
        actionable: false,
        eventType: delegationWait.delegation.waitEventType,
        threadId: delegationWait.delegation.childThreadId,
        ...(delegationWait.delegation.childRunId !== undefined
          ? { runId: delegationWait.delegation.childRunId }
          : {}),
        delegationId: delegationWait.delegation.delegationId,
        enteredAt: delegationWait.delegation.updatedAt,
        detail: delegationWait.delegation.waitEventType,
        lineage: delegationWait.milestones.map((group) => this.renderLineageEntry(group)),
      };
    }
    if (compaction.latestEvent?.action === "operator_checkpoint") {
      return {
        kind: "compaction_checkpoint",
        status: "active",
        actionable: true,
        ...(compaction.latestEvent.runId !== undefined ? { runId: compaction.latestEvent.runId } : {}),
        enteredAt: compaction.latestEvent.createdAt,
        detail: compaction.latestEvent.reason,
        lineage: [
          `${compaction.latestEvent.createdAt} compaction checkpoint :: ${compaction.latestEvent.reason}`,
        ],
      };
    }
    return ;
  }

  private async buildDelegationReports(
    lineage: ThreadLineageReport,
    groups: ReplayTransitionGroup[],
    waits: ActiveWaitReport[],
    events: RunEvent[],
  ): Promise<DelegationReport[]> {
    const records = dedupeDelegations([
      ...(lineage.focusDelegation !== undefined ? [lineage.focusDelegation] : []),
      ...(lineage.parentDelegation !== undefined ? [lineage.parentDelegation] : []),
      ...lineage.childDelegations,
    ]);

    return Promise.all(
      records.map(async (delegation) => {
        const childThread = await this.store.getThread(delegation.childThreadId);
        const supervision = readDelegationSupervision(delegation);
        const outcome = deriveDelegationOutcomeSummary(delegation, supervision.metadata);
        const milestones = groups.filter(
          (group) =>
            group.delegationId === delegation.delegationId ||
            group.threadId === delegation.childThreadId,
        );
        const blockedBy = waits.find(
          (wait) =>
            wait.status === "active" &&
            (wait.delegationId === delegation.delegationId || wait.threadId === delegation.childThreadId),
        );
        return {
          delegation,
          ...(childThread !== null ? { childThread } : {}),
          milestones,
          ...(blockedBy !== undefined ? { blockedBy } : {}),
          ...(supervision.groupId !== undefined ? { supervisionGroupId: supervision.groupId } : {}),
          ...(supervision.metadata !== undefined
            ? { supervisionMetadata: supervision.metadata }
            : {}),
          outcome,
          fanInDecisions: collectDelegationFanInDecisions({
            delegation,
            events,
            supervisionGroupId: supervision.groupId,
          }),
        };
      }),
    );
  }

  private buildSupervisionReport(
    delegations: DelegationReport[],
    events: RunEvent[],
  ): ReplaySupervisionReport {
    const groupsById = new Map<string, ReplaySupervisionGroupReport>();
    const aggregateFanIn: DelegationFanInDecision[] = [];
    const supersededLineage: ReplaySupervisionReport["supersededLineage"] = [];

    for (const delegation of delegations) {
      if (
        delegation.outcome.supersededByDelegationId !== undefined
      ) {
        supersededLineage.push({
          delegationId: delegation.delegation.delegationId,
          supersededByDelegationId: delegation.outcome.supersededByDelegationId,
          ...(delegation.outcome.supersededAt !== undefined
            ? { supersededAt: delegation.outcome.supersededAt }
            : {}),
        });
      }
      aggregateFanIn.push(...delegation.fanInDecisions);
      if (delegation.supervisionGroupId === undefined) {
        continue;
      }
      const existing = groupsById.get(delegation.supervisionGroupId);
      const nextOutcome: DelegationOutcomeSummaryWithIdentity = {
        delegationId: delegation.delegation.delegationId,
        parentThreadId: delegation.delegation.parentThreadId,
        childThreadId: delegation.delegation.childThreadId,
        status: delegation.delegation.status,
        ...delegation.outcome,
      };
      if (existing === undefined) {
        groupsById.set(delegation.supervisionGroupId, {
          groupId: delegation.supervisionGroupId,
          ...(delegation.supervisionMetadata !== undefined
            ? { metadata: delegation.supervisionMetadata }
            : {}),
          childOutcomes: [nextOutcome],
          fanInDecisions: [...delegation.fanInDecisions],
          ...(selectDominantBlocker([delegation]) !== undefined
            ? { dominantBlocker: selectDominantBlocker([delegation]) }
            : {}),
        });
        continue;
      }
      existing.childOutcomes.push(nextOutcome);
      existing.fanInDecisions.push(...delegation.fanInDecisions);
      if (existing.metadata === undefined && delegation.supervisionMetadata !== undefined) {
        existing.metadata = delegation.supervisionMetadata;
      }
      const groupDelegations = delegations.filter(
        (entry) => entry.supervisionGroupId === existing.groupId,
      );
      const dominant = selectDominantBlocker(groupDelegations);
      if (dominant !== undefined) {
        existing.dominantBlocker = dominant;
      }
    }

    for (const report of groupsById.values()) {
      const groupFanIn = collectGroupFanInDecisions(events, report.groupId);
      report.fanInDecisions.push(...groupFanIn);
      aggregateFanIn.push(...groupFanIn);
      report.fanInDecisions = dedupeFanInDecisions(report.fanInDecisions);
      report.childOutcomes.sort((left, right) =>
        right.childThreadId.localeCompare(left.childThreadId),
      );
    }

    return {
      groups: [...groupsById.values()].sort((left, right) => left.groupId.localeCompare(right.groupId)),
      fanInDecisions: dedupeFanInDecisions(aggregateFanIn),
      ...(selectDominantBlocker(delegations) !== undefined
        ? { dominantBlocker: selectDominantBlocker(delegations) }
        : {}),
      supersededLineage: dedupeSupersededLineage(supersededLineage),
    };
  }

  private selectDominantChildBlocker(
    delegations: DelegationReport[],
    supervision: ReplaySupervisionReport,
  ): DelegationReport | undefined {
    const explicit = supervision.dominantBlocker;
    if (explicit !== undefined) {
      const match = delegations.find(
        (entry) => entry.delegation.delegationId === explicit.delegationId,
      );
      if (match !== undefined) {
        return match;
      }
    }
    const dominant = selectDominantBlocker(delegations);
    if (dominant === undefined) {
      return ;
    }
    return delegations.find(
      (entry) => entry.delegation.delegationId === dominant.delegationId,
    );
  }

  private resolveDoctorStatus(
    replay: ReplayResult,
    wait: ActiveWaitReport | undefined,
    childBlocker: DelegationReport | undefined,
  ): ReplayDoctorReport["status"] {
    if (replay.summary.terminalStatus !== undefined) {
      return replay.summary.terminalStatus;
    }
    if (wait?.status === "active") {
      return "WAITING";
    }
    if (childBlocker?.delegation.status === "WAITING") {
      return "WAITING";
    }
    const focusStatus = replay.lineage.focusThread?.status;
    if (focusStatus === "WAITING" || focusStatus === "COMPLETED" || focusStatus === "FAILED") {
      return focusStatus;
    }
    if (focusStatus === "RUNNING") {
      return "RUNNING";
    }
    const lastEventAt = replay.summary.lastEventAt;
    if (lastEventAt !== undefined) {
      const ageMs = Date.now() - Date.parse(lastEventAt);
      if (Number.isFinite(ageMs) && ageMs > 5 * 60 * 1000) {
        return "STALLED";
      }
    }
    return "UNKNOWN";
  }

  private classifyDoctorState(
    replay: ReplayResult,
    wait: ActiveWaitReport | undefined,
    childBlocker: DelegationReport | undefined,
  ): ReplayDoctorReport["dominantFailure"] | undefined {
    if (wait?.kind === "approval") {
      return {
        classification: "approval_wait",
        message: wait.detail ?? "Run is blocked on operator approval.",
      };
    }
    if (wait?.kind === "user_input") {
      return {
        classification: "user_input_wait",
        message: wait.detail ?? "Run is blocked on user input.",
      };
    }
    if (wait?.kind === "compaction_checkpoint") {
      return {
        classification: "compaction_checkpoint",
        message: wait.detail ?? "Thread paused at an operator compaction checkpoint.",
      };
    }
    if (childBlocker?.delegation.status === "WAITING") {
      return {
        classification: "delegation_blocked",
        message:
          childBlocker.delegation.waitEventType ??
          "Parent thread is blocked on a waiting child thread.",
      };
    }
    if (childBlocker?.delegation.status === "FAILED") {
      return {
        classification: "delegation_failed",
        message:
          childBlocker.delegation.errorMessage ??
          "Parent thread is blocked on a failed child thread.",
      };
    }
    const prunedToolFailure = this.findCapabilityLossPrunedToolFailure(replay);
    if (prunedToolFailure !== undefined) {
      return {
        classification: "capability_loss_pruned_tool",
        message:
          `Tool '${prunedToolFailure.toolName}' was removed by capability_loss recomposition` +
          `${prunedToolFailure.bundleId !== undefined ? ` (bundle=${prunedToolFailure.bundleId})` : ""}.`,
      };
    }
    const loop = replay.events.find((event) => event.type === "loop.guard_triggered");
    if (loop !== undefined) {
      const loopMetadata = asRecord(loop.metadata);
      return {
        classification: "loop_guard",
        message:
          (typeof loopMetadata?.message === "string" ? loopMetadata.message : undefined) ??
          "Loop guard triggered during execution.",
      };
    }
    if (replay.summary.terminalStatus === "FAILED") {
      const terminal = [...replay.events].reverse().find((event) => event.type === "terminal.normalized");
      const terminalMetadata = asRecord(terminal?.metadata);
      return {
        classification: "terminal_failure",
        message:
          (typeof terminalMetadata?.reasonCode === "string" ? terminalMetadata.reasonCode : undefined) ??
          "Run terminated with failure.",
      };
    }
    if (wait?.kind === "scheduler_wait") {
      return {
        classification: "scheduler_stall",
        message: wait.detail ?? "Run is stalled in the scheduler.",
      };
    }
    return ;
  }

  private findCapabilityLossPrunedToolFailure(
    replay: ReplayResult,
  ): { toolName: string; bundleId?: string | undefined } | undefined {
    if (replay.summary.terminalStatus !== "FAILED") {
      return ;
    }
    const failedRunEvent = [...replay.events].reverse().find((event) => event.type === "run.failed");
    const failedMetadata = asRecord(failedRunEvent?.metadata);
    if (failedMetadata?.code !== "TOOL_LOOKUP_FAILED") {
      return ;
    }
    const failedDetails = asRecord(failedMetadata.details);
    const toolName = typeof failedDetails?.toolName === "string" ? failedDetails.toolName : undefined;
    if (toolName === undefined) {
      return ;
    }

    for (const entry of replay.assembly.history) {
      if (entry.record.cause !== "capability_loss") {
        continue;
      }
      const unavailableTools = readStringArray(
        asRecord(entry.record.metadata)?.unavailableTools ??
          asRecord(entry.bundle?.metadata)?.unavailableTools,
      );
      if (unavailableTools.includes(toolName) === false) {
        continue;
      }
      return {
        toolName,
        bundleId: entry.record.bundleId,
      };
    }

    return ;
  }

  private buildDoctorAssemblySummary(
    report: ReplayAssemblyReport,
  ): ReplayDoctorReport["activeAssembly"] | undefined {
    const active = report.active;
    const latestProposal = report.proposals[0];
    const latestDecision = report.decisions[0];
    if (active === undefined && report.mode === "implicit_legacy") {
      return {
        mode: "implicit_legacy",
        toolAllowlist: [],
        specialistIds: [],
        ...(latestProposal?.status !== undefined ? { latestProposalStatus: latestProposal.status } : {}),
        ...(latestDecision?.result !== undefined ? { latestDecisionResult: latestDecision.result } : {}),
      };
    }
    if (active === undefined) {
      return ;
    }
    const compatibility = this.buildCompatibilitySummary(active);
    return {
      mode: report.mode,
      bundleId: active.record.bundleId,
      ...(active.bundle?.label !== undefined ? { label: active.bundle.label } : {}),
      ...(active.bundle?.source !== undefined ? { source: active.bundle.source } : {}),
      authority: active.record.authority,
      cause: active.record.cause,
      toolAllowlist: active.bundle?.toolAllowlist ?? [],
      specialistIds: active.bundle?.specialistIds ?? [],
      ...(active.bundle?.contextPolicyId !== undefined
        ? { contextPolicyId: active.bundle.contextPolicyId }
        : {}),
      ...(active.bundle?.approvalPolicyId !== undefined
        ? { approvalPolicyId: active.bundle.approvalPolicyId }
        : {}),
      lastChangedAt: active.record.createdAt,
      ...(latestProposal?.status !== undefined ? { latestProposalStatus: latestProposal.status } : {}),
      ...(latestDecision?.result !== undefined ? { latestDecisionResult: latestDecision.result } : {}),
      ...(compatibility?.provider !== undefined && compatibility.model !== undefined
        ? {
            provider: {
              id: compatibility.provider,
              model: compatibility.model,
              ...(compatibility.promptVariant !== undefined
                ? { promptVariant: compatibility.promptVariant }
                : {}),
              ...(compatibility.profile !== undefined
                ? { compatibilityProfile: compatibility.profile }
                : {}),
            },
          }
        : {}),
      ...(compatibility?.status !== undefined ||
      compatibility?.decisionSource !== undefined ||
      compatibility?.downgradeReason !== undefined ||
      compatibility?.capabilityLossReason !== undefined
        ? {
            compatibility: {
              ...(compatibility?.status !== undefined ? { status: compatibility.status } : {}),
              ...(compatibility?.decisionSource !== undefined
                ? { decisionSource: compatibility.decisionSource }
                : {}),
              ...(compatibility?.downgradeReason !== undefined
                ? { downgradeReason: compatibility.downgradeReason }
                : {}),
              ...(compatibility?.capabilityLossReason !== undefined
                ? { capabilityLossReason: compatibility.capabilityLossReason }
                : {}),
            },
          }
        : {}),
    };
  }

  private buildCompatibilitySummary(
    active: ReplayAssemblyEntry | undefined,
  ): ReplayCompatibilitySummary | undefined {
    const metadata = asRecord(active?.bundle?.metadata);
    const compatibility = readAssemblyCompatibilityMetadata(metadata);
    if (
      compatibility.modelProvider === undefined &&
      compatibility.model === undefined &&
      compatibility.promptVariant === undefined &&
      compatibility.compatibilityProfile === undefined &&
      compatibility.compatibilityStatus === undefined &&
      compatibility.compatibilityDecisionSource === undefined &&
      compatibility.downgradeReason === undefined &&
      compatibility.capabilityLossReason === undefined
    ) {
      return ;
    }

    return {
      ...(compatibility.modelProvider !== undefined ? { provider: compatibility.modelProvider } : {}),
      ...(compatibility.model !== undefined ? { model: compatibility.model } : {}),
      ...(compatibility.promptVariant !== undefined ? { promptVariant: compatibility.promptVariant } : {}),
      ...(compatibility.compatibilityProfile !== undefined
        ? { profile: compatibility.compatibilityProfile }
        : {}),
      ...(compatibility.compatibilityStatus !== undefined ? { status: compatibility.compatibilityStatus } : {}),
      ...(compatibility.compatibilityDecisionSource !== undefined
        ? { decisionSource: compatibility.compatibilityDecisionSource }
        : {}),
      ...(compatibility.downgradeReason !== undefined ? { downgradeReason: compatibility.downgradeReason } : {}),
      ...(compatibility.capabilityLossReason !== undefined
        ? { capabilityLossReason: compatibility.capabilityLossReason }
        : {}),
    };
  }

  private buildDoctorLatestReasoning(
    events: RunEvent[],
  ): ReplayDoctorReport["latestReasoning"] | undefined {
    const latest = [...events].reverse().find((event) => {
      if (event.type !== "reasoning.update") {
        return false;
      }
      return typeof asRecord(event.metadata)?.message === "string";
    });
    if (latest === undefined) {
      return ;
    }
    const metadata = asRecord(latest.metadata);
    if (typeof metadata?.message !== "string") {
      return ;
    }
    return {
      message: summarizeReasoningMessage(metadata.message),
      at: latest.timestamp,
      ...(latest.runId !== undefined ? { runId: latest.runId } : {}),
    };
  }

  private toTransitionGroup(
    event: RunEvent | undefined,
    transition: ReplayTransitionRecord,
    timeline: ReplayTimelineEntry | undefined,
  ): ReplayTransitionGroup {
    const metadata = asRecord(event?.metadata) ?? transition.metadata;
    return {
      seq: timeline?.seq ?? 0,
      at: transition.at,
      kind: groupKindFromTransition(transition.eventType, transition.domain),
      label: timeline?.label ?? this.timelineLabel(transition),
      ...(timeline?.detail !== undefined ? { detail: timeline.detail } : {}),
      source: transition.domain,
      runId: event?.runId ?? "",
      ...(typeof metadata?.threadId === "string" ? { threadId: metadata.threadId } : {}),
      ...(typeof metadata?.delegationId === "string" ? { delegationId: metadata.delegationId } : {}),
      ...(typeof metadata?.requestId === "string" ? { requestId: metadata.requestId } : {}),
      ...(typeof metadata?.grantId === "string" ? { grantId: metadata.grantId } : {}),
      ...(transition.step !== undefined ? { step: transition.step } : {}),
      ...(timeline?.stepIndex !== undefined ? { stepIndex: timeline.stepIndex } : {}),
      eventTypes: [transition.eventType],
    };
  }

  private renderLineageEntry(group: ReplayTransitionGroup): string {
    return `${group.at} ${group.label}${group.detail !== undefined ? ` :: ${group.detail}` : ""}`;
  }

  private toTransitionRecord(event: RunEvent): ReplayTransitionRecord {
    const metadata = asRecord(event.metadata);
    if (event.type.startsWith("region.scheduler.")) {
      return {
        at: event.timestamp,
        eventType: event.type,
        domain: "scheduler",
        phase:
          event.type === "region.scheduler.claimed"
            ? "claimed"
            : event.type === "region.scheduler.spawned"
              ? "spawned"
              : event.type === "region.scheduler.synced"
                ? "synced"
                : "waiting",
        ...(typeof metadata?.step === "string" ? { step: metadata.step } : {}),
        metadata,
      };
    }
    if (
      event.type === "wait.entered" ||
      event.type === "wait.resumed" ||
      event.type === "run.waiting" ||
      event.type === "run.resumed"
    ) {
      return {
        at: event.timestamp,
        eventType: event.type,
        domain: "wait",
        phase: event.type === "wait.resumed" || event.type === "run.resumed" ? "resumed" : "waiting",
        ...(typeof metadata?.finalStep === "string" ? { step: metadata.finalStep } : {}),
        metadata,
      };
    }
    if (
      event.type === "interaction.requested" ||
      event.type === "interaction.resolved" ||
      event.type === "approval.granted" ||
      event.type === "runtime.assembly.changed" ||
      event.type === "context.compaction_applied" ||
      event.type === "context.adaptation_applied" ||
      event.type.startsWith("delegation.")
    ) {
      return {
        at: event.timestamp,
        eventType: event.type,
        domain: event.type.startsWith("delegation.") ? "scheduler" : "agent",
        phase:
          event.type === "interaction.requested"
            ? "waiting"
            : event.type === "interaction.resolved" || event.type === "approval.granted"
              ? "resumed"
              : event.type === "runtime.assembly.changed"
              ? "synced"
              : event.type === "context.compaction_applied"
                ? "synced"
                : event.type === "context.adaptation_applied"
                ? "synced"
                : event.type === "delegation.requested" || event.type === "delegation.spawned"
                  ? "spawned"
                  : event.type === "delegation.waiting"
                    ? "waiting"
                    : event.type === "delegation.completed" || event.type === "delegation.failed"
                      ? "terminal"
                      : "other",
        ...(typeof metadata?.step === "string" ? { step: metadata.step } : {}),
        metadata,
      };
    }
    if (event.type === "loop.guard_triggered") {
      return {
        at: event.timestamp,
        eventType: event.type,
        domain: "tooling",
        phase: "loop_guard",
        metadata,
      };
    }
    if (
      event.type === "terminal.normalized" ||
      event.type === "run.completed" ||
      event.type === "run.failed"
    ) {
      return {
        at: event.timestamp,
        eventType: event.type,
        domain: "terminal",
        phase: "terminal",
        ...(typeof metadata?.finalStep === "string" ? { step: metadata.finalStep } : {}),
        ...(typeof metadata?.status === "string" ? { status: metadata.status } : {}),
        metadata,
      };
    }
    if (
      event.type === "step.selected" ||
      event.type === "step.started" ||
      event.type === "step.committed" ||
      event.type === "step.transitioned"
    ) {
      return {
        at: event.timestamp,
        eventType: event.type,
        domain: "engine",
        phase:
          event.type === "step.selected"
            ? "selected"
            : event.type === "step.started"
              ? "started"
              : event.type === "step.committed"
                ? "committed"
                : "transitioned",
        ...(typeof metadata?.step === "string" ? { step: metadata.step } : {}),
        ...(typeof metadata?.nextStepAgent === "string" ? { nextStep: metadata.nextStepAgent } : {}),
        ...(typeof metadata?.transitionStatus === "string"
          ? { status: metadata.transitionStatus }
          : typeof metadata?.status === "string"
            ? { status: metadata.status }
            : {}),
        metadata,
      };
    }
    return {
      at: event.timestamp,
      eventType: event.type,
      domain: event.type.startsWith("region.") ? "scheduler" : "agent",
      phase: "other",
      ...(typeof metadata?.step === "string" ? { step: metadata.step } : {}),
      metadata,
    };
  }

  private timelineLabel(transition: ReplayTransitionRecord): string {
    switch (transition.eventType) {
      case "step.selected":
        return "step selected";
      case "step.started":
        return "step started";
      case "step.committed":
        return "step committed";
      case "step.transitioned":
        return "step transitioned";
      case "wait.entered":
      case "run.waiting":
        return "entered wait";
      case "wait.resumed":
      case "run.resumed":
        return "resumed";
      case "turn.started":
        return "turn started";
      case "turn.segment":
        return "turn segment";
      case "turn.completed":
        return "turn completed";
      case "model.provenance":
        return "model provenance recorded";
      case "terminal.normalized":
        return "terminal normalized";
      case "interaction.requested":
        return "interaction requested";
      case "interaction.resolved":
        return "interaction resolved";
      case "approval.granted":
        return "approval granted";
      case "runtime.assembly.changed":
        return "assembly changed";
      case "context.compaction_applied":
        return "context compaction applied";
      case "runtime.state_persisted":
        return "runtime state persisted";
      case "runtime.resume_blocked":
        return "runtime resume blocked";
      case "context.adaptation_applied":
        return "adaptation applied";
      case "delegation.requested":
        return "delegation requested";
      case "delegation.spawned":
        return "delegation spawned";
      case "delegation.waiting":
        return "delegation waiting";
      case "delegation.completed":
        return "delegation completed";
      case "delegation.failed":
        return "delegation failed";
      case "reasoning.update":
        return "reasoning update";
      default:
        return transition.eventType;
    }
  }

  private timelineDetail(transition: ReplayTransitionRecord): string | undefined {
    if (transition.eventType === "step.transitioned") {
      const parts = [
        transition.step !== undefined ? `from=${transition.step}` : undefined,
        transition.nextStep !== undefined ? `to=${transition.nextStep}` : undefined,
        transition.status !== undefined ? `status=${transition.status}` : undefined,
      ].filter((value): value is string => value !== undefined);
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    if (transition.eventType === "run.waiting" || transition.eventType === "wait.entered") {
      const waitFor = asRecord(transition.metadata?.waitFor) ?? asRecord(transition.metadata?.wait);
      if (typeof waitFor?.eventType === "string") {
        return `eventType=${waitFor.eventType}`;
      }
    }
    if (transition.eventType.startsWith("region.scheduler.") && typeof transition.metadata?.region === "string") {
        return `region=${String(transition.metadata.region)}`;
      }
    if (
      transition.eventType === "interaction.requested" ||
      transition.eventType === "interaction.resolved" ||
      transition.eventType === "approval.granted"
    ) {
      const parts = [
        typeof transition.metadata?.requestId === "string"
          ? `requestId=${String(transition.metadata.requestId)}`
          : undefined,
        typeof transition.metadata?.grantId === "string"
          ? `grantId=${String(transition.metadata.grantId)}`
          : undefined,
        typeof transition.metadata?.delegationId === "string"
          ? `delegationId=${String(transition.metadata.delegationId)}`
          : undefined,
      ].filter((value): value is string => value !== undefined);
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    if (transition.eventType === "runtime.assembly.changed") {
      const parts = [
        typeof transition.metadata?.bundleId === "string"
          ? `bundleId=${String(transition.metadata.bundleId)}`
          : undefined,
        typeof transition.metadata?.cause === "string"
          ? `cause=${String(transition.metadata.cause)}`
          : undefined,
        typeof transition.metadata?.authority === "string"
          ? `authority=${String(transition.metadata.authority)}`
          : undefined,
      ].filter((value): value is string => value !== undefined);
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    if (transition.eventType === "context.compaction_applied" && typeof transition.metadata?.summaryArtifactId === "string") {
        return `summaryArtifactId=${String(transition.metadata.summaryArtifactId)}`;
      }
    if (transition.eventType === "context.adaptation_applied") {
      const parts = [
        typeof transition.metadata?.action === "string"
          ? `action=${String(transition.metadata.action)}`
          : undefined,
        typeof transition.metadata?.summaryArtifactId === "string"
          ? `summaryArtifactId=${String(transition.metadata.summaryArtifactId)}`
          : undefined,
        typeof transition.metadata?.childThreadId === "string"
          ? `childThreadId=${String(transition.metadata.childThreadId)}`
          : undefined,
      ].filter((value): value is string => value !== undefined);
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    if (transition.eventType.startsWith("delegation.")) {
      const parts = [
        typeof transition.metadata?.delegationId === "string"
          ? `delegationId=${String(transition.metadata.delegationId)}`
          : undefined,
        typeof transition.metadata?.childThreadId === "string"
          ? `childThreadId=${String(transition.metadata.childThreadId)}`
          : undefined,
        typeof transition.metadata?.supervisionGroupId === "string"
          ? `groupId=${String(transition.metadata.supervisionGroupId)}`
          : typeof transition.metadata?.groupId === "string"
            ? `groupId=${String(transition.metadata.groupId)}`
            : undefined,
        typeof transition.metadata?.fanInDecision === "string"
          ? `fanInDecision=${String(transition.metadata.fanInDecision)}`
          : typeof transition.metadata?.fanInAction === "string"
            ? `fanInDecision=${String(transition.metadata.fanInAction)}`
            : undefined,
        typeof transition.metadata?.status === "string"
          ? `status=${String(transition.metadata.status)}`
          : undefined,
        typeof transition.metadata?.supersededByDelegationId === "string"
          ? `supersededBy=${String(transition.metadata.supersededByDelegationId)}`
          : undefined,
      ].filter((value): value is string => value !== undefined);
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    if (transition.eventType === "terminal.normalized" && typeof transition.metadata?.status === "string") {
      return `status=${String(transition.metadata.status)}`;
    }
    if (transition.eventType === "reasoning.update" && typeof transition.metadata?.message === "string") {
      return summarizeReasoningMessage(String(transition.metadata.message));
    }
    return ;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toReplayEvidenceRecoverySummary(
  summary: NonNullable<ReturnType<typeof normalizeEvidenceRecoverySummary>>,
  terminalOutcome?: string | undefined,
): ReplayEvidenceRecoverySummary {
  return {
    ...(summary.family !== undefined ? { family: summary.family } : {}),
    attempts: summary.attempts,
    lowSignalAttempts: summary.lowSignalAttempts,
    consecutiveLowSignal: summary.consecutiveLowSignal,
    broadenedSearchUsed: summary.broadenedSearchUsed,
    targetedFetchUsed: summary.targetedFetchUsed,
    ...(summary.duplicateEvents > 0 ? { duplicateEvents: summary.duplicateEvents } : {}),
    ...(summary.latestDuplicate?.kind !== undefined ? { latestDuplicateKind: summary.latestDuplicate.kind } : {}),
    ...(summary.latestDuplicate?.duplicateCount !== undefined
      ? { latestDuplicateCount: summary.latestDuplicate.duplicateCount }
      : {}),
    ...(summary.latestDuplicate?.matchedPriorStep !== undefined
      ? { latestDuplicateMatchedPriorStep: summary.latestDuplicate.matchedPriorStep }
      : {}),
    ...(summary.latest?.quality !== undefined ? { latestQuality: summary.latest.quality } : {}),
    ...(summary.latest?.issues !== undefined ? { latestIssues: summary.latest.issues } : {}),
    ...(terminalOutcome !== undefined ? { terminalOutcome } : {}),
  };
}

function extractEvidenceRecoverySummary(
  value: unknown,
  terminalOutcome?: string | undefined,
): ReplayEvidenceRecoverySummary | undefined {
  const normalized = normalizeEvidenceRecoverySummary(value);
  if (normalized === undefined) {
    return ;
  }
  const base = toReplayEvidenceRecoverySummary(normalized, terminalOutcome);
  const latest = asRecord(asRecord(value)?.latest);
  const latestQuality = readString(latest?.quality);
  const latestIssues = readStringArray(latest?.issues);
  return {
    ...base,
    ...(typeof asRecord(value)?.duplicateEvents === "number"
      ? { duplicateEvents: Number(asRecord(value)?.duplicateEvents) }
      : {}),
    ...(readString(asRecord(asRecord(value)?.latestDuplicate)?.kind) !== undefined &&
    base.latestDuplicateKind === undefined
      ? { latestDuplicateKind: readString(asRecord(asRecord(value)?.latestDuplicate)?.kind) }
      : {}),
    ...(typeof asRecord(asRecord(value)?.latestDuplicate)?.duplicateCount === "number" &&
    base.latestDuplicateCount === undefined
      ? { latestDuplicateCount: Number(asRecord(asRecord(value)?.latestDuplicate)?.duplicateCount) }
      : {}),
    ...(typeof asRecord(asRecord(value)?.latestDuplicate)?.matchedPriorStep === "number" &&
    base.latestDuplicateMatchedPriorStep === undefined
      ? {
          latestDuplicateMatchedPriorStep: Number(
            asRecord(asRecord(value)?.latestDuplicate)?.matchedPriorStep,
          ),
        }
      : {}),
    ...(base.latestQuality === undefined && latestQuality !== undefined ? { latestQuality } : {}),
    ...(base.latestIssues === undefined && latestIssues.length > 0 ? { latestIssues } : {}),
  };
}

function selectAdaptationSummary(
  checkpoints: ContextCheckpointRecord[],
  compaction: CompactionReport,
  evidenceRecovery: ReplayEvidenceRecoverySummary | undefined,
): ReplayAdaptationSummary | undefined {
  const adaptationCheckpoints = checkpoints.filter((checkpoint) => {
    const metadata = asRecord(checkpoint.metadata);
    return readString(metadata?.kind) !== "fan_in";
  });
  const latestCheckpoint = adaptationCheckpoints
    .slice()
    .sort((left, right) => {
      const leftAt = left.resolvedAt ?? left.createdAt;
      const rightAt = right.resolvedAt ?? right.createdAt;
      return rightAt.localeCompare(leftAt);
    })[0];
  const latestEvent = compaction.events[0];
  const latestCheckpointAt = latestCheckpoint?.resolvedAt ?? latestCheckpoint?.createdAt;
  const latestEventAt = latestEvent?.createdAt;
  const latestEventMetadata = asRecord(latestEvent?.metadata);
  const latestEventCheckpointId = readString(latestEventMetadata?.checkpointId);

  if (
    latestCheckpoint !== undefined &&
    latestCheckpoint.status !== "PENDING" &&
    latestEvent !== undefined &&
    latestEventCheckpointId === latestCheckpoint.checkpointId
  ) {
    return {
      status: latestCheckpoint.status === "DEFERRED" ? "deferred" : "accepted",
      recommendedAction: latestCheckpoint.resolutionAction ?? latestCheckpoint.recommendedAction,
      reason: latestCheckpoint.reason,
      ...(latestCheckpoint.signals !== undefined ? { sourceSignals: latestCheckpoint.signals } : {}),
      checkpointId: latestCheckpoint.checkpointId,
      eventId: latestEvent.eventId,
      ...(latestEvent.summaryArtifactId !== undefined ? { summaryArtifactId: latestEvent.summaryArtifactId } : {}),
      ...(readString(latestEventMetadata?.childThreadId) !== undefined
        ? { childThreadId: readString(latestEventMetadata?.childThreadId) }
        : {}),
      ...(readString(latestEventMetadata?.delegationId) !== undefined
        ? { delegationId: readString(latestEventMetadata?.delegationId) }
        : {}),
      at: latestCheckpointAt ?? latestEvent.createdAt,
    };
  }

  if (latestCheckpoint !== undefined && (latestEventAt === undefined || (latestCheckpointAt ?? "") >= latestEventAt)) {
    return {
      status:
        latestCheckpoint.status === "PENDING"
          ? "pending_checkpoint"
          : latestCheckpoint.status === "DEFERRED"
            ? "deferred"
            : "accepted",
      recommendedAction: latestCheckpoint.resolutionAction ?? latestCheckpoint.recommendedAction,
      reason: latestCheckpoint.reason,
      ...(latestCheckpoint.signals !== undefined ? { sourceSignals: latestCheckpoint.signals } : {}),
      checkpointId: latestCheckpoint.checkpointId,
      at: latestCheckpointAt ?? latestCheckpoint.createdAt,
    };
  }

  if (latestEvent !== undefined) {
    return {
      status: "auto_applied",
      recommendedAction: latestEvent.action,
      reason: latestEvent.reason,
      ...(asRecord(latestEventMetadata?.sourceSignals) !== undefined
        ? { sourceSignals: asRecord(latestEventMetadata?.sourceSignals) }
        : evidenceRecovery !== undefined
          ? {
              sourceSignals: {
                evidenceRecovery,
              },
            }
          : {}),
      eventId: latestEvent.eventId,
      ...(latestEvent.summaryArtifactId !== undefined ? { summaryArtifactId: latestEvent.summaryArtifactId } : {}),
      ...(readString(latestEventMetadata?.childThreadId) !== undefined
        ? { childThreadId: readString(latestEventMetadata?.childThreadId) }
        : {}),
      ...(readString(latestEventMetadata?.delegationId) !== undefined
        ? { delegationId: readString(latestEventMetadata?.delegationId) }
        : {}),
      at: latestEvent.createdAt,
    };
  }

  return ;
}

function groupKindFromTransition(
  eventType: string,
  domain: ReplayTransitionRecord["domain"],
): ReplayGroupKind {
  if (eventType.startsWith("step.")) {
    return "step";
  }
  if (
    eventType === "wait.entered" ||
    eventType === "wait.resumed" ||
    eventType === "run.waiting" ||
    eventType === "run.resumed"
  ) {
    return "wait";
  }
  if (
    eventType === "interaction.requested" ||
    eventType === "interaction.resolved" ||
    eventType === "approval.granted"
  ) {
    return "approval";
  }
  if (eventType === "runtime.assembly.changed") {
    return "assembly";
  }
  if (eventType.startsWith("delegation.")) {
    return "delegation";
  }
  if (eventType.startsWith("context.compaction") || eventType === "context.adaptation_applied") {
    return "compaction";
  }
  if (eventType.startsWith("region.scheduler.") || domain === "scheduler") {
    return "scheduler";
  }
  if (eventType === "terminal.normalized" || eventType === "run.completed" || eventType === "run.failed") {
    return "terminal";
  }
  if (eventType === "loop.guard_triggered") {
    return "loop";
  }
  return "other";
}

function mapWaitKind(kind: string | undefined, eventType: string | undefined): ReplayBlockingKind {
  if (kind === "approval") {
    return "approval";
  }
  if (kind === "user") {
    return "user_input";
  }
  if (kind === "region_merge" || eventType === "region.scheduler.waiting") {
    return "scheduler_wait";
  }
  if (eventType?.startsWith("delegation.") === true) {
    return "delegation";
  }
  if (eventType?.startsWith("context.compaction") === true) {
    return "compaction_checkpoint";
  }
  return "unknown";
}

function dedupeWaitHistory(entries: ActiveWaitReport[]): ActiveWaitReport[] {
  const seen = new Set<string>();
  const ordered = [...entries].sort((left, right) =>
    (left.enteredAt ?? "").localeCompare(right.enteredAt ?? ""),
  );
  return ordered.filter((entry) => {
    const key = [
      entry.kind,
      entry.status,
      entry.threadId ?? "",
      entry.requestId ?? "",
      entry.delegationId ?? "",
      entry.enteredAt ?? "",
    ].join(":");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function readDelegationSupervision(
  delegation: DelegationRecord,
): {
  groupId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
} {
  const policy = asRecord(delegation.policy);
  const supervision = asRecord(policy?.supervision);
  const groupId =
    readString(supervision?.groupId) ??
    readString(policy?.supervisionGroupId) ??
    readString(policy?.groupId);
  const metadata =
    supervision ??
    asRecord(policy?.supervisionMetadata);
  return {
    ...(groupId !== undefined ? { groupId } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function deriveDelegationOutcomeSummary(
  delegation: DelegationRecord,
  supervisionMetadata: Record<string, unknown> | undefined,
): DelegationOutcomeSummary {
  const policy = asRecord(delegation.policy);
  const supersededByDelegationId =
    readString(supervisionMetadata?.supersededByDelegationId) ??
    readString(policy?.supersededByDelegationId);
  const supersedesDelegationId =
    readString(supervisionMetadata?.supersedesDelegationId) ??
    readString(policy?.supersedesDelegationId);
  const supersededAt =
    readString(supervisionMetadata?.supersededAt) ??
    readString(policy?.supersededAt);
  const explicitState =
    readString(supervisionMetadata?.outcomeState) ??
    readString(policy?.outcomeState);
  const state = normalizeOutcomeState({
    explicitState,
    delegationStatus: delegation.status,
    supersededByDelegationId,
  });
  return {
    state,
    ...(delegation.resultSummary !== undefined
      ? { summary: delegation.resultSummary }
      : readString(supervisionMetadata?.outcomeSummary) !== undefined
        ? { summary: readString(supervisionMetadata?.outcomeSummary) }
        : readString(policy?.outcomeSummary) !== undefined
          ? { summary: readString(policy?.outcomeSummary) }
          : {}),
    ...(delegation.errorMessage !== undefined
      ? { reason: delegation.errorMessage }
      : delegation.waitEventType !== undefined
        ? { reason: delegation.waitEventType }
        : readString(supervisionMetadata?.reason) !== undefined
          ? { reason: readString(supervisionMetadata?.reason) }
          : {}),
    ...(delegation.resultContract !== undefined ? { resultContract: delegation.resultContract } : {}),
    ...(supersededByDelegationId !== undefined ? { supersededByDelegationId } : {}),
    ...(supersedesDelegationId !== undefined ? { supersedesDelegationId } : {}),
    ...(supersededAt !== undefined ? { supersededAt } : {}),
  };
}

function normalizeOutcomeState(input: {
  explicitState: string | undefined;
  delegationStatus: DelegationRecord["status"];
  supersededByDelegationId: string | undefined;
}): DelegationOutcomeState {
  const explicit = input.explicitState?.trim().toLowerCase();
  if (explicit === "pending") {
    return "pending";
  }
  if (explicit === "running") {
    return "running";
  }
  if (explicit === "blocked" || explicit === "waiting") {
    return "blocked";
  }
  if (explicit === "partial") {
    return "partial";
  }
  if (explicit === "failed") {
    return "failed";
  }
  if (explicit === "completed" || explicit === "complete") {
    return "completed";
  }
  if (explicit === "superseded") {
    return "superseded";
  }
  if (explicit === "cancelled" || explicit === "canceled") {
    return "cancelled";
  }
  if (input.supersededByDelegationId !== undefined) {
    return "superseded";
  }
  switch (input.delegationStatus) {
    case "PENDING":
      return "pending";
    case "RUNNING":
      return "running";
    case "WAITING":
      return "blocked";
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      return "unknown";
  }
}

function collectDelegationFanInDecisions(input: {
  delegation: DelegationRecord;
  events: RunEvent[];
  supervisionGroupId?: string | undefined;
}): DelegationFanInDecision[] {
  const decisions: DelegationFanInDecision[] = [];
  const policy = asRecord(input.delegation.policy);
  const supervisionMetadata = asRecord(policy?.supervision);
  if (Array.isArray(supervisionMetadata?.fanInDecisions)) {
    for (const record of supervisionMetadata.fanInDecisions) {
      const item = asRecord(record);
      const decision = readFanInDecision(item);
      if (decision === undefined) {
        continue;
      }
      decisions.push({
        at: readString(item?.at) ?? input.delegation.updatedAt,
        eventType: "delegation.fan_in.persisted",
        decision,
        ...(readString(item?.groupId) !== undefined
          ? { groupId: readString(item?.groupId) }
          : input.supervisionGroupId !== undefined
            ? { groupId: input.supervisionGroupId }
            : {}),
        delegationId: input.delegation.delegationId,
        childThreadId: input.delegation.childThreadId,
        ...(readString(item?.decidedBy) !== undefined ? { decidedBy: readString(item?.decidedBy) } : {}),
        ...(readString(item?.reason) !== undefined ? { reason: readString(item?.reason) } : {}),
        ...(item !== undefined ? { metadata: item } : {}),
      });
    }
  }
  for (const event of input.events) {
    if (event.type.startsWith("delegation.") === false) {
      continue;
    }
    const metadata = asRecord(event.metadata);
    if (metadata === undefined) {
      continue;
    }
    const metadataDelegationId = readString(metadata.delegationId);
    const metadataChildThreadId = readString(metadata.childThreadId);
    const metadataGroupId =
      readString(metadata.supervisionGroupId) ??
      readString(metadata.groupId);
    const relates =
      metadataDelegationId === input.delegation.delegationId ||
      metadataChildThreadId === input.delegation.childThreadId ||
      (metadataGroupId !== undefined && metadataGroupId === input.supervisionGroupId);
    if (relates === false) {
      continue;
    }
    const decision = readFanInDecision(metadata);
    if (decision === undefined) {
      continue;
    }
    decisions.push({
      at: event.timestamp,
      eventType: event.type,
      decision,
      ...(metadataGroupId !== undefined
        ? { groupId: metadataGroupId }
        : input.supervisionGroupId !== undefined
          ? { groupId: input.supervisionGroupId }
          : {}),
      ...(metadataDelegationId !== undefined
        ? { delegationId: metadataDelegationId }
        : { delegationId: input.delegation.delegationId }),
      ...(metadataChildThreadId !== undefined
        ? { childThreadId: metadataChildThreadId }
        : { childThreadId: input.delegation.childThreadId }),
      ...(readString(metadata.decidedBy) !== undefined
        ? { decidedBy: readString(metadata.decidedBy) }
        : {}),
      ...(readString(metadata.reason) !== undefined
        ? { reason: readString(metadata.reason) }
        : readString(metadata.message) !== undefined
          ? { reason: readString(metadata.message) }
          : {}),
      metadata,
    });
  }
  return dedupeFanInDecisions(decisions);
}

function collectGroupFanInDecisions(events: RunEvent[], groupId: string): DelegationFanInDecision[] {
  const decisions: DelegationFanInDecision[] = [];
  for (const event of events) {
    if (event.type.startsWith("delegation.") === false) {
      continue;
    }
    const metadata = asRecord(event.metadata);
    const eventGroupId =
      readString(metadata?.supervisionGroupId) ??
      readString(metadata?.groupId);
    if (eventGroupId !== groupId) {
      continue;
    }
    const decision = readFanInDecision(metadata);
    if (decision === undefined) {
      continue;
    }
    decisions.push({
      at: event.timestamp,
      eventType: event.type,
      decision,
      groupId,
      ...(readString(metadata?.delegationId) !== undefined
        ? { delegationId: readString(metadata?.delegationId) }
        : {}),
      ...(readString(metadata?.childThreadId) !== undefined
        ? { childThreadId: readString(metadata?.childThreadId) }
        : {}),
      ...(readString(metadata?.decidedBy) !== undefined
        ? { decidedBy: readString(metadata?.decidedBy) }
        : {}),
      ...(readString(metadata?.reason) !== undefined
        ? { reason: readString(metadata?.reason) }
        : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }
  return dedupeFanInDecisions(decisions);
}

function readFanInDecision(metadata: Record<string, unknown> | undefined): string | undefined {
  const direct =
    readString(metadata?.fanInDecision) ??
    readString(metadata?.fanInAction) ??
    readString(asRecord(metadata?.fanInDecision)?.decision);
  if (direct !== undefined) {
    return direct;
  }
  if (metadata?.fanIn === true || readString(metadata?.decisionType) === "fan_in") {
    return readString(metadata?.decision);
  }
  return ;
}

function dedupeFanInDecisions(decisions: DelegationFanInDecision[]): DelegationFanInDecision[] {
  const seen = new Set<string>();
  return decisions
    .slice()
    .sort((left, right) => left.at.localeCompare(right.at))
    .filter((decision) => {
      const key = [
        decision.at,
        decision.eventType,
        decision.decision,
        decision.groupId ?? "",
        decision.delegationId ?? "",
        decision.childThreadId ?? "",
      ].join(":");
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function dedupeSupersededLineage(
  entries: ReplaySupervisionReport["supersededLineage"],
): ReplaySupervisionReport["supersededLineage"] {
  const seen = new Set<string>();
  return entries
    .slice()
    .sort((left, right) => (left.supersededAt ?? "").localeCompare(right.supersededAt ?? ""))
    .filter((entry) => {
      const key = `${entry.delegationId}:${entry.supersededByDelegationId}:${entry.supersededAt ?? ""}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function selectDominantBlocker(
  delegations: DelegationReport[],
): ReplayDominantBlocker | undefined {
  const winner = delegations
    .filter((entry) => {
      if (entry.outcome.state === "superseded") {
        return false;
      }
      return (
        entry.delegation.status === "WAITING" ||
        entry.delegation.status === "FAILED" ||
        entry.delegation.status === "RUNNING" ||
        entry.delegation.status === "PENDING"
      );
    })
    .sort((left, right) => {
      const statusRank = delegationBlockerRank(left.delegation.status) - delegationBlockerRank(right.delegation.status);
      if (statusRank !== 0) {
        return statusRank;
      }
      return right.delegation.updatedAt.localeCompare(left.delegation.updatedAt);
    })[0];
  if (winner === undefined) {
    return ;
  }
  return {
    delegationId: winner.delegation.delegationId,
    childThreadId: winner.delegation.childThreadId,
    status: winner.delegation.status,
    ...(winner.blockedBy?.detail !== undefined
      ? { reason: winner.blockedBy.detail }
      : winner.outcome.reason !== undefined
        ? { reason: winner.outcome.reason }
        : {}),
    ...(winner.supervisionGroupId !== undefined ? { groupId: winner.supervisionGroupId } : {}),
  };
}

function delegationBlockerRank(status: DelegationRecord["status"]): number {
  switch (status) {
    case "WAITING":
      return 0;
    case "FAILED":
      return 1;
    case "RUNNING":
      return 2;
    case "PENDING":
      return 3;
    default:
      return 99;
  }
}

function summarizeReasoningMessage(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= 180) {
    return normalized;
  }
  return `${normalized.slice(0, 177)}...`;
}

function readModelBudgetClassFromMetadata(
  value: Record<string, unknown> | undefined,
): "action" | "maintenance" | undefined {
  return value?.modelBudgetClass === "maintenance" ? "maintenance" : value?.modelBudgetClass === "action" ? "action" : undefined;
}

function readModelBudgetClassFromReplayCall(call: {
  phase?: string | undefined;
  metadata?: { modelBudgetClass?: "action" | "maintenance" | undefined } | undefined;
}): "action" | "maintenance" {
  const explicit = readModelBudgetClassFromMetadata(call.metadata);
  if (explicit !== undefined) {
    return explicit;
  }
  return call.phase === "agent.compaction" ? "maintenance" : "action";
}

function sanitizeModelProvenanceMetadata(value: Record<string, unknown> | undefined): {
  modelBudgetClass?: "action" | "maintenance" | undefined;
  droppedSections?: unknown[] | undefined;
  summaryArtifactId?: string | undefined;
  freshness?: Record<string, unknown> | undefined;
  promptDump?: {
    jsonPath?: string | undefined;
  } | undefined;
} | undefined {
  if (value === undefined) {
    return ;
  }
  const promptDump = asRecord(value.promptDump);
  const sanitizedPromptDump = {
    ...(readString(promptDump?.jsonPath) !== undefined ? { jsonPath: readString(promptDump?.jsonPath) } : {}),
  };
  const sanitized = {
    ...(readModelBudgetClassFromMetadata(value) !== undefined
      ? { modelBudgetClass: readModelBudgetClassFromMetadata(value) }
      : {}),
    ...(Array.isArray(value.droppedSections) ? { droppedSections: value.droppedSections } : {}),
    ...(readString(value.summaryArtifactId) !== undefined
      ? { summaryArtifactId: readString(value.summaryArtifactId) }
      : {}),
    ...(asRecord(value.freshness) !== undefined ? { freshness: asRecord(value.freshness) } : {}),
    ...(Object.keys(sanitizedPromptDump).length > 0 ? { promptDump: sanitizedPromptDump } : {}),
  };
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function dedupeDelegations(records: DelegationRecord[]): DelegationRecord[] {
  const seen = new Set<string>();
  const ordered = [...records].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return ordered.filter((record) => {
    if (seen.has(record.delegationId)) {
      return false;
    }
    seen.add(record.delegationId);
    return true;
  });
}

function selectLatestAssemblyEntry(
  history: ReplayAssemblyEntry[],
): ReplayAssemblyEntry | undefined {
  let latest: ReplayAssemblyEntry | undefined;
  for (const entry of history) {
    if (latest === undefined || entry.record.createdAt >= latest.record.createdAt) {
      latest = entry;
    }
  }
  return latest;
}
