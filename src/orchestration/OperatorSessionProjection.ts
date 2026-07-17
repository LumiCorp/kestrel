import type { NormalizedOutput } from "../kestrel/contracts/execution.js";
import type { SubAgentResultEnvelope } from "../kestrel/contracts/orchestration.js";

import type { ReplayBlockingKind } from "../replay/RunReplayService.js";
import {
  readActiveWaitState,
  type RuntimeWaitKind,
} from "../runtime/waitState.js";
import {
  normalizeVisibleTodoState,
  type VisibleTodoState,
} from "../runtime/visibleTodos.js";
import type {
  AdaptationSummary,
  AssemblyBundleRecord,
  ContextCheckpointRecord,
  DelegationRecord,
  FanInDispositionSummary,
  OperatorChildResultSummary,
  OperatorEvidenceRecoverySummary,
  OperatorInboxSnapshot,
  OperatorRuntimePlanSummary,
  OperatorThreadView,
  ThreadRecord,
  ThreadStatusSnapshot,
} from "./contracts.js";

export interface OperatorAssemblyProviderSummary {
  id: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio";
  model: string;
  promptVariant?: string | undefined;
  compatibilityProfile?: string | undefined;
}

export interface OperatorAssemblyCompatibilitySummary {
  status?: "compatible" | "downgraded" | "incompatible" | undefined;
  decisionSource?: "profile" | "policy" | "operator" | "model" | "runtime" | undefined;
  compatibilityProfile?: string | undefined;
  downgradeReason?: string | undefined;
  capabilityLossReason?: string | undefined;
}

export interface OperatorAssemblySummary {
  mode: "explicit" | "implicit_legacy";
  threadId?: string | undefined;
  bundleId?: string | undefined;
  label?: string | undefined;
  source?: string | undefined;
  authority?: "profile" | "policy" | "operator" | "model" | undefined;
  cause?:
    | "thread_start"
    | "turn_start"
    | "proposal"
    | "capability_loss"
    | "policy_change"
    | "context_pressure"
    | "inheritance"
    | undefined;
  toolAllowlist?: string[] | undefined;
  specialistIds?: string[] | undefined;
  contextPolicyId?: string | undefined;
  approvalPolicyId?: string | undefined;
  latestProposalStatus?: "PENDING" | "APPROVED" | "REJECTED" | undefined;
  latestDecisionResult?: "ALLOWED" | "APPROVAL_REQUIRED" | "REJECTED" | undefined;
  provider?: OperatorAssemblyProviderSummary | undefined;
  compatibility?: OperatorAssemblyCompatibilitySummary | undefined;
}

export interface OperatorInboxSummary {
  total: number;
  actionable: number;
  approvals: number;
  userInputs: number;
  checkpoints: number;
  childBlockers: number;
  stalled: number;
  assemblyProposals: number;
  compatibilityAlerts: number;
}

export interface OperatorCheckpointSummary {
  checkpointId: string;
  status: "PENDING" | "ACCEPTED" | "DEFERRED" | "REJECTED";
  recommendedAction:
    | "continue"
    | "compact"
    | "summarize_forward"
    | "handoff"
    | "split_into_child_thread"
    | "operator_checkpoint";
  reason: string;
  resolutionAction?:
    | "continue"
    | "compact"
    | "summarize_forward"
    | "handoff"
    | "split_into_child_thread"
    | "operator_checkpoint"
    | undefined;
}

export interface OperatorChildBlockerSummary {
  delegationId: string;
  childThreadId: string;
  status: "PENDING" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED";
  reason?: string | undefined;
}

export interface OperatorChildBlockerChainSummary {
  threadId: string;
  title: string;
  status: "IDLE" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
  delegationId?: string | undefined;
  waitEventType?: string | undefined;
  reason?: string | undefined;
}

