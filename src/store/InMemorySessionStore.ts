import type { EffectExecutionStatus, RuntimeError, TransitionStatus } from "../kestrel/contracts/base.js";
import { parseRunnerPreparedApprovalCleanupV1 } from "@kestrel-agents/protocol";
import type { RunEvent, RunLogEntry, RuntimeEvent } from "../kestrel/contracts/events.js";
import type { EffectResult, RegionWorkIntent, RegionWorkItem } from "../kestrel/contracts/execution.js";
import { canonicalJson } from "../kestrel/contracts/tool-contract.js";
import type {
  ConversationTurnRecord,
  ConversationTurnSegmentRecord,
  ConversationTurnTerminalEnvelopeV1,
} from "../kestrel/contracts/orchestration.js";
import {
  SandboxCapabilityExactResultCancelledError,
  SandboxCapabilityExactResultConflictError,
  exactEffectRequiresCapabilityTenantBinding,
  validateExactEffectCancellationCandidate,
  validateExactEffectCancellationTenantBinding,
  validateExactEffectResultRead,
  validateExactEffectResultTenantBinding,
  quarantinePreparedApprovalCleanupDoneResult,
  snapshotEffectResultPersistenceIntent,
  validatePreparedApprovalCleanupEffectIdentity,
  validatePreparedApprovalCleanupDoneEvidence,
} from "../kestrel/contracts/store.js";
import type {
  ClaimConversationTurnExecutionInput,
  ClaimConversationTurnExecutionResult,
  CommitStepInput,
  CommitStepResult,
  EffectResultPersistenceIntent,
  LegacySessionArchive,
  OutboxEventRecord,
  PersistedArtifact,
  PersistedClaim,
  PersistedEffect,
  PersistedRunRecord,
  PersistedRunStateRecord,
  PersistedRunSummaryRecord,
  RunLifecycleSettlement,
  SessionProductStateRecord,
  SessionRecord,
  SessionStore,
  UpdateConversationTurnTerminalEnvelopeInput,
} from "../kestrel/contracts/store.js";
import {
  assertSandboxCapabilityLeaseTransitionV1,
  fingerprintSandboxCapabilityLeaseBinding,
  parseSandboxCapabilityChildReservationV1,
  parseSandboxCapabilityLeaseTransitionRecordV1,
  type SandboxCapabilityChildReservationV1,
  type SandboxCapabilityLeaseTransitionRecordV1,
} from "../kestrel/contracts/sandbox-capability.js";

