import type { EffectExecutionStatus, RuntimeError, TransitionStatus } from "../../src/kestrel/contracts/base.js";
import type { RunEvent, RunLogEntry, RuntimeEvent } from "../../src/kestrel/contracts/events.js";
import type { EffectResult, RegionWorkIntent, RegionWorkItem } from "../../src/kestrel/contracts/execution.js";
import type { ConversationTurnRecord, ConversationTurnSegmentRecord, ModelCallProvenanceRecord } from "../../src/kestrel/contracts/orchestration.js";
import type { CommitStepInput, CommitStepResult, LegacySessionArchive, OutboxEventRecord, PersistedArtifact, PersistedClaim, PersistedRunRecord, PersistedRunStateRecord, PersistedRunSummaryRecord, SessionRecord, SessionStore } from "../../src/kestrel/contracts/store.js";

import {
  normalizeRuntimeStateForPersist,
  validateRuntimeSessionState,
} from "../../src/runtime/state.js";
import {
  buildRuntimeStateDiagnosticMetadata,
  buildRuntimeStatePersistedEvent,
  readInvalidStatePath,
} from "../../src/runtime/stateDiagnostics.js";
import { InMemoryOrchestrationStore } from "../../src/orchestration/InMemoryOrchestrationStore.js";

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

interface InMemoryRun {
  runId: string;
  sessionId: string;
  status: TransitionStatus;
  eventType: string;
  startedAt: string;
  completedAt: string | undefined;
  error: RuntimeError | undefined;
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
}

interface InMemoryRegionWorkItem extends RegionWorkItem {
  error?: Record<string, unknown> | undefined;
}

export class InMemorySessionStore implements SessionStore {
  private readonly orchestrationStore = new InMemoryOrchestrationStore();
  private readonly sessions = new Map<string, InMemorySession>();
  private readonly runs = new Map<string, InMemoryRun>();
  private readonly effects: InMemoryEffect[] = [];
  private readonly effectResults = new Map<string, EffectResult>();
  private readonly outboxEvents: OutboxEventRecord[] = [];
  private readonly runLogs: RunLogEntry[] = [];
  private readonly runEvents: RunEvent[] = [];
  private readonly artifacts: PersistedArtifact[] = [];
  private readonly claims: PersistedClaim[] = [];
  private readonly regionWorkItems: InMemoryRegionWorkItem[] = [];
  private readonly legacyArchives: LegacySessionArchive[] = [];
  private readonly sessionVersions: InMemorySessionVersion[] = [];
  private readonly conversationTurns = new Map<string, ConversationTurnRecord>();
  private readonly conversationTurnSegments: ConversationTurnSegmentRecord[] = [];
  private readonly modelCallProvenance = new Map<string, ModelCallProvenanceRecord>();
  private outboxIdCounter = 1;
  private regionWorkItemIdCounter = 1;

  readonly operationLog: string[] = [];