export interface OperatorSupervisedChildSummary {
  threadId: string;
  title: string;
  status: "IDLE" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
  updatedAt: string;
  outcomeState?: "running" | "blocked" | "partial" | "failed" | "completed" | "superseded" | undefined;
  actionable?: boolean | undefined;
  waitEventType?: string | undefined;
  lastRunStatus?: NormalizedOutput["status"] | undefined;
  delegationId?: string | undefined;
  delegationStatus?: "PENDING" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED" | undefined;
  result?: SubAgentResultEnvelope | undefined;
  outcomeSummary?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  references?: string[] | undefined;
  superseded?: boolean | undefined;
  latestFanInDisposition?: "pending_checkpoint" | "auto_applied" | "accepted" | "deferred" | undefined;
  latestFanInCheckpointId?: string | undefined;
}

export interface OperatorFanInDispositionSummary {
  status: "not_recorded" | "pending_checkpoint" | "auto_applied" | "accepted" | "deferred";
  checkpointId?: string | undefined;
  summary?: string | undefined;
  selectedDelegationIds?: string[] | undefined;
  at?: string | undefined;
}

export interface OperatorSupervisionSummary {
  groupId: string;
  status: "active" | "waiting_fan_in" | "auto_reconciled" | "accepted" | "deferred";
  childCount: number;
  activeCount: number;
  terminalCount: number;
  dominantBlockerDelegationId?: string | undefined;
  checkpointId?: string | undefined;
  nextAction?: string | undefined;
}

export type OperatorSteeringSummary = NonNullable<OperatorThreadView["latestSteering"]>;
export type OperatorReasoningSummary = NonNullable<OperatorThreadView["latestReasoning"]>;
export type {
  AdaptationSummary as OperatorAdaptationSummary,
  OperatorChildResultSummary,
  OperatorEvidenceRecoverySummary,
  OperatorRuntimePlanSummary,
} from "./contracts.js";

export interface OperatorSessionProjectionRuntime {
  ensureMainThreadForSession?: ((input: {
    sessionId: string;
    title?: string | undefined;
  }) => Promise<ThreadRecord>) | undefined;
  startThread?: ((input: {
    threadId?: string | undefined;
    sessionId?: string | undefined;
    title: string;
    metadata?: Record<string, unknown> | undefined;
  }) => Promise<ThreadRecord>) | undefined;
  getThreadStatus(threadId: string): Promise<ThreadStatusSnapshot | null>;
  listOperatorInbox(input: {
    sessionId?: string | undefined;
    threadId?: string | undefined;
  }): Promise<OperatorInboxSnapshot>;
  getOperatorThreadView(threadId: string): Promise<OperatorThreadView | null>;
  listDelegations?: ((threadId: string) => Promise<DelegationRecord[]>) | undefined;
}

export interface OperatorSessionProjectionInput {
  sessionId: string;
  session: {
    version: number;
    currentStepAgent?: string | undefined;
    updatedAt?: string | undefined;
    state: Record<string, unknown>;
  };
  threadRuntime?: OperatorSessionProjectionRuntime | undefined;
}

export interface OperatorSessionProjection {
  sessionId: string;
  version: number;
  threadId?: string | undefined;
  currentStepAgent?: string | undefined;
  updatedAt?: string | undefined;
  waitFor?: NormalizedOutput["waitFor"] | undefined;
  activeAssembly?: OperatorAssemblySummary | undefined;
  operatorInbox?: OperatorInboxSummary | undefined;
  childBlocker?: OperatorChildBlockerSummary | undefined;
  childThreads?: OperatorSupervisedChildSummary[] | undefined;
  childResults?: OperatorChildResultSummary[] | undefined;
  childBlockerChainDetails?: OperatorChildBlockerChainSummary[] | undefined;
  blockerChain?: string[] | undefined;
  dominantBlocker?: string | undefined;
  latestCheckpoint?: OperatorCheckpointSummary | undefined;
  latestCheckpointDisposition?: OperatorCheckpointSummary["status"] | undefined;
  latestFanInDisposition?: OperatorFanInDispositionSummary | undefined;
  latestSteering?: OperatorSteeringSummary | undefined;
  latestReasoning?: OperatorReasoningSummary | undefined;
  latestAdaptation?: AdaptationSummary | undefined;
  latestEvidenceRecovery?: OperatorEvidenceRecoverySummary | undefined;
  supervision?: OperatorSupervisionSummary | undefined;
  nextAction?: string | undefined;
  runtimePlan?: OperatorRuntimePlanSummary | undefined;
  visibleTodos?: VisibleTodoState | undefined;
  contextPosture?: string | undefined;
  operatorPhase?: OperatorThreadView["operatorPhase"] | undefined;
  modelProvenance?: OperatorThreadView["modelProvenance"] | undefined;
  focusedThreadId?: string | undefined;
  operatorThreadView?: OperatorThreadView | undefined;
}

