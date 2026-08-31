import type { ApprovalGrantRecord, AssemblyBundleRecord, AssemblyChangeDecisionRecord, AssemblyChangeProposalRecord, ContextCheckpointRecord, ContextPolicyDefinitionRecord, ContextSummaryArtifactRecord, ConversationTurnTerminalEnvelopeV1, DelegationRecord, InteractionRequestRecord, OperatorAttentionRecord, OperatorFocusRecord, SpecialistDefinitionRecord, ThreadAssemblyRecord, ThreadCompactionEventRecord, ThreadRecord } from "../kestrel/contracts/orchestration.js";
import {
  compareThreadAssemblyRecordsNewestFirst,
  orderThreadAssemblyRecordAfter,
  selectLatestThreadAssemblyRecord,
} from "./threadAssemblyOrdering.js";
import { parseHarnessEconomicsPolicyV1 } from "../economics/policy.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";

import type { OrchestrationStore } from "./contracts.js";

export class InMemoryOrchestrationStore implements OrchestrationStore {
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly delegations = new Map<string, DelegationRecord>();
  private readonly requests = new Map<string, InteractionRequestRecord>();
  private readonly grants = new Map<string, ApprovalGrantRecord>();
  private readonly checkpoints = new Map<string, ContextCheckpointRecord>();
  private readonly operatorFocus = new Map<string, OperatorFocusRecord>();
  private readonly operatorAttention = new Map<string, OperatorAttentionRecord>();
  private readonly summaries = new Map<string, ContextSummaryArtifactRecord[]>();
  private readonly compactionEvents = new Map<string, ThreadCompactionEventRecord[]>();
  private readonly bundles = new Map<string, AssemblyBundleRecord>();
  private readonly threadAssemblies = new Map<string, ThreadAssemblyRecord[]>();
  private readonly proposals = new Map<string, AssemblyChangeProposalRecord>();
  private readonly decisions = new Map<string, AssemblyChangeDecisionRecord[]>();
  private readonly specialists = new Map<string, SpecialistDefinitionRecord>();
  private readonly contextPolicies = new Map<string, ContextPolicyDefinitionRecord>();

  async upsertThread(thread: ThreadRecord): Promise<void> {
    this.threads.set(thread.threadId, clone(thread));
  }

  async updateThreadAfterRun(input: {
    thread: ThreadRecord;
    turnId: string;
    runId: string;
  }): Promise<boolean> {
    const current = this.threads.get(input.thread.threadId);
    const executionClaim = asRecord(current?.metadata?.executionClaim);
    if (
      current === undefined ||
      current.metadata?.activeTurnId !== input.turnId ||
      executionClaim?.activeRunId !== input.runId
    ) {
      return false;
    }
    this.threads.set(input.thread.threadId, clone(input.thread));
    return true;
  }

  async getThread(threadId: string): Promise<ThreadRecord | null> {
    return cloneOrNull(this.threads.get(threadId));
  }

  async updateTerminalEnvelope(input: {
    threadId: string;
    turnId: string;
    runId: string;
    envelope: ConversationTurnTerminalEnvelopeV1;
    updatedAt: string;
  }): Promise<boolean> {
    const thread = this.threads.get(input.threadId);
    const currentEnvelope = asRecord(thread?.metadata?.terminalEnvelope);
    if (
      thread === undefined ||
      thread.metadata?.activeTurnId !== input.turnId ||
      currentEnvelope?.runId !== input.runId
    ) {
      return false;
    }
    this.threads.set(input.threadId, clone({
      ...thread,
      metadata: {
        ...(thread.metadata ?? {}),
        terminalEnvelope: input.envelope,
      },
      updatedAt: input.updatedAt,
    }));
    return true;
  }

  async listThreads(input: {
    parentThreadId?: string | undefined;
    sessionId?: string | undefined;
    status?: ThreadRecord["status"] | undefined;
  } = {}): Promise<ThreadRecord[]> {
    return [...this.threads.values()]
      .filter((thread) => input.parentThreadId !== undefined ? thread.parentThreadId === input.parentThreadId : true)
      .filter((thread) => input.sessionId !== undefined ? thread.sessionId === input.sessionId : true)
      .filter((thread) => input.status !== undefined ? thread.status === input.status : true)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((thread) => clone(thread));
  }