import {
  normalizeRuntimeStateForPersist,
  validateRuntimeSessionState,
} from "../runtime/state.js";
import { SessionBusyError, createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import {
  buildPreparedApprovalCleanupDoneEvidenceQuarantineEvent,
  buildPreparedApprovalCleanupDoneEvidenceQuarantineEventFromSnapshot,
  snapshotPreparedApprovalCleanupResult,
} from "../runtime/preparedApprovalCleanupAudit.js";
import {
  buildCanonicalWaitingFor,
  readActiveWaitState,
} from "../runtime/waitState.js";
import { InMemoryOrchestrationStore } from "../orchestration/InMemoryOrchestrationStore.js";
import type { ProductProjectSnapshot } from "../project/contracts.js";
import type {
  MissionControlLegacyProjectSource,
  MissionControlMigrationSourceBinding,
} from "../missionControl/migrationContracts.js";
import { requireMissionControlMigrationFingerprint } from "../missionControl/migrationContracts.js";
import { parseMissionControlLegacyProjectSnapshot } from "../missionControl/legacyContracts.js";
import {
  normalizeProjectSnapshot,
  readProjectSnapshotFromRuntimeState,
} from "../project/state.js";
import {
  MISSION_CONTROL_PROJECT_SCHEMA_VERSION,
  MISSION_CONTROL_AUTHORITY_EPOCH,
  assertMissionControlExpectedRevision,
  assertMissionControlReceiptFingerprint,
  createEmptyMissionControlProjectDocument,
  parseMissionControlProjectDocument,
  requireMissionControlActionId,
  requireMissionControlExpectedRevision,
  requireMissionControlProjectId,
  requireMissionControlRequestFingerprint,
  type MissionControlOutboxRecord,
  type MissionControlPersistedMutationResult,
  type MissionControlProjectMutationInput,
  type MissionControlProjectMutationResult,
  type MissionControlProjectStateRecord,
} from "../missionControl/projectAuthority.js";

interface InMemorySession {
  sessionId: string;
  version: number;
  state: Record<string, unknown>;
  currentStepAgent: string | undefined;
  activeRunId: string | undefined;
  updatedAt: string;
}

interface InMemorySessionVersion {
  sessionId: string;
  version: number;
  runId: string;
  state: Record<string, unknown>;
  statePatch: Record<string, unknown>;
  snapshotKind: "full" | "delta";
}

interface InMemoryProductState {
  sessionId: string;
  version: number;
  projectSnapshot: ProductProjectSnapshot;
  taskGraph: Record<string, unknown>;
  workspaceCheckpointState: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface InMemoryMissionControlReceipt {
  requestFingerprint: string;
  result: MissionControlPersistedMutationResult;
}

interface InMemoryRun {
  runId: string;
  sessionId: string;
  status: TransitionStatus;
  eventType: string;
  startedAt: string;
  completedAt: string | undefined;
  error: RuntimeError | undefined;
  tenantId?: string | undefined;
  tenantOwnershipState: "legacy_unknown" | "explicit_unbound" | "tenant_bound";
}

interface InMemoryEffect {
  runId: string;
  sessionId: string;
  stepIndex: number;
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  failurePolicy: "STOP" | "CONTINUE" | "WAIT";
  status: EffectExecutionStatus;
  createdAt: string;
  tenantId?: string | undefined;
  tenantOwnershipState: "legacy_unknown" | "explicit_unbound" | "tenant_bound";
}

interface InMemoryRegionWorkItem extends RegionWorkItem {
  error?: Record<string, unknown> | undefined;
}

export class InMemorySessionStore implements SessionStore {
  private readonly tenantId: string | undefined;
  private readonly orchestrationStore = new InMemoryOrchestrationStore();
  private readonly sessions = new Map<string, InMemorySession>();
  private readonly productStates = new Map<string, InMemoryProductState>();
  private readonly missionControlProjects = new Map<
    string,
    MissionControlProjectStateRecord
  >();
  private readonly missionControlReceipts = new Map<
    string,
    Map<string, InMemoryMissionControlReceipt>
  >();
  private readonly missionControlOutbox: MissionControlOutboxRecord[] = [];
  private readonly missionControlMigrationBindings = new Map<
    string,
    MissionControlMigrationSourceBinding
  >();
  private readonly runs = new Map<string, InMemoryRun>();
  private readonly effects: InMemoryEffect[] = [];
  private readonly effectResults = new Map<string, EffectResult>();
  private readonly preparedApprovalCleanupExecutionLocks = new Map<
    string,
    Promise<void>
  >();
  private readonly outboxEvents: OutboxEventRecord[] = [];
  private readonly runLogs: RunLogEntry[] = [];
  private readonly runEvents: RunEvent[] = [];
  private readonly sandboxCapabilityLeaseTransitions = new Map<string, SandboxCapabilityLeaseTransitionRecordV1[]>();
  private readonly sandboxCapabilityChildReservations = new Map<string, SandboxCapabilityChildReservationV1[]>();
  private readonly artifacts: PersistedArtifact[] = [];
  private readonly claims: PersistedClaim[] = [];
  private readonly regionWorkItems: InMemoryRegionWorkItem[] = [];

  constructor(options: { tenantId?: string | undefined } = {}) {
    this.tenantId = options.tenantId?.trim() || undefined;
  }
  private readonly conversationTurns = new Map<string, ConversationTurnRecord>();
  private readonly conversationTurnSegments = new Map<string, ConversationTurnSegmentRecord>();
  private readonly legacyArchives: LegacySessionArchive[] = [];
  private readonly sessionVersions: InMemorySessionVersion[] = [];
  private missionControlOutboxIdCounter = 1;
  private outboxIdCounter = 1;
  private regionWorkItemIdCounter = 1;

  readonly operationLog: string[] = [];

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return null;
    }

    return {
      sessionId: session.sessionId,
      version: session.version,
      state: normalizeRuntimeStateForPersist({ ...session.state }),
      currentStepAgent: session.currentStepAgent,
      updatedAt: session.updatedAt,
    };
  }

  async getMissionControlProjectState(
    projectIdValue: string,
  ): Promise<MissionControlProjectStateRecord | null> {
    const projectId = requireMissionControlProjectId(projectIdValue);
    const project = this.missionControlProjects.get(projectId);
    return project === undefined ? null : structuredClone(project);
  }

  async listMissionControlLegacySources(): Promise<
    MissionControlLegacyProjectSource[]
  > {
    const sessionIds = new Set([
      ...this.sessions.keys(),
      ...this.productStates.keys(),
    ]);
    const sources: MissionControlLegacyProjectSource[] = [];
    for (const sessionId of [...sessionIds].sort()) {
      const productState = this.productStates.get(sessionId);
      const session = this.sessions.get(sessionId);
      const product =
        session !== undefined &&
        typeof session.state.product === "object" &&
        session.state.product !== null &&
        Array.isArray(session.state.product) === false
          ? (session.state.product as Record<string, unknown>)
          : undefined;
      if (productState === undefined && product?.projectSnapshot === undefined) {
        continue;
      }
      const snapshot =
        productState === undefined
          ? parseMissionControlLegacyProjectSnapshot(
              (session?.state.product as Record<string, unknown> | undefined)
                ?.projectSnapshot,
            )
          : parseMissionControlLegacyProjectSnapshot(productState.projectSnapshot);
      const projectPath = snapshot.setup.workspaceRoot.trim();
      sources.push({
        sourceId: `session:${sessionId}`,
        kind: "session_snapshot",
        sessionId,
        sourceVersion: productState?.version ?? session?.version ?? 0,
        ...(projectPath.length === 0 ? {} : { projectPath }),
        snapshot,
      });
    }
    return structuredClone(sources);
  }

  async listMissionControlMigrationSourceBindings(): Promise<
    MissionControlMigrationSourceBinding[]
  > {
    return structuredClone(
      [...this.missionControlMigrationBindings.values()].sort((left, right) =>
        left.sourceId.localeCompare(right.sourceId)
      ),
    );
  }

  async updateMissionControlProjectState(
    input: MissionControlProjectMutationInput,
  ): Promise<MissionControlProjectMutationResult> {
    const projectId = requireMissionControlProjectId(input.projectId);
    const actionId = requireMissionControlActionId(input.actionId);
    const requestFingerprint = requireMissionControlRequestFingerprint(
      input.requestFingerprint,
    );
    const expectedRevision = requireMissionControlExpectedRevision(
      input.expectedRevision,
    );
    const receipts = this.missionControlReceipts.get(projectId);
    const prior = receipts?.get(actionId);
    if (prior !== undefined) {
      assertMissionControlReceiptFingerprint(
        actionId,
        prior.requestFingerprint,
        requestFingerprint,
      );
      return {
        ...structuredClone(prior.result),
        duplicate: true,
      };
    }

    const timestamp = new Date().toISOString();
    const current = this.missionControlProjects.get(projectId) ?? {
      projectId,
      schemaVersion: MISSION_CONTROL_PROJECT_SCHEMA_VERSION,
      revision: 0,
      authorityEpoch: MISSION_CONTROL_AUTHORITY_EPOCH,
      document: createEmptyMissionControlProjectDocument(projectId),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    assertMissionControlExpectedRevision(
      current.revision,
      expectedRevision,
    );

    const transition = input.apply(structuredClone(current.document));
    const document = parseMissionControlProjectDocument(
      transition.document,
      projectId,
    );
    const project: MissionControlProjectStateRecord = {
      ...current,
      revision: current.revision + 1,
      authorityEpoch: current.authorityEpoch,
      document,
      updatedAt: timestamp,
    };
    const effects = transition.effects.map((effect) => {
      if (
        effect.effectId.trim().length === 0 ||
        effect.effectType.trim().length === 0
      ) {
        throw new Error(
          "Mission Control outbox effectId and effectType are required.",
        );
      }
      return {
        ...structuredClone(effect),
        id: this.missionControlOutboxIdCounter++,
        projectId,
        actionId,
        status: "PENDING" as const,
        attemptCount: 0,
        createdAt: timestamp,
      };
    });
    const result: MissionControlPersistedMutationResult = {
      project,
      effects,
    };

    this.missionControlProjects.set(projectId, structuredClone(project));
    const nextReceipts = receipts ?? new Map<string, InMemoryMissionControlReceipt>();
    nextReceipts.set(actionId, {
      requestFingerprint,
      result: structuredClone(result),
    });
    this.missionControlReceipts.set(projectId, nextReceipts);
    this.missionControlOutbox.push(...structuredClone(effects));
    return {
      ...structuredClone(result),
      duplicate: false,
    };
  }

  async listMissionControlOutbox(
    projectIdValue: string,
  ): Promise<MissionControlOutboxRecord[]> {
    const projectId = requireMissionControlProjectId(projectIdValue);
    return structuredClone(
      this.missionControlOutbox
        .filter((entry) => entry.projectId === projectId)
        .sort((left, right) => left.id - right.id),
    );
  }

  async markMissionControlOutboxDelivered(
    projectIdValue: string,
    effectIdValue: string,
  ): Promise<void> {
    const projectId = requireMissionControlProjectId(projectIdValue);
    const effectId = requireMissionControlActionId(effectIdValue);
    const effect = this.missionControlOutbox.find(
      (entry) => entry.projectId === projectId && entry.effectId === effectId,
    );
    if (effect === undefined) {
      throw new Error(`Mission Control outbox effect not found: ${effectId}.`);
    }
    effect.status = "DELIVERED";
    effect.lastError = undefined;
  }

  async recordMissionControlOutboxFailure(
    projectIdValue: string,
    effectIdValue: string,
    errorValue: string,
  ): Promise<void> {
    const projectId = requireMissionControlProjectId(projectIdValue);
    const effectId = requireMissionControlActionId(effectIdValue);
    const error = errorValue.trim();
    if (error.length === 0) {
      throw new Error("Mission Control outbox failure must not be empty.");
    }
    const effect = this.missionControlOutbox.find(
      (entry) => entry.projectId === projectId && entry.effectId === effectId,
    );
    if (effect === undefined) {
      throw new Error(`Mission Control outbox effect not found: ${effectId}.`);
    }
    effect.status = "PENDING";
    effect.attemptCount += 1;
    effect.lastError = error;
  }

  async getSessionProductState(sessionId: string): Promise<SessionProductStateRecord | null> {
    const state = this.productStates.get(sessionId);
    return state === undefined ? null : this.mapProductState(state);
  }

  async updateSessionProjectSnapshot(input: {
    sessionId: string;
    graphVersion?: ProductProjectSnapshot["graphVersion"] | undefined;
    reason?: string | undefined;
    apply: (snapshot: ProductProjectSnapshot) => ProductProjectSnapshot | Promise<ProductProjectSnapshot>;
  }): Promise<SessionProductStateRecord> {
    const session = await this.ensureSession(input.sessionId);
    const current = this.productStates.get(input.sessionId);
    const graphVersion = input.graphVersion ?? 1;
    const baseSnapshot = current === undefined
      ? readProjectSnapshotFromRuntimeState(session.state, graphVersion)
      : normalizeProjectSnapshot(current.projectSnapshot, graphVersion);
    const applied = await input.apply(baseSnapshot);
    return this.persistProductSnapshot(
      session,
      normalizeProjectSnapshot(applied, input.graphVersion ?? applied.graphVersion),
      current,
    );
  }

  async saveSessionProjectSnapshot(input: {
    sessionId: string;
    snapshot: ProductProjectSnapshot;
  }): Promise<SessionProductStateRecord> {
    const session = await this.ensureSession(input.sessionId);
    const current = this.productStates.get(input.sessionId);
    return this.persistProductSnapshot(
      session,
      normalizeProjectSnapshot(input.snapshot, input.snapshot.graphVersion),
      current,
    );
  }

  async getRun(runId: string): Promise<PersistedRunRecord | null> {
    const run = this.runs.get(runId);
    return run === undefined ? null : this.mapRun(run);
  }

  async getRunState(runId: string): Promise<PersistedRunStateRecord | null> {
    const versions = this.sessionVersions
      .filter((entry) => entry.runId === runId)
      .sort((left, right) => left.version - right.version);
    const target = versions[versions.length - 1];
    if (target === undefined) {
      return null;
    }
    const allVersions = this.sessionVersions
      .filter((entry) => entry.sessionId === target.sessionId && entry.version <= target.version)
      .sort((left, right) => left.version - right.version);
    const baseIndex = [...allVersions]
      .reverse()
      .findIndex((entry) => entry.snapshotKind === "full");
    if (baseIndex === -1) {
      return null;
    }
    const base = allVersions[allVersions.length - 1 - baseIndex]!;
    let state = normalizeRuntimeStateForPersist({ ...base.state });
    let deltaCount = 0;
    for (const version of allVersions) {
      if (version.version <= base.version) {
        continue;
      }
      state = normalizeRuntimeStateForPersist({
        ...state,
        ...(version.snapshotKind === "full" ? version.state : version.statePatch),
      });
      deltaCount += version.snapshotKind === "delta" ? 1 : 0;
    }
    return {
      runId,
      sessionId: target.sessionId,
      version: target.version,
      baseVersion: base.version,
      state,
      deltaCount,
    };
  }

  async listRuns(input?: {
    sessionId?: string | undefined;
    status?: TransitionStatus | "RUNNING" | undefined;
    limit?: number | undefined;
  }): Promise<PersistedRunRecord[]> {
    const filtered = [...this.runs.values()]
      .filter((run) => (input?.sessionId !== undefined ? run.sessionId === input.sessionId : true))
      .filter((run) => (input?.status !== undefined ? run.status === input.status : true))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const limited =
      typeof input?.limit === "number" && Number.isFinite(input.limit)
        ? filtered.slice(0, Math.max(0, input.limit))
        : filtered;
    return limited.map((run) => this.mapRun(run));
  }

  async listRunSummaries(input?: {
    sessionId?: string | undefined;
    status?: TransitionStatus | "RUNNING" | undefined;
    limit?: number | undefined;
  }): Promise<PersistedRunSummaryRecord[]> {
    const runs = await this.listRuns(input);
    return runs.map((run) => {
      const events = this.runEvents.filter((event) => event.runId === run.runId);
      const threadId = [...events]
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .map((event) => asRecord(event.metadata)?.threadId)
        .find((value): value is string => typeof value === "string" && value.length > 0);
      const missionControl = events
        .filter((event) => event.type === "run.started")
        .map((event) => readMissionControlRunCorrelation(
          asRecord(event.metadata)?.missionControl,
        ))
        .find((value) => value !== undefined);
      return {
        run,
        eventCount: events.length,
        ...(threadId !== undefined ? { threadId } : {}),
        ...(missionControl !== undefined ? { missionControl } : {}),
      };
    });
  }

  async ensureSession(sessionId: string, initialStepAgent?: string): Promise<SessionRecord> {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      if (existing.currentStepAgent === undefined && initialStepAgent !== undefined) {
        existing.currentStepAgent = initialStepAgent;
        existing.updatedAt = new Date().toISOString();
      }
      return this.getSession(sessionId) as Promise<SessionRecord>;
    }

    const now = new Date().toISOString();
    const session: InMemorySession = {
      sessionId,
      version: 0,
      state: normalizeRuntimeStateForPersist({}),
      currentStepAgent: initialStepAgent,
      activeRunId: undefined,
      updatedAt: now,
    };
    this.sessions.set(sessionId, session);
    this.sessionVersions.push({
      sessionId,
      version: 0,
      runId: "bootstrap",
      state: normalizeRuntimeStateForPersist({}),
      statePatch: {},
      snapshotKind: "full",
    });
    this.operationLog.push(`ensureSession:${sessionId}`);

    return {
      sessionId,
      version: 0,
      state: normalizeRuntimeStateForPersist({}),
      currentStepAgent: initialStepAgent,
      updatedAt: now,
    };
  }

  async patchSessionState(input: {
    sessionId: string;
    statePatch: Record<string, unknown>;
    expectedVersion?: number | undefined;
    nextStepAgent?: string | undefined;
    reason?: string | undefined;
  }): Promise<SessionRecord> {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      throw createRuntimeFailure("STORE_SESSION_NOT_FOUND", `Unknown session ${input.sessionId}.`, {
        sessionId: input.sessionId,
      });
    }
    if (input.expectedVersion !== undefined && session.version !== input.expectedVersion) {
      throw createRuntimeFailure(
        "SESSION_VERSION_CONFLICT",
        `Version conflict expected=${input.expectedVersion} actual=${session.version}.`,
        {
          sessionId: input.sessionId,
          expectedVersion: input.expectedVersion,
          actualVersion: session.version,
        },
      );
    }

    const nextState = normalizeRuntimeStateForPersist({
      ...session.state,
      ...input.statePatch,
    });
    const validationError = validateRuntimeSessionState(nextState);
    if (validationError !== undefined) {
      throw createRuntimeFailure(validationError.code, validationError.message, {
        sessionId: input.sessionId,
      });
    }

    session.version += 1;
    session.state = nextState;
    if (input.nextStepAgent !== undefined) {
      session.currentStepAgent = input.nextStepAgent;
    }
    session.updatedAt = new Date().toISOString();
    const shouldPersistFullSnapshot = session.version % 20 === 0 || session.version <= 1;
    this.sessionVersions.push({
      sessionId: input.sessionId,
      version: session.version,
      runId: `system:${input.reason ?? "session_patch"}`,
      state: shouldPersistFullSnapshot ? normalizeRuntimeStateForPersist({ ...session.state }) : {},
      statePatch: shouldPersistFullSnapshot ? {} : normalizeRuntimeStateForPersist({ ...input.statePatch }),
      snapshotKind: shouldPersistFullSnapshot ? "full" : "delta",
    });

    return {
      sessionId: session.sessionId,
      version: session.version,
      state: normalizeRuntimeStateForPersist({ ...session.state }),
      ...(session.currentStepAgent !== undefined ? { currentStepAgent: session.currentStepAgent } : {}),
      updatedAt: session.updatedAt,
    };
  }

  async acquireRunLease(runId: string, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw createRuntimeFailure("STORE_SESSION_NOT_FOUND", `Unknown session ${sessionId}.`, {
        sessionId,
      });
    }
    if (session.activeRunId !== undefined && session.activeRunId !== runId) {
      throw new SessionBusyError(sessionId, session.activeRunId);
    }
    session.activeRunId = runId;
    session.updatedAt = new Date().toISOString();
    this.operationLog.push(`leaseAcquired:${sessionId}:${runId}`);
  }

  async releaseRunLease(runId: string, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return;
    }
    if (session.activeRunId === runId) {
      session.activeRunId = undefined;
      session.updatedAt = new Date().toISOString();
      this.operationLog.push(`leaseReleased:${sessionId}:${runId}`);
    }
  }

  async recoverOrphanedActiveRun(
    sessionId: string,
  ): Promise<{ runId?: string | undefined }> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.activeRunId === undefined) {
      return {};
    }
    const runId = session.activeRunId;
    const error: RuntimeError = {
      code: "RUNNER_ORPHANED_ACTIVE_RUN",
      message: "The process-owned runner no longer has a live execution for this persisted run.",
      details: { sessionId, runId },
    };
    const now = new Date().toISOString();
    const run = this.runs.get(runId);
    if (run !== undefined) {
      run.status = "FAILED";
      run.completedAt = now;
      run.error = error;
    }
    const turn = [...this.conversationTurns.values()].find(
      (record) => record.activeRunId === runId,
    );
    if (turn !== undefined) {
      const claim = asRecord(turn.metadata?.executionClaim);
      const terminalEnvelope: ConversationTurnTerminalEnvelopeV1 = {
        version: "v1",
        turnRequestIdentity:
          asString(claim?.turnRequestIdentity) ?? `recovered:${turn.turnId}`,
        terminalSubmissionIdentity:
          asString(claim?.submissionIdentity) ?? `recovered:${runId}`,
        runId,
        status: "FAILED",
        handoff: { state: "failed", finalizationError: error },
      };
      this.conversationTurns.set(turn.turnId, {
        ...turn,
        status: "FAILED",
        activeRunId: undefined,
        terminalRunId: runId,
        terminalStatus: "FAILED",
        completedAt: now,
        updatedAt: now,
        metadata: {
          ...(turn.metadata ?? {}),
          terminalEnvelope,
        },
      });
      const thread = await this.orchestrationStore.getThread(turn.threadId);
      if (thread?.activeRunId === runId) {
        await this.orchestrationStore.upsertThread({
          ...thread,
          status: "FAILED",
          activeRunId: undefined,
          currentRequestId: undefined,
          waitFor: undefined,
          lastRunStatus: "FAILED",
          metadata: {
            ...(thread.metadata ?? {}),
            terminalEnvelope,
          },
          updatedAt: now,
        });
      }
    }
    await this.releaseRunLease(runId, sessionId);
    this.operationLog.push(`recoverOrphanedActiveRun:${sessionId}:${runId}`);
    return { runId };
  }

  async cancelActiveRun(sessionId: string, error?: RuntimeError): Promise<{ runId?: string | undefined }> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.activeRunId === undefined) {
      return {};
    }
    const runId = session.activeRunId;
    const run = this.runs.get(runId);
    if (run !== undefined) {
      run.status = "FAILED";
      run.completedAt = new Date().toISOString();
      run.error = error;
    }
    await this.releaseRunLease(runId, sessionId);
    this.operationLog.push(`cancelActiveRun:${sessionId}:${runId}`);
    return { runId };
  }

  async startRun(runId: string, event: RuntimeEvent): Promise<void> {
    await this.acquireRunLease(runId, event.sessionId);
    this.runs.set(runId, {
      runId,
      sessionId: event.sessionId,
      eventType: event.type,
      status: "RUNNING",
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      error: undefined,
      ...(this.tenantId === undefined ? {} : { tenantId: this.tenantId }),
      tenantOwnershipState: this.tenantId === undefined ? "explicit_unbound" : "tenant_bound",
    });
    this.operationLog.push(`startRun:${runId}`);
  }

  async validatePrestartedRun(runId: string, event: RuntimeEvent): Promise<void> {
    const run = this.runs.get(runId);
    const session = this.sessions.get(event.sessionId);
    if (
      run === undefined ||
      run.sessionId !== event.sessionId ||
      run.status !== "RUNNING" ||
      session?.activeRunId !== runId
    ) {
      throw createRuntimeFailure(
        "PRESTARTED_RUN_INVALID",
        `Run '${runId}' is not the active prestarted run for session '${event.sessionId}'.`,
        { runId, sessionId: event.sessionId },
      );
    }
    const effects = this.effects.filter((effect) => effect.runId === runId);
    if (
      run.tenantOwnershipState === "legacy_unknown" ||
      (run.tenantOwnershipState === "tenant_bound"
        ? this.tenantId === undefined || run.tenantId !== this.tenantId
        : this.tenantId !== undefined || run.tenantId !== undefined) ||
      effects.some((effect) =>
        effect.tenantOwnershipState !== run.tenantOwnershipState || effect.tenantId !== run.tenantId)
    ) {
      throw createRuntimeFailure(
        "PRESTARTED_RUN_INVALID",
        `Run '${runId}' is not bound to the trusted store tenant.`,
        { runId, sessionId: event.sessionId },
      );
    }
    this.operationLog.push(`validatePrestartedRun:${runId}`);
  }

  async commitStep(input: CommitStepInput): Promise<CommitStepResult> {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      throw createRuntimeFailure("STORE_SESSION_NOT_FOUND", `Unknown session ${input.sessionId}.`, {
        sessionId: input.sessionId,
        runId: input.runId,
      });
    }

    if (session.version !== input.expectedVersion) {
      throw createRuntimeFailure(
        "SESSION_VERSION_CONFLICT",
        `Version conflict expected=${input.expectedVersion} actual=${session.version}.`,
        {
          sessionId: input.sessionId,
          runId: input.runId,
          expectedVersion: input.expectedVersion,
          actualVersion: session.version,
        },
      );
    }

    const nextState = normalizeRuntimeStateForPersist({
      ...session.state,
      ...(input.statePatch ?? {}),
    });
    const validationError = validateRuntimeSessionState(nextState);
    if (validationError !== undefined) {
      throw createRuntimeFailure(validationError.code, validationError.message, {
        sessionId: input.sessionId,
        runId: input.runId,
      });
    }

    session.version += 1;
    session.state = nextState;
    session.currentStepAgent = input.nextStepAgent;
    session.updatedAt = new Date().toISOString();
    const shouldPersistFullSnapshot = session.version % 20 === 0 || session.version <= 1;
    this.sessionVersions.push({
      sessionId: input.sessionId,
      version: session.version,
      runId: input.runId,
      state: shouldPersistFullSnapshot ? normalizeRuntimeStateForPersist({ ...session.state }) : {},
      statePatch: shouldPersistFullSnapshot ? {} : normalizeRuntimeStateForPersist({ ...(input.statePatch ?? {}) }),
      snapshotKind: shouldPersistFullSnapshot ? "full" : "delta",
    });

    const persistedEffects: InMemoryEffect[] = [];
    for (const effect of input.effects) {
      const alreadyExists = this.effects.some(
        (value) => value.idempotencyKey === effect.idempotencyKey,
      );
      if (alreadyExists) {
        continue;
      }

      const persisted: InMemoryEffect = {
        runId: input.runId,
        sessionId: input.sessionId,
        stepIndex: input.stepIndex,
        type: effect.type,
        payload: effect.payload,
        idempotencyKey: effect.idempotencyKey,
        failurePolicy: effect.failurePolicy,
        status: "PENDING",
        createdAt: new Date().toISOString(),
        ...(this.runs.get(input.runId)?.tenantId === undefined ? {} : { tenantId: this.runs.get(input.runId)!.tenantId }),
        tenantOwnershipState: this.runs.get(input.runId)?.tenantOwnershipState ?? "legacy_unknown",
      };
      this.effects.push(persisted);
      persistedEffects.push({ ...persisted });
    }

    const persistedOutboxEventIds: number[] = [];
    for (const event of input.emitEvents) {
      const id = this.outboxIdCounter;
      this.outboxIdCounter += 1;

      this.outboxEvents.push({
        id,
        runId: input.runId,
        sessionId: input.sessionId,
        eventType: event.type,
        payload: event.payload,
        status: "PENDING",
        attemptCount: 0,
        createdAt: new Date().toISOString(),
      });
      persistedOutboxEventIds.push(id);
    }

    await this.appendRunLogsBatch(input.runLogs ?? []);
    await this.appendRunEventsBatch(input.runEvents ?? []);

    this.operationLog.push(`commitStep:${input.stepIndex}`);

    const persistedArtifacts = await this.appendArtifacts(
      input.runId,
      input.sessionId,
      input.stepIndex,
      input.artifacts ?? [],
    );
    const persistedClaims = await this.appendClaims(
      input.runId,
      input.sessionId,
      input.stepIndex,
      input.claims ?? [],
    );

    return {
      session: {
        sessionId: session.sessionId,
        version: session.version,
        state: normalizeRuntimeStateForPersist({ ...session.state }),
        currentStepAgent: session.currentStepAgent,
        updatedAt: session.updatedAt,
      },
      persistedEffects,
      persistedOutboxEventIds,
      persistedArtifacts,
      persistedClaims,
    };
  }

  async listPendingEffects(sessionId: string) {
    return this.effects
      .filter((effect) =>
        effect.sessionId === sessionId &&
        (effect.status === "PENDING" ||
          effect.status === "CLAIMED" ||
          effect.status === "DISPATCHED"),
      )
      .map((effect) => ({ ...effect }));
  }

  async getPersistedEffect(idempotencyKey: string): Promise<PersistedEffect | null> {
    const effect = this.effects.find((candidate) => candidate.idempotencyKey === idempotencyKey);
    return effect === undefined ? null : structuredClone(effect);
  }

  async getEffectResult(idempotencyKey: string): Promise<EffectResult | null> {
    const result = this.effectResults.get(idempotencyKey);
    if (result === undefined) {
      return null;
    }
    return { ...result };
  }

  async readExactEffectResult(input: { sessionId: string; runId: string; idempotencyKey: string; tenantId: string }) {
    const read = validateExactEffectResultRead({
      requested: input,
      effect: await this.getPersistedEffect(input.idempotencyKey),
      effectResult: await this.getEffectResult(input.idempotencyKey),
    });
    if (read.status !== "found") return read;
    const rawOutput = read.result.outcome.kind === "success" || read.result.outcome.kind === "partial" ? read.result.outcome.rawOutput : undefined;
    const evidence = typeof rawOutput === "object" && rawOutput !== null && !Array.isArray(rawOutput)
      ? (rawOutput as Record<string, unknown>).capabilityReplayEvidence
      : undefined;
    const leaseId = typeof evidence === "object" && evidence !== null && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>).leaseId
      : undefined;
    return validateExactEffectResultTenantBinding({
      read,
      requested: input,
      lease: typeof leaseId === "string" ? await this.getSandboxCapabilityLease(leaseId) : null,
    });
  }

  async claimExactEffectCancellation(input: { sessionId: string; runId: string; idempotencyKey: string; tenantId: string }) {
    const effect = this.effects.find((candidate) => candidate.idempotencyKey === input.idempotencyKey) ?? null;
    const candidate = validateExactEffectCancellationCandidate({ requested: input, effect });
    if (candidate !== "ready") return { status: candidate } as const;
    if (effect === null) return { status: "not_found" } as const;
    const ownershipState = effect.tenantOwnershipState ??
      (effect.tenantId === undefined ? "legacy_unknown" : "tenant_bound");
    if (ownershipState === "explicit_unbound") return { status: "conflict" } as const;
    if (ownershipState === "tenant_bound") {
      if (effect.tenantId === undefined) return { status: "conflict" } as const;
      if (effect.tenantId !== input.tenantId) return { status: "not_found" } as const;
    } else if (effect.tenantId !== undefined) {
      return { status: "conflict" } as const;
    }
    const requiresTenantBinding = exactEffectRequiresCapabilityTenantBinding(effect);
    if (ownershipState === "legacy_unknown" && !requiresTenantBinding) {
      return { status: "conflict" } as const;
    }
    const matchingLeases = requiresTenantBinding
      ? [...this.sandboxCapabilityLeaseTransitions.values()]
          .map((ledger) => ledger.at(-1))
          .filter((lease): lease is SandboxCapabilityLeaseTransitionRecordV1 =>
            lease !== undefined &&
            lease.binding.sessionId === input.sessionId &&
            lease.binding.runId === input.runId &&
            lease.binding.toolCallId === input.idempotencyKey
          )
      : [];
    if (requiresTenantBinding) {
      if (matchingLeases.length > 1) return { status: "conflict" } as const;
      const tenantBinding = validateExactEffectCancellationTenantBinding({
        requested: input,
        lease: matchingLeases[0] ?? null,
      });
      if (tenantBinding !== "ready") return { status: tenantBinding } as const;
    }
    const result = this.effectResults.get(input.idempotencyKey) ?? null;
    if (result !== null) {
      const read = validateExactEffectResultRead({ requested: input, effect: { ...effect, status: "DONE" }, effectResult: result });
      const tenantRead = requiresTenantBinding
        ? validateExactEffectResultTenantBinding({ read, requested: input, lease: matchingLeases[0] ?? null })
        : read;
      return {
        status: tenantRead.status === "found"
          ? "completed"
          : tenantRead.status === "not_found" ? "not_found" : "conflict",
      } as const;
    }
    if (effect.status === "CLAIMED" || effect.status === "DISPATCHED") {
      return { status: "started" } as const;
    }
    if (effect.status !== "PENDING") return { status: "conflict" } as const;
    effect.status = "FAILED";
    this.operationLog.push(`claimExactEffectCancellation:${input.idempotencyKey}`);
    return { status: "cancelled" } as const;
  }

  async saveEffectResult(
    runId: string,
    sessionId: string,
    result: EffectResult,
    intent?: EffectResultPersistenceIntent | undefined,
  ): Promise<void> {
    const materializedIntent = intent === undefined
      ? null
      : snapshotEffectResultPersistenceIntent(intent);
    if (intent !== undefined && materializedIntent === null) {
      throw new SandboxCapabilityExactResultConflictError(
        "Cleanup persistence intent was unreadable or malformed",
      );
    }
    const cleanupMaterialized = materializedIntent === null
      ? null
      : snapshotPreparedApprovalCleanupResult({
          result,
          expectedIdempotencyKey: materializedIntent.idempotencyKey,
        });
    const resultIdempotencyKey = materializedIntent?.idempotencyKey ??
      result.idempotencyKey;
    const resultStatus = cleanupMaterialized?.snapshot?.status ??
      (materializedIntent === null ? result.status : null);
    const effect = this.effects.find((candidate) => candidate.idempotencyKey === resultIdempotencyKey);
    if (effect === undefined || effect.runId !== runId || effect.sessionId !== sessionId) {
      throw new SandboxCapabilityExactResultConflictError("Effect result owner does not match the locked effect");
    }
    const preparedApprovalCleanup =
      effect.type === "release_prepared_tool_call" &&
      hasPreparedApprovalCleanupMarker(effect.payload);
    if (materializedIntent !== null) {
      if (!preparedApprovalCleanup) {
        throw new SandboxCapabilityExactResultConflictError(
          "Cleanup persistence intent does not match the locked durable effect",
        );
      }
      validatePreparedApprovalCleanupEffectIdentity(effect);
    } else if (preparedApprovalCleanup) {
      throw new SandboxCapabilityExactResultConflictError(
        "Cleanup result persistence requires explicit cleanup intent",
      );
    }
    const tenantResult = cleanupMaterialized?.snapshot ?? {
      idempotencyKey: resultIdempotencyKey,
      status: "FAILED" as const,
      timestamp: new Date().toISOString(),
    };
    if (!this.hasTrustedEffectTenant(
      effect,
      materializedIntent === null ? result : tenantResult,
    )) {
      throw new SandboxCapabilityExactResultConflictError("Effect result tenant does not match durable authority");
    }
    if (resultStatus === "DONE" && effect.status === "FAILED") {
      throw new SandboxCapabilityExactResultCancelledError("Completed effect-result persistence lost to durable cancellation");
    }
    if (this.effectResults.has(resultIdempotencyKey)) {
      return;
    }

    if (cleanupMaterialized !== null) {
      const occurredAt = new Date().toISOString();
      const materialized = cleanupMaterialized;
      if (materialized.snapshot?.status === "DONE") {
        try {
          validatePreparedApprovalCleanupDoneEvidence({
            effect,
            result: materialized.snapshot,
          });
          this.effectResults.set(
            resultIdempotencyKey,
            structuredClone(materialized.snapshot),
          );
          this.operationLog.push(
            `saveEffectResult:${resultIdempotencyKey}:${resultStatus}`,
          );
          return;
        } catch {
          // Invalid result evidence is quarantined below while the effect is owned.
        }
      }
      if (materialized.snapshot?.status === "FAILED") {
        this.effectResults.set(
          resultIdempotencyKey,
          structuredClone(materialized.snapshot),
        );
        this.operationLog.push(
          `saveEffectResult:${resultIdempotencyKey}:FAILED`,
        );
        return;
      }
      const auditEvent =
        buildPreparedApprovalCleanupDoneEvidenceQuarantineEventFromSnapshot({
          effect,
          auditSnapshot: materialized.auditSnapshot,
          occurredAt,
        });
      const quarantinedResult = {
        ...quarantinePreparedApprovalCleanupDoneResult(
          {
            idempotencyKey: effect.idempotencyKey,
            status: "DONE",
            timestamp: occurredAt,
          },
        ),
        timestamp: occurredAt,
      };
      const preparedAuditEvent = structuredClone(auditEvent);
      const preparedQuarantinedResult = structuredClone(quarantinedResult);
      this.runEvents.push(preparedAuditEvent);
      this.operationLog.push(`runEvent:${auditEvent.type}`);
      this.effectResults.set(
        resultIdempotencyKey,
        preparedQuarantinedResult,
      );
      effect.status = "PENDING";
      this.operationLog.push(
        `quarantineInvalidPreparedApprovalCleanupDoneEvidence:${resultIdempotencyKey}`,
      );
      return;
    }

    this.effectResults.set(resultIdempotencyKey, { ...result });
    this.operationLog.push(`saveEffectResult:${resultIdempotencyKey}:${resultStatus}`);
  }

  async claimEffectExecution(
    idempotencyKey: string,
    owner: { runId: string; sessionId: string },
  ): Promise<"claimed" | "already_claimed" | "already_dispatched" | "terminal"> {
    const effect = this.effects.find((candidate) => candidate.idempotencyKey === idempotencyKey);
    if (
      effect === undefined ||
      effect.runId !== owner.runId ||
      effect.sessionId !== owner.sessionId ||
      !this.hasTrustedEffectStatusTenant(effect)
    ) {
      throw new SandboxCapabilityExactResultConflictError("Effect execution owner or tenant does not match durable authority");
    }
    if (effect.status === "PENDING") {
      effect.status = "CLAIMED";
      this.operationLog.push(`claimEffectExecution:${idempotencyKey}`);
      return "claimed";
    }
    return effect.status === "CLAIMED"
      ? "already_claimed"
      : effect.status === "DISPATCHED"
        ? "already_dispatched"
        : "terminal";
  }

  async markEffectDispatched(
    idempotencyKey: string,
    owner: { runId: string; sessionId: string },
  ): Promise<"dispatched" | "already_dispatched" | "not_claimed" | "terminal"> {
    const effect = this.effects.find(
      (candidate) => candidate.idempotencyKey === idempotencyKey,
    );
    if (
      effect === undefined ||
      effect.runId !== owner.runId ||
      effect.sessionId !== owner.sessionId ||
      !this.hasTrustedEffectStatusTenant(effect)
    ) {
      throw new SandboxCapabilityExactResultConflictError(
        "Effect dispatch owner or tenant does not match durable authority",
      );
    }
    if (effect.status === "CLAIMED") {
      effect.status = "DISPATCHED";
      this.operationLog.push(`markEffectDispatched:${idempotencyKey}`);
      return "dispatched";
    }
    if (effect.status === "DISPATCHED") return "already_dispatched";
    return effect.status === "PENDING" ? "not_claimed" : "terminal";
  }

  async resetPreparedApprovalCleanupEffectExecution(
    idempotencyKey: string,
    owner: { runId: string; sessionId: string },
  ): Promise<"reset" | "done" | "conflict"> {
    return this.withPreparedApprovalCleanupExecutionLock(
      idempotencyKey,
      async () => {
        const effect = this.effects.find(
          (candidate) => candidate.idempotencyKey === idempotencyKey,
        );
        if (
          effect === undefined ||
          effect.runId !== owner.runId ||
          effect.sessionId !== owner.sessionId ||
          effect.type !== "release_prepared_tool_call" ||
          !hasPreparedApprovalCleanupMarker(effect.payload) ||
          !this.hasTrustedEffectStatusTenant(effect)
        ) return "conflict";
        const result = this.effectResults.get(idempotencyKey);
        if (result?.status === "DONE") return "done";
        if (result?.status === "FAILED") {
          this.effectResults.delete(idempotencyKey);
        }
        if (effect.status === "DONE") return "conflict";
        effect.status = "PENDING";
        this.operationLog.push(
          `resetPreparedApprovalCleanupEffectExecution:${idempotencyKey}`,
        );
        return "reset";
      },
    );
  }

  async quarantineInvalidPreparedApprovalCleanupDoneEvidence(
    idempotencyKey: string,
    owner: { runId: string; sessionId: string },
  ): Promise<"done" | "quarantined" | "conflict"> {
    return this.withPreparedApprovalCleanupExecutionLock(
      idempotencyKey,
      async () => {
        const effect = this.effects.find(
          (candidate) => candidate.idempotencyKey === idempotencyKey,
        );
        const result = this.effectResults.get(idempotencyKey);
        if (
          effect === undefined ||
          result?.status !== "DONE" ||
          effect.runId !== owner.runId ||
          effect.sessionId !== owner.sessionId ||
          effect.type !== "release_prepared_tool_call" ||
          !hasPreparedApprovalCleanupMarker(effect.payload)
        ) return "conflict";
        const doneResult: EffectResult & { status: "DONE" } = {
          ...result,
          status: "DONE",
        };
        try {
          validatePreparedApprovalCleanupEffectIdentity(effect);
        } catch {
          return "conflict";
        }
        if (!this.hasTrustedEffectTenant(effect, result)) return "conflict";
        try {
          validatePreparedApprovalCleanupDoneEvidence({
            effect,
            result: doneResult,
          });
          effect.status = "DONE";
          return "done";
        } catch {
          const occurredAt = new Date().toISOString();
          const auditEvent =
            buildPreparedApprovalCleanupDoneEvidenceQuarantineEvent({
              effect,
              invalidResult: doneResult,
              occurredAt,
            });
          const quarantinedResult = {
            ...quarantinePreparedApprovalCleanupDoneResult(doneResult),
            timestamp: occurredAt,
          };
          const preparedAuditEvent = structuredClone(auditEvent);
          const preparedQuarantinedResult = structuredClone(quarantinedResult);
          this.runEvents.push(preparedAuditEvent);
          this.operationLog.push(`runEvent:${auditEvent.type}`);
          this.effectResults.set(
            idempotencyKey,
            preparedQuarantinedResult,
          );
          effect.status = "PENDING";
          this.operationLog.push(
            `quarantineInvalidPreparedApprovalCleanupDoneEvidence:${idempotencyKey}`,
          );
          return "quarantined";
        }
      },
    );
  }

  async executePreparedApprovalCleanupInCriticalSection(
    idempotencyKey: string,
    owner: { runId: string; sessionId: string },
    execute: () => Promise<EffectResult & { status: "DONE" }>,
  ): Promise<
    | { status: "executed"; result: EffectResult & { status: "DONE" } }
    | { status: "done"; result: EffectResult & { status: "DONE" } }
    | { status: "conflict" }
  > {
    return this.withPreparedApprovalCleanupExecutionLock(
      idempotencyKey,
      async () => {
        const effect = this.effects.find(
          (candidate) => candidate.idempotencyKey === idempotencyKey,
        );
        if (
          effect === undefined ||
          effect.runId !== owner.runId ||
          effect.sessionId !== owner.sessionId ||
          effect.type !== "release_prepared_tool_call" ||
          !hasPreparedApprovalCleanupMarker(effect.payload)
        ) return { status: "conflict" };
        try {
          validatePreparedApprovalCleanupEffectIdentity(effect);
        } catch {
          return { status: "conflict" };
        }
        const existing = this.effectResults.get(idempotencyKey);
        if (existing?.status === "DONE") {
          const doneResult: EffectResult & { status: "DONE" } = {
            ...existing,
            status: "DONE",
          };
          if (!this.hasTrustedEffectTenant(effect, existing)) {
            return { status: "conflict" };
          }
          try {
            validatePreparedApprovalCleanupDoneEvidence({
              effect,
              result: doneResult,
            });
          } catch {
            return { status: "conflict" };
          }
          effect.status = "DONE";
          return {
            status: "done",
            result: structuredClone(doneResult),
          };
        }
        if (
          existing !== undefined ||
          effect.status !== "CLAIMED" ||
          !this.hasTrustedEffectStatusTenant(effect)
        ) return { status: "conflict" };
        const result = await execute();
        if (!this.hasTrustedEffectTenant(effect, result)) {
          throw new SandboxCapabilityExactResultConflictError(
            "Cleanup critical-section result tenant does not match durable authority",
          );
        }
        validatePreparedApprovalCleanupDoneEvidence({ effect, result });
        this.effectResults.set(idempotencyKey, structuredClone(result));
        effect.status = "DONE";
        this.operationLog.push(
          `commitPreparedApprovalCleanupEffectDone:${idempotencyKey}`,
        );
        return {
          status: "executed",
          result: structuredClone(result),
        };
      },
    );
  }

  async commitPreparedApprovalCleanupEffectDone(
    idempotencyKey: string,
    owner: { runId: string; sessionId: string },
    result: EffectResult & { status: "DONE" },
  ): Promise<void> {
    const effect = this.effects.find(
      (candidate) => candidate.idempotencyKey === idempotencyKey,
    );
    if (
      effect === undefined ||
      effect.runId !== owner.runId ||
      effect.sessionId !== owner.sessionId ||
      result.idempotencyKey !== idempotencyKey ||
      result.status !== "DONE" ||
      effect.type !== "release_prepared_tool_call" ||
      !hasPreparedApprovalCleanupMarker(effect.payload) ||
      !this.hasTrustedEffectTenant(effect, result)
    ) {
      throw new SandboxCapabilityExactResultConflictError(
        "Cleanup effect success does not match exact durable authority",
      );
    }
    const suppliedEvidence = validatePreparedApprovalCleanupDoneEvidence({
      effect,
      result,
    });
    const existing = this.effectResults.get(idempotencyKey);
    if (existing?.status === "DONE") {
      const existingEvidence = validatePreparedApprovalCleanupDoneEvidence({
        effect,
        result: existing,
      });
      if (
        existingEvidence.canonicalOutput !== suppliedEvidence.canonicalOutput
      ) {
        throw new SandboxCapabilityExactResultConflictError(
          "Cleanup DONE result conflicts with existing exact evidence",
        );
      }
    } else {
      this.effectResults.set(idempotencyKey, structuredClone(result));
    }
    effect.status = "DONE";
    this.operationLog.push(
      `commitPreparedApprovalCleanupEffectDone:${idempotencyKey}`,
    );
  }

  async markEffectStatus(idempotencyKey: string, status: EffectExecutionStatus, owner: { runId: string; sessionId: string }): Promise<void> {
    const effect = this.effects.find((candidate) => candidate.idempotencyKey === idempotencyKey);
    if (
      effect === undefined ||
      effect.runId !== owner.runId ||
      effect.sessionId !== owner.sessionId ||
      !this.hasTrustedEffectStatusTenant(effect)
    ) {
      throw new SandboxCapabilityExactResultConflictError("Effect status owner or tenant does not match durable authority");
    }
    if (
      status === "DONE" &&
      effect.status === "FAILED" &&
      this.effectResults.get(idempotencyKey)?.status !== "DONE"
    ) {
      throw new SandboxCapabilityExactResultCancelledError("Completed effect status lost to durable cancellation");
    }
    if (
      status === "FAILED" &&
      (effect.status === "DONE" ||
        this.effectResults.get(idempotencyKey)?.status === "DONE")
    ) {
      return;
    }
    effect.status = status;
    this.operationLog.push(`markEffectStatus:${idempotencyKey}:${status}`);
  }

  private async withPreparedApprovalCleanupExecutionLock<T>(
    idempotencyKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.preparedApprovalCleanupExecutionLocks.get(
      idempotencyKey,
    ) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => held);
    this.preparedApprovalCleanupExecutionLocks.set(idempotencyKey, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (
        this.preparedApprovalCleanupExecutionLocks.get(idempotencyKey) ===
          queued
      ) {
        this.preparedApprovalCleanupExecutionLocks.delete(idempotencyKey);
      }
    }
  }

  private hasTrustedEffectTenant(effect: InMemoryEffect, result: EffectResult): boolean {
    const ownershipState = effect.tenantOwnershipState ??
      (effect.tenantId === undefined ? "legacy_unknown" : "tenant_bound");
    if (this.tenantId === undefined) {
      return ownershipState === "explicit_unbound" && effect.tenantId === undefined;
    }
    if (effect.tenantId !== undefined) {
      return ownershipState === "tenant_bound" && effect.tenantId === this.tenantId;
    }
    if (ownershipState !== "legacy_unknown") return false;
    if (!exactEffectRequiresCapabilityTenantBinding(effect)) return false;
    if (result.status === "FAILED") return this.hasTrustedEffectStatusTenant(effect);
    const read = validateExactEffectResultRead({
      requested: { runId: effect.runId, sessionId: effect.sessionId, idempotencyKey: effect.idempotencyKey },
      effect: { ...effect, status: "DONE" },
      effectResult: result,
    });
    if (read.status !== "found") return false;
    const raw = read.result.outcome.kind === "success" || read.result.outcome.kind === "partial"
      ? read.result.outcome.rawOutput : undefined;
    const evidence = typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).capabilityReplayEvidence : undefined;
    const leaseId = typeof evidence === "object" && evidence !== null && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>).leaseId : undefined;
    const lease = typeof leaseId === "string" ? this.sandboxCapabilityLeaseTransitions.get(leaseId)?.at(-1) ?? null : null;
    return validateExactEffectResultTenantBinding({
      read,
      requested: { runId: effect.runId, sessionId: effect.sessionId, idempotencyKey: effect.idempotencyKey, tenantId: this.tenantId },
      lease,
    }).status === "found";
  }

  private hasTrustedEffectStatusTenant(effect: InMemoryEffect): boolean {
    const ownershipState = effect.tenantOwnershipState ??
      (effect.tenantId === undefined ? "legacy_unknown" : "tenant_bound");
    if (this.tenantId === undefined) {
      return ownershipState === "explicit_unbound" && effect.tenantId === undefined;
    }
    if (effect.tenantId !== undefined) {
      return ownershipState === "tenant_bound" && effect.tenantId === this.tenantId;
    }
    if (ownershipState !== "legacy_unknown") return false;
    if (!exactEffectRequiresCapabilityTenantBinding(effect)) return false;
    const matches = [...this.sandboxCapabilityLeaseTransitions.values()]
      .map((ledger) => ledger.at(-1))
      .filter((lease): lease is SandboxCapabilityLeaseTransitionRecordV1 =>
        lease !== undefined && lease.binding.runId === effect.runId &&
        lease.binding.sessionId === effect.sessionId &&
        lease.binding.toolCallId === effect.idempotencyKey
      );
    return matches.length === 1 && validateExactEffectCancellationTenantBinding({
      requested: {
        runId: effect.runId, sessionId: effect.sessionId,
        idempotencyKey: effect.idempotencyKey, tenantId: this.tenantId,
      },
      lease: matches[0]!,
    }) === "ready";
  }

  async listUndeliveredOutbox(limit: number, runId?: string): Promise<OutboxEventRecord[]> {
    return this.outboxEvents
      .filter((event) => {
        if (event.status === "DELIVERED") {
          return false;
        }
        if (runId !== undefined) {
          return event.runId === runId;
        }
        return true;
      })
      .slice(0, limit)
      .map((event) => ({ ...event }));
  }

  async markOutboxDelivered(id: number): Promise<void> {
    await this.markOutboxDeliveredBatch([id]);
  }

  async markOutboxAttemptFailed(id: number, error: string): Promise<void> {
    await this.markOutboxAttemptFailedBatch([{ id, error }]);
  }

  async markOutboxDeliveredBatch(ids: number[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const target = new Set(ids);
    const deliveredAt = new Date().toISOString();
    for (const event of this.outboxEvents) {
      if (target.has(event.id) === false) {
        continue;
      }
      event.status = "DELIVERED";
      event.deliveredAt = deliveredAt;
      event.lastError = undefined;
      this.operationLog.push(`outboxDelivered:${event.id}`);
    }
  }

  async markOutboxAttemptFailedBatch(entries: Array<{ id: number; error: string }>): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const errorsById = new Map(entries.map((entry) => [entry.id, entry.error]));
    for (const event of this.outboxEvents) {
      const error = errorsById.get(event.id);
      if (error === undefined) {
        continue;
      }
      event.status = "FAILED";
      event.attemptCount += 1;
      event.lastError = error;
      this.operationLog.push(`outboxFailed:${event.id}`);
    }
  }

  async appendRunLog(entry: RunLogEntry): Promise<void> {
    await this.appendRunLogsBatch([entry]);
  }

  async appendRunEvent(event: RunEvent): Promise<void> {
    await this.appendRunEventsBatch([event]);
  }

  async appendSandboxCapabilityLeaseTransition(input: {
    expectedSequence: number;
    record: SandboxCapabilityLeaseTransitionRecordV1;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    return this.appendSandboxCapabilityLeaseTransitionNow(input);
  }

  async issueSandboxCapabilityLease(input: {
    expectedSequence: number;
    record: SandboxCapabilityLeaseTransitionRecordV1;
    childReservation?: SandboxCapabilityChildReservationV1 | undefined;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    const record = parseSandboxCapabilityLeaseTransitionRecordV1(input.record);
    if (record.transition !== "issued") throw new Error("Sandbox capability issuance must transition to issued");
    const child = input.childReservation === undefined
      ? undefined
      : this.validateInMemoryChildReservation(input.childReservation);
    const persisted = this.appendSandboxCapabilityLeaseTransitionNow({
      expectedSequence: input.expectedSequence,
      record,
    });
    if (child !== undefined) {
      this.sandboxCapabilityChildReservations.set(child.reservationId, [structuredClone(child)]);
    }
    return persisted;
  }

  async reserveSandboxCapabilityInvocation(input: {
    expectedSequence: number;
    record: SandboxCapabilityLeaseTransitionRecordV1;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1 & { invocationResponseByteLimit: number }> {
    const record = parseSandboxCapabilityLeaseTransitionRecordV1(input.record);
    if (record.transition !== "invoking") throw new Error("Sandbox capability invocation must transition to invoking");
    const current = this.sandboxCapabilityLeaseTransitions.get(record.leaseId)?.at(-1);
    if (current === undefined || current.sequence !== input.expectedSequence) throw new Error("Sandbox capability lease transition sequence conflict");
    const allocated = this.inMemoryChildCapacity(current.leaseId);
    const invocationResponseByteLimit = record.usage.responseByteLimit - record.usage.responseBytesConsumed - allocated.bytes;
    if (record.usage.requestsConsumed + allocated.requests > record.usage.requestLimit || invocationResponseByteLimit <= 0) {
      throw new Error("Sandbox capability parent ceiling is reserved by child authority");
    }
    return { ...this.appendSandboxCapabilityLeaseTransitionNow(input), invocationResponseByteLimit };
  }

  async saveSandboxCapabilityEffectResult(input: {
    leaseId: string;
    bindingDigest: string;
    toolCallId: string;
    runId: string;
    sessionId: string;
    result: EffectResult;
    signal?: AbortSignal | undefined;
  }): Promise<void> {
    const exactInput = {
      ...input,
      result: JSON.parse(canonicalJson(input.result)) as EffectResult,
    };
    const effect = this.effects.find((candidate) => candidate.idempotencyKey === input.toolCallId) ?? null;
    const candidate = validateExactEffectCancellationCandidate({
      requested: { sessionId: exactInput.sessionId, runId: exactInput.runId, idempotencyKey: exactInput.toolCallId },
      effect,
    });
    if (candidate !== "ready") {
      throw new SandboxCapabilityExactResultConflictError("Sandbox capability exact result has no matching prepared effect");
    }
    if (effect === null) {
      throw new SandboxCapabilityExactResultConflictError("Sandbox capability exact result has no matching prepared effect");
    }
    if (effect?.status === "FAILED") {
      throw new SandboxCapabilityExactResultCancelledError("Sandbox capability exact-result persistence was cancelled");
    }
    const lease = this.sandboxCapabilityLeaseTransitions.get(input.leaseId)?.at(-1);
    assertReplayableSandboxCapabilityEffectBinding(lease, exactInput);
    const ownershipState = effect?.tenantOwnershipState ??
      (effect?.tenantId === undefined ? "legacy_unknown" : "tenant_bound");
    const effectTenantAuthorized = ownershipState === "tenant_bound"
      ? effect?.tenantId === this.tenantId
      : ownershipState === "legacy_unknown" && effect?.tenantId === undefined;
    if (this.tenantId === undefined || lease?.binding.tenantId !== this.tenantId || !effectTenantAuthorized) {
      throw new SandboxCapabilityExactResultConflictError("Sandbox capability effect result tenant does not match durable authority");
    }
    const existing = this.effectResults.get(exactInput.result.idempotencyKey);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(exactInput.result)) {
        throw new SandboxCapabilityExactResultConflictError("Sandbox capability effect result conflicts with recorded exact replay output");
      }
      effect.status = "DONE";
      this.operationLog.push(`saveSandboxCapabilityEffectResult:${input.leaseId}:${input.toolCallId}:idempotent`);
      return;
    }
    if (effect.status === "DONE") {
      throw new SandboxCapabilityExactResultConflictError("Sandbox capability effect is DONE without its exact replay result");
    }
    if (input.signal?.aborted === true) throw new SandboxCapabilityExactResultCancelledError("Sandbox capability exact-result persistence was cancelled");
    this.effectResults.set(exactInput.result.idempotencyKey, structuredClone(exactInput.result));
    effect.status = "DONE";
    this.operationLog.push(`saveSandboxCapabilityEffectResult:${input.leaseId}:${input.toolCallId}`);
  }

  private appendSandboxCapabilityLeaseTransitionNow(input: {
    expectedSequence: number;
    record: SandboxCapabilityLeaseTransitionRecordV1;
  }): SandboxCapabilityLeaseTransitionRecordV1 {
    const record = parseSandboxCapabilityLeaseTransitionRecordV1(input.record);
    if (record.bindingDigest !== fingerprintSandboxCapabilityLeaseBinding(record.binding)) {
      throw new Error("Sandbox capability lease binding digest does not match the immutable binding");
    }
    const ledger = this.sandboxCapabilityLeaseTransitions.get(record.leaseId) ?? [];
    const current = ledger.at(-1);
    const currentSequence = current?.sequence ?? 0;
    if (input.expectedSequence !== currentSequence || record.sequence !== currentSequence + 1) {
      throw new Error("Sandbox capability lease transition sequence conflict");
    }
    assertSandboxCapabilityLeaseTransitionV1(current?.transition, record.transition);
    if (current !== undefined && (current.bindingDigest !== record.bindingDigest || JSON.stringify(current.binding) !== JSON.stringify(record.binding))) {
      throw new Error("Sandbox capability lease immutable binding changed");
    }
    const persisted = structuredClone(record);
    ledger.push(persisted);
    this.sandboxCapabilityLeaseTransitions.set(record.leaseId, ledger);
    this.runEvents.push({ runId: record.binding.runId, sessionId: record.binding.sessionId, type: `sandbox_capability.${record.transition}` as RunEvent["type"], level: record.transition === "denied" || record.transition === "revoked" || record.transition === "expired" || record.transition === "cancelled" ? "WARN" : "INFO", timestamp: record.occurredAt, metadata: { record: structuredClone(record) } });
    if (["denied", "revoked", "expired", "cancelled", "cleaned"].includes(record.transition)) {
      this.revokeInMemoryChildReservations(record.leaseId, record.occurredAt, `parent_${record.transition}`);
    }
    this.operationLog.push(`sandboxCapabilityLease:${record.transition}`);
    return structuredClone(persisted);
  }

  async getSandboxCapabilityLease(leaseId: string): Promise<SandboxCapabilityLeaseTransitionRecordV1 | null> {
    const record = this.sandboxCapabilityLeaseTransitions.get(leaseId)?.at(-1);
    return record === undefined ? null : structuredClone(record);
  }

  async listSandboxCapabilityLeaseTransitions(leaseId: string): Promise<SandboxCapabilityLeaseTransitionRecordV1[]> {
    return (this.sandboxCapabilityLeaseTransitions.get(leaseId) ?? []).map((record) => structuredClone(record));
  }

  async listRecoverableSandboxCapabilityLeases(input: { before: string; limit?: number | undefined }): Promise<SandboxCapabilityLeaseTransitionRecordV1[]> {
    const before = Date.parse(input.before);
    if (Number.isFinite(before) === false) throw new Error("Sandbox capability recovery cutoff must be a timestamp");
    const limit = input.limit ?? 100;
    return [...this.sandboxCapabilityLeaseTransitions.values()]
      .map((ledger) => ledger.at(-1))
      .filter((record): record is SandboxCapabilityLeaseTransitionRecordV1 => record !== undefined && record.transition !== "cleaned" && record.transition !== "denied" && Date.parse(record.occurredAt) <= before)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.leaseId.localeCompare(right.leaseId))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  async reserveSandboxCapabilityChild(input: { expectedParentSequence: number; reservation: SandboxCapabilityChildReservationV1 }): Promise<SandboxCapabilityChildReservationV1> {
    const reservation = this.validateInMemoryChildReservation(input.reservation, input.expectedParentSequence);
    const persisted = structuredClone(reservation);
    this.sandboxCapabilityChildReservations.set(reservation.reservationId, [persisted]);
    return structuredClone(persisted);
  }

  private validateInMemoryChildReservation(value: SandboxCapabilityChildReservationV1, expectedParentSequence?: number): SandboxCapabilityChildReservationV1 {
    const reservation = parseSandboxCapabilityChildReservationV1(value);
    if (reservation.sequence !== 1 || reservation.status !== "reserved") throw new Error("Sandbox capability child reservation must begin reserved at sequence 1");
    const parent = this.sandboxCapabilityLeaseTransitions.get(reservation.decision.parentLeaseId)?.at(-1);
    if (
      parent === undefined ||
      (expectedParentSequence !== undefined && parent.sequence !== expectedParentSequence) ||
      parent.bindingDigest !== reservation.decision.parentBindingDigest ||
      parent.transition !== "issued"
    ) throw new Error("Sandbox capability parent authorization is unavailable or stale");
    if (this.sandboxCapabilityChildReservations.has(reservation.reservationId)) throw new Error("Sandbox capability child reservation conflict");
    const allocated = this.inMemoryChildCapacity(parent.leaseId);
    if (parent.usage.requestsConsumed + allocated.requests + reservation.decision.requestLimit > parent.usage.requestLimit || parent.usage.responseBytesConsumed + allocated.bytes + reservation.decision.responseByteLimit > parent.usage.responseByteLimit) throw new Error("Sandbox capability parent ceiling is exhausted");
    return reservation;
  }

  async settleSandboxCapabilityChild(input: { reservationId: string; expectedSequence: number; status: "committed" | "released"; requestsCommitted: number; responseBytesCommitted: number; reason?: string | undefined; occurredAt: string }): Promise<SandboxCapabilityChildReservationV1> {
    const ledger = this.sandboxCapabilityChildReservations.get(input.reservationId);
    const current = ledger?.at(-1);
    if (current === undefined || current.sequence !== input.expectedSequence || current.status !== "reserved") throw new Error("Sandbox capability child reservation sequence conflict");
    const next = parseSandboxCapabilityChildReservationV1({ ...current, sequence: current.sequence + 1, status: input.status, requestsCommitted: input.requestsCommitted, responseBytesCommitted: input.responseBytesCommitted, ...(input.reason === undefined ? {} : { reason: input.reason }), occurredAt: input.occurredAt });
    ledger!.push(structuredClone(next));
    return structuredClone(next);
  }

  async getSandboxCapabilityChildReservation(reservationId: string): Promise<SandboxCapabilityChildReservationV1 | null> {
    const current = this.sandboxCapabilityChildReservations.get(reservationId)?.at(-1);
    return current === undefined ? null : structuredClone(current);
  }

  async listSandboxCapabilityChildReservations(parentLeaseId: string): Promise<SandboxCapabilityChildReservationV1[]> {
    return this.currentInMemoryChildReservations(parentLeaseId).map((item) => structuredClone(item));
  }

  private currentInMemoryChildReservations(parentLeaseId: string): SandboxCapabilityChildReservationV1[] {
    return [...this.sandboxCapabilityChildReservations.values()].map((ledger) => ledger.at(-1)).filter((item): item is SandboxCapabilityChildReservationV1 => item?.decision.parentLeaseId === parentLeaseId);
  }

  private inMemoryChildCapacity(parentLeaseId: string): { requests: number; bytes: number } {
    return this.currentInMemoryChildReservations(parentLeaseId).reduce(
      (sum, item) => ({
        requests: sum.requests + (item.status === "reserved" ? item.decision.requestLimit : item.status === "committed" ? item.requestsCommitted : 0),
        bytes: sum.bytes + (item.status === "reserved" ? item.decision.responseByteLimit : item.status === "committed" ? item.responseBytesCommitted : 0),
      }),
      { requests: 0, bytes: 0 },
    );
  }

  private revokeInMemoryChildReservations(parentLeaseId: string, occurredAt: string, reason: string): void {
    for (const current of this.currentInMemoryChildReservations(parentLeaseId)) {
      if (current.status !== "reserved") continue;
      this.sandboxCapabilityChildReservations.get(current.reservationId)!.push({ ...structuredClone(current), sequence: current.sequence + 1, status: "revoked", reason, occurredAt });
    }
  }

  async appendRunLogsBatch(entries: RunLogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    for (const entry of entries) {
      this.runLogs.push({ ...entry });
      this.operationLog.push(`runLog:${entry.eventName}`);
    }
  }

  async appendRunEventsBatch(events: RunEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    for (const event of events) {
      this.runEvents.push({ ...event });
      this.operationLog.push(`runEvent:${event.type}`);
    }
  }

  async appendArtifacts(
    runId: string,
    sessionId: string,
    stepIndex: number,
    artifacts: Array<{ type: string; id?: string | undefined; payload: Record<string, unknown> }>,
  ): Promise<PersistedArtifact[]> {
    const persisted: PersistedArtifact[] = artifacts.map((artifact, index) => {
      const artifactId = artifact.id ?? `${runId}:artifact:${stepIndex}:${index}:${artifact.type}`;
      const value: PersistedArtifact = {
        artifactId,
        sessionId,
        runId,
        stepIndex,
        type: artifact.type,
        payload: artifact.payload,
        createdAt: new Date().toISOString(),
      };
      this.artifacts.push(value);
      return { ...value };
    });

    if (persisted.length > 0) {
      this.operationLog.push(`artifacts:${persisted.length}`);
    }

    return persisted;
  }

  async getArtifact(input: { artifactId: string; sessionId: string }): Promise<PersistedArtifact | null> {
    const artifact = this.artifacts.find((item) =>
      item.artifactId === input.artifactId && item.sessionId === input.sessionId
    );
    return artifact === undefined ? null : { ...artifact, payload: { ...artifact.payload } };
  }

  async listArtifacts(input: {
    sessionId: string;
    runId?: string | undefined;
    stepIndex?: number | undefined;
    type?: string | undefined;
    limit?: number | undefined;
  }): Promise<PersistedArtifact[]> {
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
    return this.artifacts
      .filter((artifact) =>
        artifact.sessionId === input.sessionId &&
        (input.runId === undefined || artifact.runId === input.runId) &&
        (input.stepIndex === undefined || artifact.stepIndex === input.stepIndex) &&
        (input.type === undefined || artifact.type === input.type)
      )
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.artifactId.localeCompare(right.artifactId)
      )
      .slice(0, limit)
      .map((artifact) => ({ ...artifact, payload: { ...artifact.payload } }));
  }

  async appendClaims(
    runId: string,
    sessionId: string,
    stepIndex: number,
    claims: Array<{
      id?: string | undefined;
      text: string;
      evidenceIds: string[];
      status: "proposed" | "verified" | "disputed" | "retracted";
    }>,
  ): Promise<PersistedClaim[]> {
    const persisted: PersistedClaim[] = claims.map((claim, index) => {
      const claimId = claim.id ?? `${runId}:claim:${stepIndex}:${index}`;
      const value: PersistedClaim = {
        claimId,
        sessionId,
        runId,
        stepIndex,
        text: claim.text,
        status: claim.status,
        evidenceIds: [...claim.evidenceIds],
        createdAt: new Date().toISOString(),
      };
      this.claims.push(value);
      return { ...value };
    });

    if (persisted.length > 0) {
      this.operationLog.push(`claims:${persisted.length}`);
    }

    return persisted;
  }

  async listReadyRegionWorkItems(sessionId: string): Promise<RegionWorkItem[]> {
    return this.regionWorkItems
      .filter((item) => item.sessionId === sessionId && item.status === "PENDING")
      .sort((a, b) => {
        const regionCompare = a.region.localeCompare(b.region);
        return regionCompare !== 0 ? regionCompare : a.id - b.id;
      })
      .map((item) => ({ ...item }));
  }

  async claimNextRegionWorkItem(sessionId: string, cursor?: string): Promise<RegionWorkItem | null> {
    const pending = this.regionWorkItems
      .filter((item) => item.sessionId === sessionId && item.status === "PENDING")
      .sort((a, b) => {
        const regionCompare = a.region.localeCompare(b.region);
        return regionCompare !== 0 ? regionCompare : a.id - b.id;
      });

    if (pending.length === 0) {
      return null;
    }

    const claimed =
      cursor === undefined
        ? pending[0]
        : pending.find((item) => item.region > cursor) ?? pending[0];

    if (claimed === undefined) {
      return null;
    }

    claimed.status = "CLAIMED";
    claimed.claimedAt = new Date().toISOString();
    this.operationLog.push(`regionClaimed:${claimed.id}:${claimed.region}`);
    return { ...claimed };
  }

  async completeRegionWorkItem(
    itemId: number,
    outcome: "DONE" | "FAILED",
    error?: Record<string, unknown>,
  ): Promise<void> {
    const item = this.regionWorkItems.find((value) => value.id === itemId);
    if (item === undefined) {
      return;
    }

    item.status = outcome;
    item.completedAt = new Date().toISOString();
    item.error = error;
    this.operationLog.push(`regionCompleted:${item.id}:${outcome}`);
  }

  async spawnRegionWorkItems(sessionId: string, items: RegionWorkIntent[]): Promise<void> {
    for (const item of items) {
      this.regionWorkItems.push({
        id: this.regionWorkItemIdCounter,
        sessionId,
        region: item.region,
        stepAgent: item.stepAgent,
        status: "PENDING",
        ...(item.stateNode !== undefined ? { stateNode: item.stateNode } : {}),
        createdAt: new Date().toISOString(),
      });
      this.regionWorkItemIdCounter += 1;
    }

    if (items.length > 0) {
      this.operationLog.push(`regionSpawned:${items.length}`);
    }
  }

  async getReplayStream(input: {
    runId?: string | undefined;
    sessionId?: string | undefined;
    threadId?: string | undefined;
    delegationId?: string | undefined;
    eventTypes?: RunEvent["type"][] | undefined;
    fromTimestamp?: string | undefined;
    toTimestamp?: string | undefined;
    limit?: number | undefined;
  }): Promise<RunEvent[]> {
    const fromTs = input.fromTimestamp ?? "";
    const toTs = input.toTimestamp ?? "9999-12-31T23:59:59.999Z";
    const threadSessionId =
      input.threadId !== undefined
        ? (await this.orchestrationStore.getThread(input.threadId))?.sessionId
        : undefined;
    const delegation = input.delegationId !== undefined
      ? await this.orchestrationStore.getDelegation(input.delegationId)
      : null;
    const childSessionId =
      delegation !== null
        ? (await this.orchestrationStore.getThread(delegation.childThreadId))?.sessionId
        : undefined;

    const events = this.runEvents
      .filter((event) => {
        if (input.runId !== undefined && event.runId !== input.runId) {
          return false;
        }
        if (input.sessionId !== undefined && event.sessionId !== input.sessionId) {
          return false;
        }
        if (input.eventTypes !== undefined && input.eventTypes.includes(event.type) === false) {
          return false;
        }
        const matchesThread =
          threadSessionId === undefined ? true : event.sessionId === threadSessionId;
        const matchesDelegation =
          input.delegationId === undefined
            ? true
            : event.sessionId === childSessionId ||
              asRecord(event.metadata)?.delegationId === input.delegationId;
        if (threadSessionId !== undefined && input.delegationId === undefined && matchesThread === false) {
          return false;
        }
        if (threadSessionId !== undefined && input.delegationId !== undefined && matchesThread === false && matchesDelegation === false) {
          return false;
        }
        if (threadSessionId === undefined && matchesDelegation === false) {
          return false;
        }
        return event.timestamp >= fromTs && event.timestamp <= toTs;
      });
    return (input.limit === undefined ? events : events.slice(0, input.limit))
      .map((event) => ({ ...event }));
  }

  async claimConversationTurnExecution(
    input: ClaimConversationTurnExecutionInput,
  ): Promise<ClaimConversationTurnExecutionResult> {
    const session = this.sessions.get(input.sessionId);
    const thread = await this.orchestrationStore.getThread(input.threadId);
    if (session === undefined || thread === null || thread.sessionId !== input.sessionId) {
      throw createRuntimeFailure(
        "STORE_CONVERSATION_TURN_CLAIM_INVALID",
        "Conversation turn execution claim does not reference an existing thread session.",
        { turnId: input.turnId, threadId: input.threadId, sessionId: input.sessionId },
      );
    }

    const existing = this.conversationTurns.get(input.turnId);
    const existingClaim = asRecord(existing?.metadata?.executionClaim);
    const storedTurnIdentity = asString(existingClaim?.turnRequestIdentity);
    if (
      existing !== undefined &&
      storedTurnIdentity !== undefined &&
      storedTurnIdentity !== input.turnRequestIdentity
    ) {
      throw createRuntimeFailure(
        "CONVERSATION_TURN_IDENTITY_CONFLICT",
        `Conversation turn '${input.turnId}' was already claimed by a different initial request.`,
        { turnId: input.turnId },
      );
    }
    if (existing?.status === "COMPLETED" || existing?.status === "FAILED") {
      const terminalEnvelope = readTerminalEnvelope(existing.metadata);
      if (terminalEnvelope === undefined) {
        throw createRuntimeFailure(
          "RUNTIME_TERMINAL_HANDOFF_INCOMPLETE",
          `Conversation turn '${input.turnId}' is terminal without a replay envelope.`,
          { turnId: input.turnId, runId: existing.terminalRunId },
        );
      }
      return { kind: "terminal", terminalEnvelope };
    }
    const consumedSubmission = [...this.conversationTurnSegments.values()].find(
      (segment) =>
        segment.turnId === input.turnId &&
        asString(asRecord(segment.metadata)?.submissionIdentity) === input.submissionIdentity,
    );
    if (consumedSubmission !== undefined) {
      return { kind: "already_running", runId: consumedSubmission.runId };
    }
    if (existing?.status === "RUNNING") {
      const activeRunId = existing.activeRunId;
      const activeRun = activeRunId === undefined ? undefined : this.runs.get(activeRunId);
      if (activeRun?.status === "RUNNING") {
        return { kind: "already_running", runId: activeRun.runId };
      }
      if (activeRun !== undefined) {
        if (activeRun.status === "WAITING") {
          const activeWait = readActiveWaitState(asRecord(session.state.agent));
          if (activeWait !== undefined) {
            await this.completeRun(activeRun.runId, "WAITING", activeRun.error, {
              wait: buildCanonicalWaitingFor({
                waitFor: activeWait,
                resumeStepAgent: activeWait.resumeStepAgent,
                resumeToken: activeWait.resumeToken,
                reason: activeWait.reason,
                resumeInstruction: activeWait.resumeInstruction,
                blockedAction: activeWait.blockedAction,
              }),
            });
          } else {
            await this.completeRun(activeRun.runId, "FAILED", {
              code: "RECOVERED_WAIT_STATE_INVALID",
              message: "Persisted WAITING run has no canonical wait to resume.",
              details: { turnId: input.turnId, runId: activeRun.runId },
            });
            const failedTurn = this.conversationTurns.get(input.turnId);
            const terminalEnvelope = readTerminalEnvelope(failedTurn?.metadata);
            if (terminalEnvelope === undefined) {
              throw createRuntimeFailure(
                "RUNTIME_TERMINAL_HANDOFF_INCOMPLETE",
                `Recovered turn '${input.turnId}' has no replay envelope.`,
                { turnId: input.turnId, runId: activeRun.runId },
              );
            }
            return { kind: "terminal", terminalEnvelope };
          }
        } else {
          await this.completeRun(activeRun.runId, activeRun.status, activeRun.error);
          const terminalTurn = this.conversationTurns.get(input.turnId);
          const terminalEnvelope = readTerminalEnvelope(terminalTurn?.metadata);
          if (terminalEnvelope === undefined) {
            throw createRuntimeFailure(
              "RUNTIME_TERMINAL_HANDOFF_INCOMPLETE",
              `Recovered turn '${input.turnId}' has no replay envelope.`,
              { turnId: input.turnId, runId: activeRun.runId },
            );
          }
          return { kind: "terminal", terminalEnvelope };
        }
      } else {
      const error: RuntimeError = {
        code: "CONVERSATION_TURN_CLAIM_ORPHANED",
        message: `Conversation turn '${input.turnId}' references a missing active run.`,
        details: { turnId: input.turnId, runId: activeRunId },
      };
      const terminalEnvelope: ConversationTurnTerminalEnvelopeV1 = {
        version: "v1",
        turnRequestIdentity: storedTurnIdentity ?? input.turnRequestIdentity,
        terminalSubmissionIdentity: asString(existingClaim?.submissionIdentity) ?? input.submissionIdentity,
        runId: activeRunId ?? input.proposedRunId,
        status: "FAILED",
        handoff: { state: "failed", finalizationError: error },
      };
      const now = new Date().toISOString();
      this.conversationTurns.set(input.turnId, {
        ...existing,
        status: "FAILED",
        terminalRunId: activeRunId,
        terminalStatus: "FAILED",
        completedAt: now,
        updatedAt: now,
        metadata: {
          ...(existing.metadata ?? {}),
          terminalEnvelope,
        },
      });
      await this.orchestrationStore.upsertThread({
        ...thread,
        status: "FAILED",
        activeRunId: undefined,
        currentRequestId: undefined,
        waitFor: undefined,
        lastRunStatus: "FAILED",
        metadata: {
          ...(thread.metadata ?? {}),
          terminalEnvelope,
        },
        updatedAt: now,
      });
      if (activeRunId !== undefined) {
        await this.releaseRunLease(activeRunId, input.sessionId);
      }
      return { kind: "terminal", terminalEnvelope };
      }
    }
    if (session.activeRunId !== undefined && session.activeRunId !== input.proposedRunId) {
      return { kind: "already_running", runId: session.activeRunId };
    }

    const now = input.startedAt;
    session.activeRunId = input.proposedRunId;
    session.updatedAt = now;
    this.runs.set(input.proposedRunId, {
      runId: input.proposedRunId,
      sessionId: input.sessionId,
      status: "RUNNING",
      eventType: input.eventType,
      startedAt: now,
      completedAt: undefined,
      error: undefined,
      ...(this.tenantId === undefined ? {} : { tenantId: this.tenantId }),
      tenantOwnershipState: this.tenantId === undefined ? "explicit_unbound" : "tenant_bound",
    });
    const rootRunId = existing?.rootRunId ?? input.proposedRunId;
    this.conversationTurns.set(input.turnId, {
      turnId: input.turnId,
      threadId: input.threadId,
      sessionId: input.sessionId,
      rootRunId,
      status: "RUNNING",
      initialEventType: existing?.initialEventType ?? input.eventType,
      activeRunId: input.proposedRunId,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.segment.metadata ?? {}),
        executionClaim: {
          turnRequestIdentity: input.turnRequestIdentity,
          submissionIdentity: input.submissionIdentity,
          submissionKind: input.submissionKind,
        },
        suspensionEnvelope: undefined,
        terminalEnvelope: undefined,
      },
    });
    this.conversationTurnSegments.set(input.segment.segmentId, {
      ...input.segment,
      runId: input.proposedRunId,
      metadata: {
        ...(input.segment.metadata ?? {}),
        submissionIdentity: input.submissionIdentity,
        submissionKind: input.submissionKind,
      },
    });
    await this.orchestrationStore.upsertThread({
      ...thread,
      status: "RUNNING",
      activeRunId: input.proposedRunId,
      currentRequestId: undefined,
      lastRunStatus: "RUNNING",
      waitFor: undefined,
      metadata: {
        ...(thread.metadata ?? {}),
        ...(input.segment.metadata ?? {}),
        activeTurnId: input.turnId,
        executionClaim: {
          turnRequestIdentity: input.turnRequestIdentity,
          submissionIdentity: input.submissionIdentity,
          submissionKind: input.submissionKind,
        },
        suspensionEnvelope: undefined,
        terminalEnvelope: undefined,
      },
      updatedAt: now,
    });
    this.operationLog.push(`claimConversationTurnExecution:${input.turnId}:${input.proposedRunId}`);
    return { kind: "claimed", runId: input.proposedRunId };
  }

  async updateConversationTurnTerminalEnvelope(
    input: UpdateConversationTurnTerminalEnvelopeInput,
  ): Promise<boolean> {
    const turn = this.conversationTurns.get(input.turnId);
    const currentEnvelope = readTerminalEnvelope(turn?.metadata);
    const currentClaim = asRecord(turn?.metadata?.executionClaim);
    if (
      turn === undefined ||
      turn.terminalRunId !== input.runId ||
      asString(currentClaim?.submissionIdentity) !== input.terminalSubmissionIdentity ||
      currentEnvelope?.runId !== input.runId ||
      currentEnvelope.handoff.state !== "pending" ||
      input.envelope.runId !== input.runId ||
      input.envelope.terminalSubmissionIdentity !== input.terminalSubmissionIdentity
    ) {
      return false;
    }
    const updatedAt = new Date().toISOString();
    this.conversationTurns.set(input.turnId, {
      ...turn,
      metadata: {
        ...(turn.metadata ?? {}),
        terminalEnvelope: input.envelope,
      },
      updatedAt,
    });
    await this.orchestrationStore.updateTerminalEnvelope({
      threadId: turn.threadId,
      turnId: input.turnId,
      runId: input.runId,
      envelope: input.envelope,
      updatedAt,
    });
    return true;
  }

  async upsertConversationTurn(record: ConversationTurnRecord): Promise<void> {
    this.conversationTurns.set(record.turnId, structuredClone(record));
  }

  async appendConversationTurnSegment(record: ConversationTurnSegmentRecord): Promise<void> {
    if (this.conversationTurnSegments.has(record.segmentId) === false) {
      this.conversationTurnSegments.set(record.segmentId, structuredClone(record));
    }
  }

  async getConversationTurn(turnId: string): Promise<ConversationTurnRecord | null> {
    const value = this.conversationTurns.get(turnId);
    return value === undefined ? null : structuredClone(value);
  }

  async listConversationTurns(input: {
    threadId?: string | undefined;
    sessionId?: string | undefined;
    status?: ConversationTurnRecord["status"] | undefined;
    completedAfter?: { completedAt: string; turnId: string } | undefined;
    terminalMessagesOnly?: boolean | undefined;
    terminalOutcomesOnly?: boolean | undefined;
    limit?: number | undefined;
  } = {}): Promise<ConversationTurnRecord[]> {
    const filtered = [...this.conversationTurns.values()]
      .filter((record) => input.threadId === undefined || record.threadId === input.threadId)
      .filter((record) => input.sessionId === undefined || record.sessionId === input.sessionId)
      .filter((record) => input.status === undefined || record.status === input.status)
      .filter((record) => {
        if (input.terminalMessagesOnly !== true) return true;
        const envelope = record.metadata?.terminalEnvelope;
        if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return false;
        const handoff = (envelope as Record<string, unknown>).handoff;
        if (typeof handoff !== "object" || handoff === null || Array.isArray(handoff)) return false;
        const value = handoff as Record<string, unknown>;
        return record.status === "COMPLETED"
          && record.completedAt !== undefined
          && value.state === "delivered"
          && typeof value.assistantText === "string"
          && value.assistantText.trim().length > 0;
      })
      .filter((record) => {
        if (input.terminalOutcomesOnly !== true) return true;
        if (
          (record.status !== "COMPLETED" && record.status !== "FAILED")
          || record.completedAt === undefined
        ) return false;
        const envelope = record.metadata?.terminalEnvelope;
        if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return false;
        const handoff = (envelope as Record<string, unknown>).handoff;
        if (typeof handoff !== "object" || handoff === null || Array.isArray(handoff)) return false;
        const state = (handoff as Record<string, unknown>).state;
        return state === "delivered" || state === "failed";
      })
      .filter((record) => {
        if (input.completedAfter === undefined || record.completedAt === undefined) return input.completedAfter === undefined;
        return record.completedAt > input.completedAfter.completedAt
          || (record.completedAt === input.completedAfter.completedAt && record.turnId > input.completedAfter.turnId);
      });
    const ascending = input.completedAfter !== undefined;
    return filtered
      .sort((left, right) => {
        if (
          input.terminalMessagesOnly !== true
          && input.terminalOutcomesOnly !== true
          && input.completedAfter === undefined
        ) {
          return right.updatedAt.localeCompare(left.updatedAt) || left.turnId.localeCompare(right.turnId);
        }
        const leftAt = left.completedAt ?? left.updatedAt;
        const rightAt = right.completedAt ?? right.updatedAt;
        const ordered = leftAt.localeCompare(rightAt) || left.turnId.localeCompare(right.turnId);
        return ascending ? ordered : -ordered;
      })
      .slice(0, input.limit ?? Number.MAX_SAFE_INTEGER)
      .map((record) => structuredClone(record));
  }

  async listConversationTurnSegments(turnId: string): Promise<ConversationTurnSegmentRecord[]> {
    return [...this.conversationTurnSegments.values()]
      .filter((record) => record.turnId === turnId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((record) => structuredClone(record));
  }

  async upsertThread(thread: Parameters<InMemoryOrchestrationStore["upsertThread"]>[0]): Promise<void> {
    return this.orchestrationStore.upsertThread(thread);
  }

  async updateThreadAfterRun(
    input: Parameters<InMemoryOrchestrationStore["updateThreadAfterRun"]>[0],
  ): Promise<boolean> {
    return this.orchestrationStore.updateThreadAfterRun(input);
  }

  async getThread(threadId: string) {
    return this.orchestrationStore.getThread(threadId);
  }

  async listThreads(input?: Parameters<InMemoryOrchestrationStore["listThreads"]>[0]) {
    return this.orchestrationStore.listThreads(input);
  }

  async upsertDelegation(record: Parameters<InMemoryOrchestrationStore["upsertDelegation"]>[0]): Promise<void> {
    return this.orchestrationStore.upsertDelegation(record);
  }

  async createDialog(record: Parameters<InMemoryOrchestrationStore["createDialog"]>[0]): Promise<boolean> {
    return this.orchestrationStore.createDialog(record);
  }

  async compareAndSetDialog(
    record: Parameters<InMemoryOrchestrationStore["compareAndSetDialog"]>[0],
    expectedRevision: Parameters<InMemoryOrchestrationStore["compareAndSetDialog"]>[1],
  ): Promise<boolean> {
    return this.orchestrationStore.compareAndSetDialog(record, expectedRevision);
  }

  async getDelegation(delegationId: string) {
    return this.orchestrationStore.getDelegation(delegationId);
  }

  async getDelegationByChildThreadId(childThreadId: string) {
    return this.orchestrationStore.getDelegationByChildThreadId(childThreadId);
  }

  async listDelegations(input?: Parameters<InMemoryOrchestrationStore["listDelegations"]>[0]) {
    return this.orchestrationStore.listDelegations(input);
  }

  async upsertInteractionRequest(
    record: Parameters<InMemoryOrchestrationStore["upsertInteractionRequest"]>[0],
  ): Promise<void> {
    return this.orchestrationStore.upsertInteractionRequest(record);
  }

  async getInteractionRequest(requestId: string) {
    return this.orchestrationStore.getInteractionRequest(requestId);
  }

  async listInteractionRequests(input?: Parameters<InMemoryOrchestrationStore["listInteractionRequests"]>[0]) {
    return this.orchestrationStore.listInteractionRequests(input);
  }

  async upsertApprovalGrant(record: Parameters<InMemoryOrchestrationStore["upsertApprovalGrant"]>[0]): Promise<void> {
    return this.orchestrationStore.upsertApprovalGrant(record);
  }

  async listApprovalGrants(input?: Parameters<InMemoryOrchestrationStore["listApprovalGrants"]>[0]) {
    return this.orchestrationStore.listApprovalGrants(input);
  }

  async upsertContextCheckpoint(
    record: Parameters<InMemoryOrchestrationStore["upsertContextCheckpoint"]>[0],
  ): Promise<void> {
    return this.orchestrationStore.upsertContextCheckpoint(record);
  }

  async getContextCheckpoint(checkpointId: string) {
    return this.orchestrationStore.getContextCheckpoint(checkpointId);
  }

  async listContextCheckpoints(input?: Parameters<InMemoryOrchestrationStore["listContextCheckpoints"]>[0]) {
    return this.orchestrationStore.listContextCheckpoints(input);
  }

  async upsertOperatorFocus(
    record: Parameters<InMemoryOrchestrationStore["upsertOperatorFocus"]>[0],
  ): Promise<void> {
    return this.orchestrationStore.upsertOperatorFocus(record);
  }

  async getOperatorFocus(sessionId: string) {
    return this.orchestrationStore.getOperatorFocus(sessionId);
  }

  async upsertOperatorAttention(
    record: Parameters<InMemoryOrchestrationStore["upsertOperatorAttention"]>[0],
  ): Promise<void> {
    return this.orchestrationStore.upsertOperatorAttention(record);
  }

  async getOperatorAttention(attentionId: string) {
    return this.orchestrationStore.getOperatorAttention(attentionId);
  }

  async listOperatorAttention(input?: Parameters<InMemoryOrchestrationStore["listOperatorAttention"]>[0]) {
    return this.orchestrationStore.listOperatorAttention(input);
  }

  async saveContextSummaryArtifact(
    record: Parameters<InMemoryOrchestrationStore["saveContextSummaryArtifact"]>[0],
  ): Promise<void> {
    return this.orchestrationStore.saveContextSummaryArtifact(record);
  }

  async listContextSummaryArtifacts(threadId: string) {
    return this.orchestrationStore.listContextSummaryArtifacts(threadId);
  }

  async appendThreadCompactionEvent(
    record: Parameters<InMemoryOrchestrationStore["appendThreadCompactionEvent"]>[0],
  ): Promise<void> {
    return this.orchestrationStore.appendThreadCompactionEvent(record);
  }

  async listThreadCompactionEvents(threadId: string) {
    return this.orchestrationStore.listThreadCompactionEvents(threadId);
  }

  async upsertAssemblyBundle(record: Parameters<InMemoryOrchestrationStore["upsertAssemblyBundle"]>[0]): Promise<void> {
    return this.orchestrationStore.upsertAssemblyBundle(record);
  }

  async getAssemblyBundle(bundleId: string) {
    return this.orchestrationStore.getAssemblyBundle(bundleId);
  }

  async listAssemblyBundles(input?: Parameters<InMemoryOrchestrationStore["listAssemblyBundles"]>[0]) {
    return this.orchestrationStore.listAssemblyBundles(input);
  }

  async appendThreadAssemblyRecord(
    record: Parameters<InMemoryOrchestrationStore["appendThreadAssemblyRecord"]>[0],
  ): ReturnType<InMemoryOrchestrationStore["appendThreadAssemblyRecord"]> {
    return this.orchestrationStore.appendThreadAssemblyRecord(record);
  }

  async listThreadAssemblyRecords(threadId: string) {
    return this.orchestrationStore.listThreadAssemblyRecords(threadId);
  }

  async upsertAssemblyChangeProposal(
    record: Parameters<InMemoryOrchestrationStore["upsertAssemblyChangeProposal"]>[0],
  ): Promise<void> {
    return this.orchestrationStore.upsertAssemblyChangeProposal(record);
  }

  async getAssemblyChangeProposal(proposalId: string) {
    return this.orchestrationStore.getAssemblyChangeProposal(proposalId);
  }

  async listAssemblyChangeProposals(
    input?: Parameters<InMemoryOrchestrationStore["listAssemblyChangeProposals"]>[0],
  ) {
    return this.orchestrationStore.listAssemblyChangeProposals(input);
  }

  async appendAssemblyChangeDecision(
    record: Parameters<InMemoryOrchestrationStore["appendAssemblyChangeDecision"]>[0],
  ): Promise<void> {
    return this.orchestrationStore.appendAssemblyChangeDecision(record);
  }

  async listAssemblyChangeDecisions(
    input?: Parameters<InMemoryOrchestrationStore["listAssemblyChangeDecisions"]>[0],
  ) {
    return this.orchestrationStore.listAssemblyChangeDecisions(input);
  }

  async upsertSpecialistDefinition(
    record: Parameters<InMemoryOrchestrationStore["upsertSpecialistDefinition"]>[0],
  ): Promise<void> {
    return this.orchestrationStore.upsertSpecialistDefinition(record);
  }

  async listSpecialistDefinitions() {
    return this.orchestrationStore.listSpecialistDefinitions();
  }

  async upsertContextPolicyDefinition(
    record: Parameters<InMemoryOrchestrationStore["upsertContextPolicyDefinition"]>[0],
  ): Promise<void> {
    return this.orchestrationStore.upsertContextPolicyDefinition(record);
  }

  async getContextPolicyDefinition(contextPolicyId: string) {
    return this.orchestrationStore.getContextPolicyDefinition(contextPolicyId);
  }

  async listContextPolicyDefinitions() {
    return this.orchestrationStore.listContextPolicyDefinitions();
  }

  async appendLegacyArchive(archive: LegacySessionArchive): Promise<void> {
    this.legacyArchives.push({
      ...archive,
      createdAt: archive.createdAt ?? new Date().toISOString(),
      snapshot: { ...archive.snapshot },
    });
    this.operationLog.push(`legacyArchived:${archive.sessionId}`);
  }

  async completeRun(
    runId: string,
    status: TransitionStatus,
    error?: RuntimeError,
    settlement?: RunLifecycleSettlement,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (run !== undefined) {
      const now = new Date().toISOString();
      const turn = [...this.conversationTurns.values()].find((record) => record.activeRunId === runId);
      const thread = turn === undefined
        ? null
        : await this.orchestrationStore.getThread(turn.threadId);
      if (
        turn !== undefined &&
        (
          thread === null ||
          thread.activeRunId !== runId ||
          asString(asRecord(turn.metadata?.executionClaim)?.turnRequestIdentity) === undefined ||
          asString(asRecord(turn.metadata?.executionClaim)?.submissionIdentity) === undefined
        )
      ) {
        throw createRuntimeFailure(
          "STORE_THREAD_SETTLEMENT_CONFLICT",
          `Run '${runId}' no longer owns its conversation turn and thread.`,
          { runId, turnId: turn.turnId },
        );
      }
      if (turn !== undefined && status === "WAITING" && settlement?.wait === undefined) {
        throw createRuntimeFailure(
          "STORE_WAIT_SETTLEMENT_REQUIRED",
          `Run '${runId}' cannot enter WAITING without a canonical wait settlement.`,
          { runId, turnId: turn.turnId },
        );
      }
      run.status = status;
      run.completedAt = now;
      run.error = error;
      if (turn !== undefined) {
        const claim = asRecord(turn.metadata?.executionClaim) ?? {};
        if (status === "WAITING" && settlement?.wait !== undefined) {
          const suspensionEnvelope = {
            version: "v1" as const,
            turnRequestIdentity: asString(claim.turnRequestIdentity) ?? "",
            submissionIdentity: asString(claim.submissionIdentity) ?? "",
            runId,
            wait: settlement.wait,
          };
          this.conversationTurns.set(turn.turnId, {
            ...turn,
            status: "WAITING",
            updatedAt: now,
            metadata: {
              ...(turn.metadata ?? {}),
              suspensionEnvelope,
            },
          });
          if (thread !== null) {
            await this.orchestrationStore.upsertThread({
              ...thread,
              status: "WAITING",
              currentRequestId: undefined,
              lastRunStatus: "WAITING",
              waitFor: {
                kind: settlement.wait.kind,
                eventType: settlement.wait.eventType,
                ...(settlement.wait.timeoutMs !== undefined
                  ? { timeoutMs: settlement.wait.timeoutMs }
                  : {}),
                ...(settlement.wait.metadata !== undefined
                  ? { metadata: settlement.wait.metadata }
                  : {}),
                ...(settlement.wait.interaction !== undefined
                  ? { interaction: settlement.wait.interaction }
                  : {}),
              },
              metadata: {
                ...(thread.metadata ?? {}),
                suspensionEnvelope,
              },
              updatedAt: now,
            });
          }
        } else if (status === "COMPLETED" || status === "FAILED") {
          const terminalEnvelope: ConversationTurnTerminalEnvelopeV1 = {
            version: "v1",
            turnRequestIdentity: asString(claim.turnRequestIdentity) ?? "",
            terminalSubmissionIdentity: asString(claim.submissionIdentity) ?? "",
            runId,
            status,
            handoff: { state: "pending" },
          };
          this.conversationTurns.set(turn.turnId, {
            ...turn,
            status,
            activeRunId: undefined,
            terminalRunId: runId,
            terminalStatus: status,
            completedAt: now,
            updatedAt: now,
            metadata: {
              ...(turn.metadata ?? {}),
              terminalEnvelope,
            },
          });
          if (thread !== null) {
            await this.orchestrationStore.upsertThread({
              ...thread,
              status,
              activeRunId: undefined,
              currentRequestId: undefined,
              waitFor: undefined,
              lastRunStatus: status,
              metadata: {
                ...(thread.metadata ?? {}),
                terminalEnvelope,
              },
              updatedAt: now,
            });
          }
        }
      }
      await this.releaseRunLease(runId, run.sessionId);
    }
    this.operationLog.push(`completeRun:${runId}:${status}`);
  }

  getEffectResults(): EffectResult[] {
    return [...this.effectResults.values()].map((value) => ({ ...value }));
  }

  getRunLogs(): RunLogEntry[] {
    return this.runLogs.map((log) => ({ ...log }));
  }

  getRunEvents(): RunEvent[] {
    return this.runEvents.map((event) => ({ ...event }));
  }

  getEffects(): InMemoryEffect[] {
    return this.effects.map((effect) => ({ ...effect }));
  }

  getRegionWorkItems(): RegionWorkItem[] {
    return this.regionWorkItems.map((item) => ({ ...item }));
  }

  getLegacyArchives(): LegacySessionArchive[] {
    return this.legacyArchives.map((archive) => ({ ...archive, snapshot: { ...archive.snapshot } }));
  }

  seedSession(
    sessionId: string,
    state: Record<string, unknown>,
    currentStepAgent?: string,
  ): void {
    const existing = this.sessions.get(sessionId);
    if (existing === undefined) {
      const now = new Date().toISOString();
      this.sessions.set(sessionId, {
        sessionId,
        version: 0,
        state: normalizeRuntimeStateForPersist({ ...state }),
        currentStepAgent,
        activeRunId: undefined,
        updatedAt: now,
      });
      return;
    }

    existing.state = normalizeRuntimeStateForPersist({ ...state });
    if (currentStepAgent !== undefined) {
      existing.currentStepAgent = currentStepAgent;
    }
    existing.updatedAt = new Date().toISOString();
  }

  private persistProductSnapshot(
    session: SessionRecord,
    snapshot: ProductProjectSnapshot,
    current: InMemoryProductState | undefined,
  ): SessionProductStateRecord {
    const now = new Date().toISOString();
    const product = asRecord(session.state.product) ?? {};
    const next: InMemoryProductState = {
      sessionId: session.sessionId,
      version: current === undefined ? 1 : current.version + 1,
      projectSnapshot: normalizeProjectSnapshot(snapshot, snapshot.graphVersion),
      taskGraph: current?.taskGraph ?? asRecord(product.taskGraph) ?? {},
      workspaceCheckpointState: current?.workspaceCheckpointState ?? asRecord(product.workspaceCheckpointState) ?? {},
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.productStates.set(session.sessionId, next);
    return this.mapProductState(next);
  }

  private mapProductState(state: InMemoryProductState): SessionProductStateRecord {
    return {
      sessionId: state.sessionId,
      version: state.version,
      projectSnapshot: normalizeProjectSnapshot(state.projectSnapshot, state.projectSnapshot.graphVersion),
      taskGraph: { ...state.taskGraph },
      workspaceCheckpointState: { ...state.workspaceCheckpointState },
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  }

  private mapRun(run: InMemoryRun): PersistedRunRecord {
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      eventType: run.eventType,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
      ...(run.error !== undefined ? { error: run.error } : {}),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertReplayableSandboxCapabilityEffectBinding(
  lease: SandboxCapabilityLeaseTransitionRecordV1 | undefined,
  input: {
    bindingDigest: string;
    toolCallId: string;
    runId: string;
    sessionId: string;
    result: EffectResult;
  },
): asserts lease is SandboxCapabilityLeaseTransitionRecordV1 {
  const completedProviderAction = lease !== undefined &&
    lease.terminalOutcome === "completed" &&
    lease.result !== undefined &&
    (lease.transition === "consumed" || lease.transition === "exhausted" || lease.transition === "cleaned");
  const completedUnusedCapability = lease !== undefined &&
    ((lease.transition === "issued" && lease.terminalOutcome === undefined && lease.terminalReason === undefined) ||
      (lease.transition === "cleaned" && lease.terminalOutcome === "failed" && lease.terminalReason === "container_teardown_completed")) &&
    lease.result === undefined &&
    lease.usage.requestsConsumed === 0 &&
    lease.usage.responseBytesConsumed === 0 &&
    lease.usage.exactProviderUsage === null;
  if (
    lease === undefined ||
    lease.bindingDigest !== input.bindingDigest ||
    lease.binding.toolCallId !== input.toolCallId ||
    lease.binding.runId !== input.runId ||
    lease.binding.sessionId !== input.sessionId ||
    input.result.idempotencyKey !== input.toolCallId ||
    input.result.status !== "DONE" ||
    (!completedProviderAction && !completedUnusedCapability)
  ) {
    throw new Error("Sandbox capability effect result is not bound to a completed exact lease action");
  }
}

function readMissionControlRunCorrelation(value: unknown) {
  const record = asRecord(value);
  const projectId = asString(record?.projectId);
  const itemId = asString(record?.itemId);
  const attemptId = asString(record?.attemptId);
  const commandId = asString(record?.commandId);
  const runId = asString(record?.runId);
  if (
    projectId === undefined ||
    itemId === undefined ||
    attemptId === undefined ||
    commandId === undefined ||
    runId === undefined
  ) {
    return;
  }
  return { projectId, itemId, attemptId, commandId, runId };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function hasPreparedApprovalCleanupMarker(value: unknown): boolean {
  const marker = asRecord(value)?.preparedApprovalCleanup;
  if (marker === undefined) return false;
  try {
    parseRunnerPreparedApprovalCleanupV1(marker);
    return true;
  } catch {
    return false;
  }
}

function readTerminalEnvelope(
  metadata: Record<string, unknown> | undefined,
): ConversationTurnTerminalEnvelopeV1 | undefined {
  const value = asRecord(metadata?.terminalEnvelope);
  const handoff = asRecord(value?.handoff);
  const status = value?.status;
  if (
    value?.version !== "v1" ||
    asString(value.turnRequestIdentity) === undefined ||
    asString(value.terminalSubmissionIdentity) === undefined ||
    asString(value.runId) === undefined ||
    (status !== "COMPLETED" && status !== "FAILED") ||
    (
      handoff?.state !== "pending" &&
      handoff?.state !== "delivered" &&
      handoff?.state !== "failed"
    )
  ) {
    return ;
  }
  return structuredClone(value) as unknown as ConversationTurnTerminalEnvelopeV1;
}