export async function buildOperatorSessionProjection(
  input: OperatorSessionProjectionInput,
): Promise<OperatorSessionProjection> {
  const updatedAt = normalizeOptionalSessionTimestamp(input.session.updatedAt);
  const mainThread = await ensureMainThread(input.sessionId, input.threadRuntime);
  const threadStatus =
    input.threadRuntime !== undefined && mainThread !== undefined
      ? await input.threadRuntime.getThreadStatus(mainThread.threadId)
      : null;
  const operatorInbox =
    input.threadRuntime !== undefined
      ? await input.threadRuntime.listOperatorInbox({ sessionId: input.sessionId })
      : undefined;
  const operatorFocusThreadId =
    operatorInbox?.focusThreadId ??
    threadStatus?.thread.threadId ??
    mainThread?.threadId;
  const focusedThreadStatus =
    input.threadRuntime !== undefined && operatorFocusThreadId !== undefined
      ? await input.threadRuntime.getThreadStatus(operatorFocusThreadId)
      : null;
  const operatorView =
    input.threadRuntime !== undefined && operatorFocusThreadId !== undefined
      ? await input.threadRuntime.getOperatorThreadView(operatorFocusThreadId)
      : null;
  const focusedThreadId =
    operatorInbox?.focusThreadId ??
    operatorView?.thread.threadId ??
    focusedThreadStatus?.thread.threadId ??
    threadStatus?.thread.threadId;
  const dominantBlocker = describeDominantBlocker(operatorView);
  const blockerChain = readBlockerChain(operatorView);
  const childBlockerChainDetails = toChildBlockerChainDetails(operatorView);
  const childDelegations =
    input.threadRuntime?.listDelegations !== undefined && operatorView !== null
      ? await input.threadRuntime.listDelegations(operatorView.thread.threadId)
      : [];
  const childThreads = toChildThreadSummaries(operatorView, childDelegations);
  const contextPosture = readContextPosture(operatorView);
  const waitFor = readDescribeWaitFor({
    sessionState: input.session.state,
    focusedThreadStatus,
    fallbackThreadStatus: threadStatus,
    operatorView,
  });
  const visibleTodos = normalizeVisibleTodoState(
    asRecord(input.session.state.agent)?.visibleTodos,
  );

  return {
    sessionId: input.sessionId,
    version: input.session.version,
    ...(mainThread !== undefined
      ? { threadId: mainThread.threadId }
      : threadStatus !== null
        ? { threadId: threadStatus.thread.threadId }
        : {}),
    ...(input.session.currentStepAgent !== undefined ? { currentStepAgent: input.session.currentStepAgent } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(waitFor !== undefined ? { waitFor } : {}),
    ...(focusedThreadStatus !== null
      ? { activeAssembly: toOperatorAssemblySummary(focusedThreadStatus) }
      : threadStatus !== null
        ? { activeAssembly: toOperatorAssemblySummary(threadStatus) }
        : {}),
    ...(operatorInbox !== undefined ? { operatorInbox: toOperatorInboxSummary(operatorInbox) } : {}),
    ...(operatorView?.childBlocker !== undefined ? { childBlocker: operatorView.childBlocker } : {}),
    ...(childThreads.length > 0 ? { childThreads } : {}),
    ...(operatorView?.childResults !== undefined ? { childResults: operatorView.childResults } : {}),
    ...(childBlockerChainDetails.length > 0 ? { childBlockerChainDetails } : {}),
    ...(blockerChain.length > 0 ? { blockerChain } : {}),
    ...(dominantBlocker !== undefined ? { dominantBlocker } : {}),
    ...(operatorView?.latestCheckpoint !== undefined ? { latestCheckpoint: toCheckpointSummary(operatorView.latestCheckpoint) } : {}),
    ...(operatorView?.latestCheckpointDisposition?.status !== undefined
      ? { latestCheckpointDisposition: operatorView.latestCheckpointDisposition.status }
      : {}),
    ...(operatorView?.latestFanInDisposition !== undefined
      ? { latestFanInDisposition: toFanInDispositionSummary(operatorView.latestFanInDisposition) }
      : {}),
    ...(operatorView?.latestSteering !== undefined ? { latestSteering: operatorView.latestSteering } : {}),
    ...(operatorView?.latestReasoning !== undefined ? { latestReasoning: operatorView.latestReasoning } : {}),
    ...(operatorView?.latestAdaptation !== undefined ? { latestAdaptation: operatorView.latestAdaptation } : {}),
    ...(operatorView?.latestEvidenceRecovery !== undefined
      ? { latestEvidenceRecovery: operatorView.latestEvidenceRecovery }
      : {}),
    ...(operatorView?.nextAction !== undefined
      ? {
          nextAction:
            typeof operatorView.nextAction === "string"
              ? operatorView.nextAction
              : operatorView.nextAction.summary,
        }
      : {}),
    ...(operatorView?.runtimePlan !== undefined ? { runtimePlan: operatorView.runtimePlan } : {}),
    ...(visibleTodos !== undefined ? { visibleTodos } : {}),
    ...(contextPosture !== undefined ? { contextPosture } : {}),
    ...(operatorView?.operatorPhase !== undefined ? { operatorPhase: operatorView.operatorPhase } : {}),
    ...(operatorView?.modelProvenance !== undefined ? { modelProvenance: operatorView.modelProvenance } : {}),
    ...(operatorView?.supervision !== undefined ? { supervision: toSupervisionSummary(operatorView.supervision) } : {}),
    ...(focusedThreadId !== undefined ? { focusedThreadId } : {}),
    ...(operatorView !== null ? { operatorThreadView: operatorView } : {}),
  };
}

function normalizeOptionalSessionTimestamp(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return ;
  }
  return value;
}