  getSessionVersionRecordsForTest(sessionId: string): InMemorySessionVersion[] {
    return this.sessionVersions
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => structuredClone(entry));
  }

  unsafeOverwriteSessionStateForTest(input: {
    sessionId: string;
    version?: number | undefined;
    currentStepAgent?: string | undefined;
    state: Record<string, unknown>;
  }): void {
    const existing = this.sessions.get(input.sessionId);
    if (existing === undefined) {
      throw new Error(`Unknown session ${input.sessionId}`);
    }
    existing.state = structuredClone(input.state);
    if (input.version !== undefined) {
      existing.version = input.version;
    }
    if (input.currentStepAgent !== undefined) {
      existing.currentStepAgent = input.currentStepAgent;
    }
    existing.updatedAt = new Date().toISOString();
  }

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
      return {
        run,
        eventCount: events.length,
        ...(threadId !== undefined ? { threadId } : {}),
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
      const error = new Error(`Unknown session ${input.sessionId}`) as Error & {
        code: string;
        details: Record<string, unknown>;
      };
      error.code = "STORE_SESSION_NOT_FOUND";
      error.details = { sessionId: input.sessionId };
      throw error;
    }
    if (input.expectedVersion !== undefined && session.version !== input.expectedVersion) {
      const error = new Error(
        `Version conflict for session ${input.sessionId}; expected=${input.expectedVersion} actual=${session.version}`,
      ) as Error & {
        code: string;
        details: Record<string, unknown>;
      };
      error.code = "SESSION_VERSION_CONFLICT";
      error.details = {
        sessionId: input.sessionId,
        expectedVersion: input.expectedVersion,
        actualVersion: session.version,
      };
      throw error;
    }

    const nextState = normalizeRuntimeStateForPersist({
      ...session.state,
      ...input.statePatch,
    });
    const validationError = validateRuntimeSessionState(nextState);
    if (validationError !== undefined) {
      const error = new Error(validationError.message) as Error & {
        code: string;
        details: Record<string, unknown>;
      };
      error.code = validationError.code;
      error.details = { sessionId: input.sessionId };
      throw error;
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
      currentStepAgent: session.currentStepAgent,
      updatedAt: session.updatedAt,
    };
  }

  async acquireRunLease(runId: string, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    if (session.activeRunId !== undefined && session.activeRunId !== runId) {
      const error = new Error(`Session '${sessionId}' already has an active run.`) as Error & {
        code: string;
        details: Record<string, unknown>;
      };
      error.code = "SESSION_BUSY";
      error.details = {
        sessionId,
        activeRunId: session.activeRunId,
      };
      throw error;
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
    });
    this.operationLog.push(`startRun:${runId}`);
  }

  async commitStep(input: CommitStepInput): Promise<CommitStepResult> {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      throw new Error(`Unknown session ${input.sessionId}`);
    }

    if (session.version !== input.expectedVersion) {
      throw new Error(
        `Version conflict expected=${input.expectedVersion} actual=${session.version}`,
      );
    }

    const nextState = normalizeRuntimeStateForPersist({
      ...session.state,
      ...(input.statePatch ?? {}),
    });
    const validationError = validateRuntimeSessionState(nextState);
    if (validationError !== undefined) {
      const error = new Error(validationError.message) as Error & {
        code: string;
        details: Record<string, unknown>;
      };
      error.code = validationError.code;
      const invalidStatePath = readInvalidStatePath(validationError);
      error.details = {
        sessionId: input.sessionId,
        runId: input.runId,
        expectedVersion: input.expectedVersion,
        ...(invalidStatePath !== undefined ? { invalidStatePath } : {}),
        runtimeStateDiagnostic: buildRuntimeStateDiagnosticMetadata({
          sessionId: input.sessionId,
          runId: input.runId,
          version: session.version + 1,
          expectedVersion: input.expectedVersion,
          stepAgent: input.stepAgent,
          nextStepAgent: input.nextStepAgent,
          stepIndex: input.stepIndex,
          state: nextState,
          statePatch: input.statePatch,
        }),
      };
      throw error;
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
    await this.appendRunEventsBatch([
      ...(input.runEvents ?? []),
      buildRuntimeStatePersistedEvent({
        sessionId: input.sessionId,
        runId: input.runId,
        version: session.version,
        expectedVersion: input.expectedVersion,
        snapshotKind: shouldPersistFullSnapshot ? "full" : "delta",
        stepAgent: input.stepAgent,
        nextStepAgent: input.nextStepAgent,
        stepIndex: input.stepIndex,
        state: session.state,
        statePatch: input.statePatch,
      }),
    ]);

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
      .filter((effect) => effect.sessionId === sessionId && effect.status === "PENDING")
      .map((effect) => ({ ...effect }));
  }

  async getEffectResult(idempotencyKey: string): Promise<EffectResult | null> {
    const result = this.effectResults.get(idempotencyKey);
    if (result === undefined) {
      return null;
    }
    return { ...result };
  }

  async saveEffectResult(_runId: string, _sessionId: string, result: EffectResult): Promise<void> {
    if (this.effectResults.has(result.idempotencyKey)) {
      return;
    }

    this.effectResults.set(result.idempotencyKey, { ...result });
    this.operationLog.push(`saveEffectResult:${result.idempotencyKey}:${result.status}`);
  }

  async markEffectStatus(idempotencyKey: string, status: EffectExecutionStatus): Promise<void> {
    for (const effect of this.effects) {
      if (effect.idempotencyKey === idempotencyKey) {
        effect.status = status;
      }
    }
    this.operationLog.push(`markEffectStatus:${idempotencyKey}:${status}`);
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

  async upsertConversationTurn(record: ConversationTurnRecord): Promise<void> {
    this.conversationTurns.set(record.turnId, structuredClone(record));
    this.operationLog.push(`upsertConversationTurn:${record.turnId}:${record.status}`);
  }

  async appendConversationTurnSegment(record: ConversationTurnSegmentRecord): Promise<void> {
    if (this.conversationTurnSegments.some((entry) => entry.segmentId === record.segmentId)) {
      return;
    }
    this.conversationTurnSegments.push(structuredClone(record));
    this.operationLog.push(`appendConversationTurnSegment:${record.turnId}:${record.kind}`);
  }

  async getConversationTurn(turnId: string): Promise<ConversationTurnRecord | null> {
    const record = this.conversationTurns.get(turnId);
    return record === undefined ? null : structuredClone(record);
  }

  async listConversationTurns(input: {
    threadId?: string | undefined;
    sessionId?: string | undefined;
    status?: ConversationTurnRecord["status"] | undefined;
    limit?: number | undefined;
  } = {}): Promise<ConversationTurnRecord[]> {
    const filtered = [...this.conversationTurns.values()]
      .filter((record) => input.threadId === undefined || record.threadId === input.threadId)
      .filter((record) => input.sessionId === undefined || record.sessionId === input.sessionId)
      .filter((record) => input.status === undefined || record.status === input.status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const limit = Math.max(0, Math.trunc(input.limit ?? filtered.length));
    return filtered.slice(0, limit).map((record) => structuredClone(record));
  }

  async listConversationTurnSegments(turnId: string): Promise<ConversationTurnSegmentRecord[]> {
    return this.conversationTurnSegments
      .filter((record) => record.turnId === turnId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((record) => structuredClone(record));
  }

  async appendModelCallProvenance(record: ModelCallProvenanceRecord): Promise<void> {
    if (this.modelCallProvenance.has(record.callId)) {
      return;
    }
    this.modelCallProvenance.set(record.callId, structuredClone(record));
    this.operationLog.push(`appendModelCallProvenance:${record.callId}:${record.status}`);
  }

  async updateModelCallProvenance(input: {
    callId: string;
    status: ModelCallProvenanceRecord["status"];
    completedAt: string;
    latencyMs?: number | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<void> {
    const current = this.modelCallProvenance.get(input.callId);
    if (current === undefined) {
      return;
    }
    this.modelCallProvenance.set(input.callId, {
      ...current,
      status: input.status,
      completedAt: input.completedAt,
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      ...(input.metadata !== undefined
        ? { metadata: { ...(current.metadata ?? {}), ...structuredClone(input.metadata) } }
        : {}),
    });
    this.operationLog.push(`updateModelCallProvenance:${input.callId}:${input.status}`);
  }

  async listModelCallProvenance(input: {
    runId?: string | undefined;
    sessionId?: string | undefined;
    turnId?: string | undefined;
    limit?: number | undefined;
  } = {}): Promise<ModelCallProvenanceRecord[]> {
    const filtered = [...this.modelCallProvenance.values()]
      .filter((record) => input.runId === undefined || record.runId === input.runId)
      .filter((record) => input.sessionId === undefined || record.sessionId === input.sessionId)
      .filter((record) => input.turnId === undefined || record.turnId === input.turnId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const limit = Math.max(0, Math.trunc(input.limit ?? filtered.length));
    return filtered.slice(0, limit).map((record) => structuredClone(record));
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
    fromTimestamp?: string | undefined;
    toTimestamp?: string | undefined;
    limit?: number | undefined;
  }): Promise<RunEvent[]> {
    const fromTs = input.fromTimestamp ?? "";
    const toTs = input.toTimestamp ?? "9999-12-31T23:59:59.999Z";
    const limit = input.limit ?? 1000;
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

    return this.runEvents
      .filter((event) => {
        if (input.runId !== undefined && event.runId !== input.runId) {
          return false;
        }
        if (input.sessionId !== undefined && event.sessionId !== input.sessionId) {
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
      })
      .slice(0, limit)
      .map((event) => ({ ...event }));
  }

  async upsertThread(thread: Parameters<InMemoryOrchestrationStore["upsertThread"]>[0]): Promise<void> {
    return this.orchestrationStore.upsertThread(thread);
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
  ): Promise<void> {
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

  async completeRun(runId: string, status: TransitionStatus, error?: RuntimeError): Promise<void> {
    const run = this.runs.get(runId);
    if (run !== undefined) {
      run.status = status;
      run.completedAt = new Date().toISOString();
      run.error = error;
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