  async upsertDelegation(record: DelegationRecord): Promise<void> {
    this.delegations.set(record.delegationId, clone(record));
  }

  async createDialog(record: DelegationRecord): Promise<boolean> {
    const dialog = readStoredDialog(record);
    if (dialog === undefined) {
      throw new Error("createDialog requires a dialog delegation record.");
    }
    const exists = [...this.delegations.values()].some((candidate) => {
      if (candidate.parentThreadId !== record.parentThreadId) return false;
      const existing = readStoredDialog(candidate);
      return existing?.normalizedName === dialog.normalizedName;
    });
    if (exists) return false;
    this.threads.set(record.childThreadId, {
      threadId: record.childThreadId,
      sessionId: record.childThreadId,
      title: `Delegated: ${record.title}`,
      status: "IDLE",
      parentThreadId: record.parentThreadId,
      metadata: { delegationPrompt: record.prompt },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    this.delegations.set(record.delegationId, clone(record));
    return true;
  }

  async compareAndSetDialog(record: DelegationRecord, expectedRevision: number): Promise<boolean> {
    const current = this.delegations.get(record.delegationId);
    const currentDialog = current === undefined ? undefined : readStoredDialog(current);
    if (currentDialog === undefined || currentDialog.revision !== expectedRevision) return false;
    this.delegations.set(record.delegationId, clone(record));
    return true;
  }

  async getDelegation(delegationId: string): Promise<DelegationRecord | null> {
    return cloneOrNull(this.delegations.get(delegationId));
  }

  async getDelegationByChildThreadId(childThreadId: string): Promise<DelegationRecord | null> {
    const found = [...this.delegations.values()].find((record) => record.childThreadId === childThreadId);
    return found === undefined ? null : clone(found);
  }

  async listDelegations(input: {
    parentThreadId?: string | undefined;
    childThreadId?: string | undefined;
    status?: DelegationRecord["status"] | undefined;
  } = {}): Promise<DelegationRecord[]> {
    return [...this.delegations.values()]
      .filter((record) => input.parentThreadId !== undefined ? record.parentThreadId === input.parentThreadId : true)
      .filter((record) => input.childThreadId !== undefined ? record.childThreadId === input.childThreadId : true)
      .filter((record) => input.status !== undefined ? record.status === input.status : true)
      .sort((left, right) => {
        const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
        if (byUpdatedAt !== 0) {
          return byUpdatedAt;
        }
        return right.delegationId.localeCompare(left.delegationId);
      })
      .map((record) => clone(record));
  }

  async upsertInteractionRequest(record: InteractionRequestRecord): Promise<void> {
    this.requests.set(record.requestId, clone(record));
  }

  async getInteractionRequest(requestId: string): Promise<InteractionRequestRecord | null> {
    return cloneOrNull(this.requests.get(requestId));
  }

  async listInteractionRequests(input: {
    threadId?: string | undefined;
    delegationId?: string | undefined;
    status?: InteractionRequestRecord["status"] | undefined;
  } = {}): Promise<InteractionRequestRecord[]> {
    return [...this.requests.values()]
      .filter((record) => input.threadId !== undefined ? record.threadId === input.threadId : true)
      .filter((record) => input.delegationId !== undefined ? record.delegationId === input.delegationId : true)
      .filter((record) => input.status !== undefined ? record.status === input.status : true)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => clone(record));
  }

  async upsertApprovalGrant(record: ApprovalGrantRecord): Promise<void> {
    this.grants.set(record.grantId, clone(record));
  }

  async listApprovalGrants(input: {
    threadId?: string | undefined;
    requestId?: string | undefined;
    status?: ApprovalGrantRecord["status"] | undefined;
  } = {}): Promise<ApprovalGrantRecord[]> {
    return [...this.grants.values()]
      .filter((record) => input.threadId !== undefined ? record.threadId === input.threadId : true)
      .filter((record) => input.requestId !== undefined ? record.requestId === input.requestId : true)
      .filter((record) => input.status !== undefined ? record.status === input.status : true)
      .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt))
      .map((record) => clone(record));
  }

  async upsertContextCheckpoint(record: ContextCheckpointRecord): Promise<void> {
    this.checkpoints.set(record.checkpointId, clone(record));
  }

  async getContextCheckpoint(checkpointId: string): Promise<ContextCheckpointRecord | null> {
    return cloneOrNull(this.checkpoints.get(checkpointId));
  }

  async listContextCheckpoints(input: {
    threadId?: string | undefined;
    status?: ContextCheckpointRecord["status"] | undefined;
  } = {}): Promise<ContextCheckpointRecord[]> {
    return [...this.checkpoints.values()]
      .filter((record) => input.threadId !== undefined ? record.threadId === input.threadId : true)
      .filter((record) => input.status !== undefined ? record.status === input.status : true)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => clone(record));
  }

  async upsertOperatorFocus(record: OperatorFocusRecord): Promise<void> {
    this.operatorFocus.set(record.sessionId, clone(record));
  }

  async getOperatorFocus(sessionId: string): Promise<OperatorFocusRecord | null> {
    return cloneOrNull(this.operatorFocus.get(sessionId));
  }

  async upsertOperatorAttention(record: OperatorAttentionRecord): Promise<void> {
    this.operatorAttention.set(record.attentionId, clone(record));
  }

  async getOperatorAttention(attentionId: string): Promise<OperatorAttentionRecord | null> {
    return cloneOrNull(this.operatorAttention.get(attentionId));
  }

  async listOperatorAttention(input: {
    sessionId?: string | undefined;
    threadId?: string | undefined;
    kind?: OperatorAttentionRecord["kind"] | undefined;
    status?: OperatorAttentionRecord["status"] | undefined;
  } = {}): Promise<OperatorAttentionRecord[]> {
    return [...this.operatorAttention.values()]
      .filter((record) => input.sessionId !== undefined ? record.sessionId === input.sessionId : true)
      .filter((record) => input.threadId !== undefined ? record.threadId === input.threadId : true)
      .filter((record) => input.kind !== undefined ? record.kind === input.kind : true)
      .filter((record) => input.status !== undefined ? record.status === input.status : true)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => clone(record));
  }

  async saveContextSummaryArtifact(record: ContextSummaryArtifactRecord): Promise<void> {
    const existing = this.summaries.get(record.threadId) ?? [];
    this.summaries.set(record.threadId, [...existing, clone(record)]);
  }

  async listContextSummaryArtifacts(threadId: string): Promise<ContextSummaryArtifactRecord[]> {
    return (this.summaries.get(threadId) ?? [])
      .map((record) => clone(record))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async appendThreadCompactionEvent(record: ThreadCompactionEventRecord): Promise<void> {
    const existing = this.compactionEvents.get(record.threadId) ?? [];
    this.compactionEvents.set(record.threadId, [...existing, clone(record)]);
  }

  async listThreadCompactionEvents(threadId: string): Promise<ThreadCompactionEventRecord[]> {
    return (this.compactionEvents.get(threadId) ?? [])
      .map((record) => clone(record))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async upsertAssemblyBundle(record: AssemblyBundleRecord): Promise<void> {
    this.bundles.set(record.bundleId, clone(record));
  }

  async getAssemblyBundle(bundleId: string): Promise<AssemblyBundleRecord | null> {
    return cloneOrNull(this.bundles.get(bundleId));
  }

  async listAssemblyBundles(input: {
    source?: AssemblyBundleRecord["source"] | undefined;
  } = {}): Promise<AssemblyBundleRecord[]> {
    return [...this.bundles.values()]
      .filter((record) => input.source !== undefined ? record.source === input.source : true)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => clone(record));
  }

  async appendThreadAssemblyRecord(record: ThreadAssemblyRecord): Promise<ThreadAssemblyRecord> {
    const existing = this.threadAssemblies.get(record.threadId) ?? [];
    const persisted = orderThreadAssemblyRecordAfter(
      record,
      selectLatestThreadAssemblyRecord(existing),
    );
    this.threadAssemblies.set(record.threadId, [...existing, clone(persisted)]);
    return clone(persisted);
  }

  async listThreadAssemblyRecords(threadId: string): Promise<ThreadAssemblyRecord[]> {
    return (this.threadAssemblies.get(threadId) ?? [])
      .map((record) => clone(record))
      .sort(compareThreadAssemblyRecordsNewestFirst);
  }

  async upsertAssemblyChangeProposal(record: AssemblyChangeProposalRecord): Promise<void> {
    this.proposals.set(record.proposalId, clone(record));
  }

  async getAssemblyChangeProposal(proposalId: string): Promise<AssemblyChangeProposalRecord | null> {
    return cloneOrNull(this.proposals.get(proposalId));
  }

  async listAssemblyChangeProposals(input: {
    threadId?: string | undefined;
    status?: AssemblyChangeProposalRecord["status"] | undefined;
  } = {}): Promise<AssemblyChangeProposalRecord[]> {
    return [...this.proposals.values()]
      .filter((record) => input.threadId !== undefined ? record.threadId === input.threadId : true)
      .filter((record) => input.status !== undefined ? record.status === input.status : true)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => clone(record));
  }

  async appendAssemblyChangeDecision(record: AssemblyChangeDecisionRecord): Promise<void> {
    const existing = this.decisions.get(record.threadId) ?? [];
    this.decisions.set(record.threadId, [...existing, clone(record)]);
  }

  async listAssemblyChangeDecisions(input: {
    threadId?: string | undefined;
    proposalId?: string | undefined;
  } = {}): Promise<AssemblyChangeDecisionRecord[]> {
    const scoped = input.threadId !== undefined
      ? (this.decisions.get(input.threadId) ?? [])
      : [...this.decisions.values()].flatMap((records) => records);
    return scoped
      .filter((record) => input.proposalId !== undefined ? record.proposalId === input.proposalId : true)
      .map((record) => clone(record))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async upsertSpecialistDefinition(record: SpecialistDefinitionRecord): Promise<void> {
    this.specialists.set(record.specialistId, clone(record));
  }

  async listSpecialistDefinitions(): Promise<SpecialistDefinitionRecord[]> {
    return [...this.specialists.values()]
      .map((record) => clone(record))
      .sort((left, right) => left.specialistId.localeCompare(right.specialistId));
  }

  async upsertContextPolicyDefinition(record: ContextPolicyDefinitionRecord): Promise<void> {
    const economicsPolicy = record.economicsPolicy === undefined
      ? undefined
      : parseHarnessEconomicsPolicyV1(record.economicsPolicy);
    const existing = this.contextPolicies.get(record.contextPolicyId);
    if (
      economicsPolicy !== undefined &&
      existing?.economicsPolicy !== undefined &&
      JSON.stringify(existing.economicsPolicy) !== JSON.stringify(economicsPolicy)
    ) {
      throw createRuntimeFailure(
        "HARNESS_ECONOMICS_POLICY_IMMUTABLE",
        `Context policy '${record.contextPolicyId}' already has a different economics policy. Create a new policy id instead.`,
        { contextPolicyId: record.contextPolicyId },
      );
    }
    this.contextPolicies.set(record.contextPolicyId, clone({
      ...record,
      ...(economicsPolicy !== undefined
        ? { economicsPolicy }
        : existing?.economicsPolicy !== undefined
          ? { economicsPolicy: existing.economicsPolicy }
          : {}),
    }));
  }

  async listContextPolicyDefinitions(): Promise<ContextPolicyDefinitionRecord[]> {
    return [...this.contextPolicies.values()]
      .map((record) => clone(record))
      .sort((left, right) => left.contextPolicyId.localeCompare(right.contextPolicyId));
  }

  async getContextPolicyDefinition(contextPolicyId: string): Promise<ContextPolicyDefinitionRecord | null> {
    return cloneOrNull(this.contextPolicies.get(contextPolicyId));
  }
}

function readStoredDialog(record: DelegationRecord): { normalizedName: string; revision: number } | undefined {
  const dialog = record.policy?.dialog;
  if (typeof dialog !== "object" || dialog === null || Array.isArray(dialog)) return undefined;
  const value = dialog as Record<string, unknown>;
  if (value.version !== "v1" || typeof value.name !== "string") return undefined;
  return {
    normalizedName: typeof value.normalizedName === "string"
      ? value.normalizedName
      : value.name.trim().toLocaleLowerCase(),
    revision: typeof value.revision === "number" && Number.isInteger(value.revision) && value.revision >= 0
      ? value.revision
      : 0,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : clone(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