export function toOperatorAssemblySummary(
  threadStatus: ThreadStatusSnapshot,
): OperatorAssemblySummary | undefined {
  const record = threadStatus.activeAssembly;
  if (record === undefined) {
    return {
      mode: "implicit_legacy",
      threadId: threadStatus.thread.threadId,
      label: "implicit/legacy",
    };
  }
  const bundle = threadStatus.assemblyBundle;
  const latestDecision = findLatestAssemblyDecision(threadStatus.thread.metadata);
  return {
    mode: record.bundleId === "implicit/legacy" ? "implicit_legacy" : "explicit",
    threadId: threadStatus.thread.threadId,
    bundleId: bundle?.bundleId ?? record.bundleId,
    ...(bundle?.label !== undefined ? { label: bundle.label } : {}),
    ...(bundle?.source !== undefined ? { source: bundle.source } : {}),
    authority: record.authority,
    cause: record.cause,
    ...(bundle?.toolAllowlist !== undefined ? { toolAllowlist: [...bundle.toolAllowlist] } : {}),
    ...(bundle?.specialistIds !== undefined ? { specialistIds: [...bundle.specialistIds] } : {}),
    ...(bundle?.contextPolicyId !== undefined ? { contextPolicyId: bundle.contextPolicyId } : {}),
    ...(bundle?.approvalPolicyId !== undefined ? { approvalPolicyId: bundle.approvalPolicyId } : {}),
    ...(latestDecision?.proposalStatus !== undefined
      ? { latestProposalStatus: latestDecision.proposalStatus }
      : {}),
    ...(latestDecision?.decisionResult !== undefined
      ? { latestDecisionResult: latestDecision.decisionResult }
      : {}),
    ...(toAssemblyProviderSummary(bundle?.metadata) !== undefined
      ? { provider: toAssemblyProviderSummary(bundle?.metadata) }
      : {}),
    ...(toAssemblyCompatibilitySummary(bundle?.metadata) !== undefined
      ? { compatibility: toAssemblyCompatibilitySummary(bundle?.metadata) }
      : {}),
  };
}

async function ensureMainThread(
  sessionId: string,
  threadRuntime: OperatorSessionProjectionRuntime | undefined,
): Promise<ThreadRecord | undefined> {
  if (threadRuntime === undefined) {
    return ;
  }
  if (typeof threadRuntime.ensureMainThreadForSession === "function") {
    return threadRuntime.ensureMainThreadForSession({
      sessionId,
      title: sessionId,
    });
  }
  const existing = await threadRuntime.getThreadStatus(sessionId);
  if (existing !== null) {
    return existing.thread;
  }
  if (typeof threadRuntime.startThread === "function") {
    return threadRuntime.startThread({
      threadId: sessionId,
      sessionId,
      title: sessionId,
      metadata: {
        legacyImported: true,
      },
    });
  }
  return ;
}

function toOperatorInboxSummary(inbox: OperatorInboxSnapshot): OperatorInboxSummary {
  return { ...inbox.summary };
}

function toCheckpointSummary(checkpoint: ContextCheckpointRecord): OperatorCheckpointSummary {
  return {
    checkpointId: checkpoint.checkpointId,
    status: checkpoint.status,
    recommendedAction: checkpoint.recommendedAction,
    reason: checkpoint.reason,
    ...(checkpoint.resolutionAction !== undefined ? { resolutionAction: checkpoint.resolutionAction } : {}),
  };
}

function findLatestAssemblyDecision(
  metadata: Record<string, unknown> | undefined,
): {
  proposalStatus?: OperatorAssemblySummary["latestProposalStatus"] | undefined;
  decisionResult?: OperatorAssemblySummary["latestDecisionResult"] | undefined;
} | undefined {
  const assembly = asRecord(metadata?.runtimeAssembly);
  const proposalStatus = asString(assembly?.latestProposalStatus);
  const decisionResult = asString(assembly?.latestDecisionResult);
  if (proposalStatus === undefined && decisionResult === undefined) {
    return ;
  }
  return {
    ...(proposalStatus === "PENDING" || proposalStatus === "APPROVED" || proposalStatus === "REJECTED"
      ? { proposalStatus }
      : {}),
    ...(decisionResult === "ALLOWED" || decisionResult === "APPROVAL_REQUIRED" || decisionResult === "REJECTED"
      ? { decisionResult }
      : {}),
  };
}

function toAssemblyProviderSummary(
  metadata: AssemblyBundleRecord["metadata"] | undefined,
): OperatorAssemblySummary["provider"] | undefined {
  const providerId = asString(metadata?.modelProvider);
  const model = asString(metadata?.model);
  if (
    (providerId !== "openrouter" && providerId !== "openai" && providerId !== "anthropic") ||
    model === undefined
  ) {
    return ;
  }
  return {
    id: providerId,
    model,
    ...(asString(metadata?.promptVariant) !== undefined
      ? { promptVariant: asString(metadata?.promptVariant) }
      : {}),
    ...(asString(metadata?.compatibilityProfile) !== undefined
      ? { compatibilityProfile: asString(metadata?.compatibilityProfile) }
      : {}),
  };
}

function toAssemblyCompatibilitySummary(
  metadata: AssemblyBundleRecord["metadata"] | undefined,
): OperatorAssemblySummary["compatibility"] | undefined {
  const status = asString(metadata?.compatibilityStatus);
  const decisionSource = asString(metadata?.compatibilityDecisionSource);
  const downgradeReason = asString(metadata?.downgradeReason);
  const capabilityLossReason = asString(metadata?.capabilityLossReason);
  if (
    status === undefined &&
    decisionSource === undefined &&
    downgradeReason === undefined &&
    capabilityLossReason === undefined
  ) {
    return ;
  }
  return {
    ...(status === "compatible" || status === "downgraded" || status === "incompatible" ? { status } : {}),
    ...(decisionSource === "profile" ||
    decisionSource === "policy" ||
    decisionSource === "operator" ||
    decisionSource === "model" ||
    decisionSource === "runtime"
      ? { decisionSource }
      : {}),
    ...(downgradeReason !== undefined ? { downgradeReason } : {}),
    ...(capabilityLossReason !== undefined ? { capabilityLossReason } : {}),
  };
}

function readWaitForFromSession(state: Record<string, unknown>): NormalizedOutput["waitFor"] | undefined {
  const wait = readActiveWaitState(asRecord(state.agent));
  if (wait === undefined) {
    return ;
  }
  return buildWaitForMatcher({
    kind: toNormalizedOutputWaitKind(wait.kind),
    eventType: wait.eventType,
    metadata: wait.metadata,
  });
}

function readDescribeWaitFor(input: {
  sessionState: Record<string, unknown>;
  focusedThreadStatus: ThreadStatusSnapshot | null;
  fallbackThreadStatus: ThreadStatusSnapshot | null;
  operatorView: OperatorThreadView | null;
}): NormalizedOutput["waitFor"] | undefined {
  const fromSession = readWaitForFromSession(input.sessionState);
  if (fromSession !== undefined) {
    return fromSession;
  }
  const fromFocusedThread = readWaitForFromThread(input.focusedThreadStatus);
  if (fromFocusedThread !== undefined) {
    return fromFocusedThread;
  }
  const fromFallbackThread = readWaitForFromThread(input.fallbackThreadStatus);
  if (fromFallbackThread !== undefined) {
    return fromFallbackThread;
  }
  const fromOperatorView = readWaitForFromOperatorView(input.operatorView);
  if (fromOperatorView !== undefined) {
    return fromOperatorView;
  }
  return ;
}

function readWaitForFromThread(
  status: ThreadStatusSnapshot | null,
): NormalizedOutput["waitFor"] | undefined {
  if (status === null) {
    return ;
  }
  const threadWait = status.thread.waitFor;
  if (threadWait?.kind !== undefined) {
    return buildWaitForMatcher({
      kind: threadWait.kind,
      eventType: threadWait.eventType,
      metadata: threadWait.metadata,
    });
  }
  const approvalRequest = status.openRequests.find((request) => request.kind === "approval");
  if (approvalRequest !== undefined) {
    return buildWaitForMatcher({
      kind: "approval",
      eventType: approvalRequest.eventType,
      metadata: approvalRequest.metadata,
    });
  }
  const userRequest = status.openRequests.find((request) => request.kind === "user_input");
  if (userRequest !== undefined) {
    return buildWaitForMatcher({
      kind: "user",
      eventType: userRequest.eventType,
      metadata: userRequest.metadata,
    });
  }
  if (status.delegations.some((entry) => entry.status === "WAITING")) {
    return buildWaitForMatcher({
      kind: "effect",
      eventType: "delegation",
    });
  }
  return ;
}

function readWaitForFromOperatorView(
  view: OperatorThreadView | null,
): NormalizedOutput["waitFor"] | undefined {
  if (view === null) {
    return ;
  }
  if (view.childBlocker !== undefined) {
    return buildWaitForMatcher({
      kind: "effect",
      eventType: "delegation",
      metadata: {
        delegationId: view.childBlocker.delegationId,
        childThreadId: view.childBlocker.childThreadId,
      },
    });
  }
  const eventType = view.activeWait?.eventType ?? view.activeWait?.sourceEventType;
  if (eventType === undefined) {
    return ;
  }
  return buildWaitForMatcher({
    kind: normalizeWaitKind(view.activeWait?.kind),
    eventType,
    metadata: view.activeWait?.metadata,
  });
}

function describeDominantBlocker(view: OperatorThreadView | null): string | undefined {
  if (view === null) {
    return ;
  }
  if (view.blocker !== undefined) {
    if (view.blocker.kind === "child_thread" && view.blocker.childThreadId !== undefined) {
      return `child:${view.blocker.childThreadId}`;
    }
    return view.blocker.summary;
  }
  if (view.childBlocker !== undefined) {
    return `child:${view.childBlocker.childThreadId} status:${view.childBlocker.status.toLowerCase()}`;
  }
  if (view.activeWait !== undefined) {
    const detail = view.activeWait.detail?.trim();
    if (detail !== undefined && detail.length > 0) {
      return detail;
    }
    const eventType = view.activeWait.eventType ?? view.activeWait.sourceEventType;
    if (eventType !== undefined) {
      return `${view.activeWait.kind}:${eventType}`;
    }
    return view.activeWait.kind;
  }
  return ;
}

function readBlockerChain(view: OperatorThreadView | null): string[] {
  if (view === null) {
    return [];
  }
  if (Array.isArray(view.childBlockerChain) && view.childBlockerChain.length > 0) {
    return view.childBlockerChain.map((entry) => {
      const base = entry.delegationId !== undefined
        ? `delegation:${entry.delegationId} -> child:${entry.threadId}`
        : `child:${entry.threadId}`;
      const status = `status:${entry.status.toLowerCase()}`;
      const wait = entry.waitEventType !== undefined ? `wait:${entry.waitEventType}` : undefined;
      const reason = entry.reason !== undefined ? `reason:${entry.reason}` : undefined;
      const detail = [status, wait, reason].filter((value): value is string => value !== undefined);
      return detail.length > 0 ? `${base} (${detail.join(" ")})` : base;
    });
  }
  const lineage = Array.isArray(view.activeWait?.lineage)
    ? view.activeWait!.lineage.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  if (view.childBlocker === undefined) {
    return lineage;
  }
  const childMarker = `delegation:${view.childBlocker.delegationId} -> child:${view.childBlocker.childThreadId}`;
  return lineage.length > 0 ? [childMarker, ...lineage] : [childMarker];
}

function toChildBlockerChainDetails(view: OperatorThreadView | null): OperatorChildBlockerChainSummary[] {
  if (view === null || Array.isArray(view.childBlockerChain) === false) {
    return [];
  }
  return view.childBlockerChain.map((entry) => ({
    threadId: entry.threadId,
    title: entry.title,
    status: entry.status,
    ...(entry.delegationId !== undefined ? { delegationId: entry.delegationId } : {}),
    ...(entry.waitEventType !== undefined ? { waitEventType: entry.waitEventType } : {}),
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
  }));
}

function toChildThreadSummaries(
  view: OperatorThreadView | null,
  delegations: DelegationRecord[],
): OperatorSupervisedChildSummary[] {
  if (view === null) {
    return [];
  }
  if (Array.isArray(view.childOutcomes) && view.childOutcomes.length > 0) {
    return view.childOutcomes.map((child) => ({
      threadId: child.threadId,
      title: child.title,
      status: mapOutcomeToThreadStatus(child.outcomeState, child.status),
      updatedAt: child.updatedAt,
      outcomeState: child.outcomeState,
      actionable: child.actionable,
      ...(child.waitEventType !== undefined ? { waitEventType: child.waitEventType } : {}),
      ...(child.delegationId !== undefined ? { delegationId: child.delegationId } : {}),
      ...(child.status !== undefined ? { delegationStatus: child.status } : {}),
      ...(child.result !== undefined ? { result: child.result } : {}),
      ...(child.resultSummary !== undefined ? { outcomeSummary: child.resultSummary } : {}),
      ...(child.errorCode !== undefined ? { errorCode: child.errorCode } : {}),
      ...(child.errorMessage !== undefined ? { errorMessage: child.errorMessage } : {}),
      ...(child.references !== undefined ? { references: child.references } : {}),
      ...(child.supersededAt !== undefined ? { superseded: true } : {}),
      ...(child.latestFanInDisposition !== undefined
        ? { latestFanInDisposition: child.latestFanInDisposition }
        : {}),
      ...(child.latestFanInCheckpointId !== undefined
        ? { latestFanInCheckpointId: child.latestFanInCheckpointId }
        : {}),
    }));
  }
  if (Array.isArray(view.childThreads) === false) {
    return [];
  }
  const delegationByChild = new Map(delegations.map((delegation) => [delegation.childThreadId, delegation]));
  return view.childThreads.map((child) => {
    const delegation = delegationByChild.get(child.threadId);
    return {
      threadId: child.threadId,
      title: child.title,
      status: child.status,
      updatedAt: child.updatedAt,
      ...(child.waitFor?.eventType !== undefined ? { waitEventType: child.waitFor.eventType } : {}),
      ...(child.lastRunStatus !== undefined ? { lastRunStatus: child.lastRunStatus } : {}),
      ...(delegation?.delegationId !== undefined ? { delegationId: delegation.delegationId } : {}),
      ...(delegation?.status !== undefined ? { delegationStatus: delegation.status } : {}),
      ...(delegation?.result !== undefined ? { result: delegation.result } : {}),
      ...(delegation?.resultSummary !== undefined ? { outcomeSummary: delegation.resultSummary } : {}),
      ...(delegation?.result?.error?.code !== undefined ? { errorCode: delegation.result.error.code } : {}),
      ...(delegation?.errorMessage !== undefined ? { errorMessage: delegation.errorMessage } : {}),
      ...(delegation?.result?.references !== undefined ? { references: delegation.result.references } : {}),
      ...(delegation?.status === "CANCELLED" ? { superseded: true } : {}),
    };
  });
}

function toFanInDispositionSummary(input: FanInDispositionSummary): OperatorFanInDispositionSummary {
  return {
    status: input.status,
    ...(input.checkpointId !== undefined ? { checkpointId: input.checkpointId } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.selectedDelegationIds !== undefined ? { selectedDelegationIds: input.selectedDelegationIds } : {}),
    ...(input.at !== undefined ? { at: input.at } : {}),
  };
}

function toSupervisionSummary(input: NonNullable<OperatorThreadView["supervision"]>): OperatorSupervisionSummary {
  return {
    groupId: input.groupId,
    status: input.status,
    childCount: input.childCount,
    activeCount: input.activeCount,
    terminalCount: input.terminalCount,
    ...(input.dominantBlockerDelegationId !== undefined
      ? { dominantBlockerDelegationId: input.dominantBlockerDelegationId }
      : {}),
    ...(input.checkpointId !== undefined ? { checkpointId: input.checkpointId } : {}),
    ...(input.nextAction !== undefined ? { nextAction: input.nextAction } : {}),
  };
}

function mapOutcomeToThreadStatus(
  outcomeState: string,
  delegationStatus: "PENDING" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED",
): "IDLE" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" {
  if (outcomeState === "blocked" || delegationStatus === "WAITING") {
    return "WAITING";
  }
  if (outcomeState === "running" || delegationStatus === "RUNNING" || delegationStatus === "PENDING") {
    return "RUNNING";
  }
  if (outcomeState === "completed" || outcomeState === "partial" || outcomeState === "superseded") {
    return "COMPLETED";
  }
  if (outcomeState === "failed" || delegationStatus === "FAILED" || delegationStatus === "CANCELLED") {
    return "FAILED";
  }
  return "IDLE";
}

function readContextPosture(view: OperatorThreadView | null): string | undefined {
  if (view === null) {
    return ;
  }
  if (view.contextPosture !== undefined) {
    return view.contextPosture.summary;
  }
  if (view.latestCheckpoint !== undefined) {
    return `checkpoint:${view.latestCheckpoint.recommendedAction}:${view.latestCheckpoint.status.toLowerCase()}`;
  }
  return view.assemblyBundle?.contextPolicyId;
}

function normalizeWaitKind(kind: ReplayBlockingKind | undefined): "approval" | "user" | "effect" | "region_merge" {
  if (kind === "approval") {
    return "approval";
  }
  if (kind === "user_input") {
    return "user";
  }
  if (kind === "scheduler_wait") {
    return "region_merge";
  }
  return "effect";
}

function buildWaitForMatcher(input: {
  kind: "approval" | "user" | "effect" | "region_merge" | "tool";
  eventType: string;
  metadata?: Record<string, unknown> | undefined;
}): NormalizedOutput["waitFor"] | undefined {
  if (input.kind === "user") {
    const prompt = asString(input.metadata?.prompt);
    if (input.metadata === undefined || prompt === undefined) {
      return ;
    }
    return {
      kind: "user",
      eventType: input.eventType,
      metadata: {
        ...input.metadata,
        prompt,
      },
    };
  }
  return {
    kind: input.kind,
    eventType: input.eventType,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

function toNormalizedOutputWaitKind(kind: RuntimeWaitKind): "approval" | "user" | "effect" | "region_merge" {
  return kind === "tool" ? "effect" : kind;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
