import type {
  EffectExecutionStatus,
  RuntimeError,
  TransitionStatus,
} from "../kestrel/contracts/base.js";
import type {
  RunEvent,
  RunLogEntry,
  RuntimeEvent,
} from "../kestrel/contracts/events.js";
import type {
  CommitStepInput,
  CommitStepResult,
  GetArtifactInput,
  ListArtifactsInput,
  PersistedArtifact,
  PersistedClaim,
  PersistedRunRecord,
  PersistedRunSummaryRecord,
  PersistedRunStateRecord,
  ProviderReasoningEncryptedRecord,
  ProviderReasoningRecordKind,
  OutboxEventRecord,
  PersistedEffect,
  SessionProductStateRecord,
  SessionRecord,
  SessionStore,
  LegacySessionArchive,
} from "../kestrel/contracts/store.js";
import type {
  EffectResult,
  RegionWorkIntent,
  RegionWorkItem,
} from "../kestrel/contracts/execution.js";
import type {
  ApprovalGrantRecord,
  AssemblyBundleRecord,
  AssemblyChangeDecisionRecord,
  AssemblyChangeProposalRecord,
  AssemblyProposalStatus,
  ConversationTurnRecord,
  ConversationTurnSegmentRecord,
  ContextCheckpointRecord,
  ContextPolicyDefinitionRecord,
  ContextSummaryArtifactRecord,
  DelegationRecord,
  InteractionRequestRecord,
  ModelCallProvenanceRecord,
  OperatorAttentionRecord,
  OperatorFocusRecord,
  SpecialistDefinitionRecord,
  ThreadCompactionEventRecord,
  ThreadAssemblyRecord,
  ThreadRecord,
} from "../kestrel/contracts/orchestration.js";
import { SessionBusyError, createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import {
  normalizeRuntimeStateForPersist,
  validateRuntimeSessionState,
} from "../runtime/state.js";
import {
  buildRuntimeStateDiagnosticMetadata,
  buildRuntimeStatePersistedEvent,
  readInvalidStatePath,
} from "../runtime/stateDiagnostics.js";
import { normalizeOptionalTimestampString, normalizeTimestampString } from "../runtime/timestamps.js";
import { stringifySanitizedJson } from "../runtime/jsonSanitizer.js";
import { PostgresOrchestrationStore } from "../orchestration/PostgresOrchestrationStore.js";
import {
  normalizeProjectSnapshot,
  readProjectSnapshotFromRuntimeState,
} from "../project/state.js";
import type { ProductProjectSnapshot } from "../project/contracts.js";

interface QueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

interface PostgresSessionStoreOptions {
  enforceSchemaV3?: boolean | undefined;
}

interface LockedSessionLeaseState {
  sessionId: string;
  activeRunId?: string | undefined;
  state: Record<string, unknown>;
}

interface LockedRunLeaseState {
  runId: string;
  sessionId: string;
  status: TransitionStatus | "RUNNING";
  completedAt?: string | undefined;
  error?: Record<string, unknown> | null | undefined;
}

type ArtifactRow = Record<string, unknown> & {
  artifact_id: string;
  run_id: string;
  session_id: string;
  step_index: number;
  artifact_type: string;
  payload_json: Record<string, unknown>;
  created_at: string;
};

type SessionProductStateRow = Record<string, unknown> & {
  session_id: string;
  version: number;
  project_snapshot_json: Record<string, unknown>;
  task_graph_json: Record<string, unknown>;
  workspace_checkpoint_state_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

function mapProviderReasoningRow(row: Record<string, unknown>): ProviderReasoningEncryptedRecord {
  const kind = row.record_kind;
  if (kind !== "continuation" && kind !== "retained_visible") {
    throw new Error("Invalid provider reasoning record kind");
  }
  return {
    recordId: String(row.record_id),
    kind,
    runId: String(row.run_id),
    sessionId: String(row.session_id),
    turnId: String(row.turn_id),
    retentionScope: String(row.retention_scope),
    provider: String(row.provider),
    model: String(row.model),
    ...(typeof row.reasoning_format === "string" ? { format: row.reasoning_format } : {}),
    ciphertext: String(row.ciphertext),
    iv: String(row.iv),
    authTag: String(row.auth_tag),
    keyVersion: Number(row.key_version),
    createdAt: normalizeTimestampString(row.created_at),
    expiresAt: normalizeTimestampString(row.expires_at),
  };
}

export interface SqlExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  transaction?<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

export class OptimisticConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimisticConcurrencyError";
    (this as Error & { code?: string }).code = "SESSION_VERSION_CONFLICT";
  }
}

export class LegacyReadonlySessionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class PostgresSessionStore implements SessionStore {
  private readonly db: SqlExecutor;
  private readonly enforceSchemaV3: boolean;
  private readonly orchestrationStore: PostgresOrchestrationStore;
  private schemaValidated = false;

  constructor(db: SqlExecutor, options: PostgresSessionStoreOptions = {}) {
    this.db = db;
    this.enforceSchemaV3 = options.enforceSchemaV3 ?? false;
    this.orchestrationStore = new PostgresOrchestrationStore(db);
  }

  async saveProviderReasoningRecord(record: ProviderReasoningEncryptedRecord): Promise<void> {
    await this.ensureSchemaV3();
    const values = [
      record.recordId,
      record.kind,
      record.runId,
      record.sessionId,
      record.turnId,
      record.retentionScope,
      record.provider,
      record.model,
      record.format ?? null,
      record.ciphertext,
      record.iv,
      record.authTag,
      record.keyVersion,
      record.createdAt,
      record.expiresAt,
    ];
    if (record.kind === "continuation") {
      await this.db.query(
        `INSERT INTO provider_reasoning_state (
           record_id, record_kind, run_id, session_id, turn_id, retention_scope, provider, model,
           reasoning_format, ciphertext, iv, auth_tag, key_version, created_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (session_id, turn_id, provider, model)
           WHERE record_kind = 'continuation'
         DO UPDATE SET
           record_id = EXCLUDED.record_id,
           run_id = EXCLUDED.run_id,
           retention_scope = EXCLUDED.retention_scope,
           reasoning_format = EXCLUDED.reasoning_format,
           ciphertext = EXCLUDED.ciphertext,
           iv = EXCLUDED.iv,
           auth_tag = EXCLUDED.auth_tag,
           key_version = EXCLUDED.key_version,
           created_at = EXCLUDED.created_at,
           expires_at = EXCLUDED.expires_at`,
        values,
      );
      return;
    }
    await this.db.query(
      `INSERT INTO provider_reasoning_state (
         record_id, record_kind, run_id, session_id, turn_id, retention_scope, provider, model,
         reasoning_format, ciphertext, iv, auth_tag, key_version, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (record_id) DO NOTHING`,
      values,
    );
  }

  async appendProviderReasoningAccessAudit(record: {
    runId: string;
    sessionId: string;
    actorId: string;
    actorRole: string;
    action: "read" | "delete" | "policy_change";
    metadata?: Record<string, unknown> | undefined;
  }): Promise<void> {
    await this.ensureSchemaV3();
    await this.db.query(
      `INSERT INTO provider_reasoning_access_audit
         (run_id, session_id, actor_id, actor_role, action, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [record.runId, record.sessionId, record.actorId, record.actorRole, record.action, stringifySanitizedJson(record.metadata ?? {})],
    );
  }

  async listProviderReasoningRecords(input: {
    runId?: string | undefined;
    sessionId?: string | undefined;
    turnId?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    kind?: ProviderReasoningRecordKind | undefined;
    includeExpired?: boolean | undefined;
  }): Promise<ProviderReasoningEncryptedRecord[]> {
    await this.ensureSchemaV3();
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT record_id, record_kind, run_id, session_id, turn_id, retention_scope, provider, model,
              reasoning_format, ciphertext, iv, auth_tag, key_version, created_at, expires_at
         FROM provider_reasoning_state
        WHERE ($1::text IS NULL OR run_id = $1)
          AND ($2::text IS NULL OR session_id = $2)
          AND ($3::text IS NULL OR turn_id = $3)
          AND ($4::text IS NULL OR provider = $4)
          AND ($5::text IS NULL OR model = $5)
          AND ($6::text IS NULL OR record_kind = $6)
          AND ($7::boolean = TRUE OR expires_at > NOW())
        ORDER BY created_at ASC`,
      [
        input.runId ?? null,
        input.sessionId ?? null,
        input.turnId ?? null,
        input.provider ?? null,
        input.model ?? null,
        input.kind ?? null,
        input.includeExpired === true,
      ],
    );
    return result.rows.map(mapProviderReasoningRow);
  }

  async deleteProviderReasoningRecords(input: {
    runId?: string | undefined;
    sessionId?: string | undefined;
    turnId?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    kind?: ProviderReasoningRecordKind | undefined;
  }): Promise<number> {
    await this.ensureSchemaV3();
    if (input.runId === undefined && input.sessionId === undefined && input.turnId === undefined) {
      throw new Error("Provider reasoning deletion requires runId, sessionId, or turnId");
    }
    const result = await this.db.query(
      `DELETE FROM provider_reasoning_state
        WHERE ($1::text IS NULL OR run_id = $1)
          AND ($2::text IS NULL OR session_id = $2)
          AND ($3::text IS NULL OR turn_id = $3)
          AND ($4::text IS NULL OR provider = $4)
          AND ($5::text IS NULL OR model = $5)
          AND ($6::text IS NULL OR record_kind = $6)`,
      [
        input.runId ?? null,
        input.sessionId ?? null,
        input.turnId ?? null,
        input.provider ?? null,
        input.model ?? null,
        input.kind ?? null,
      ],
    );
    return result.rowCount;
  }

  async purgeExpiredProviderReasoning(now = new Date().toISOString()): Promise<number> {
    await this.ensureSchemaV3();
    const result = await this.db.query(
      "DELETE FROM provider_reasoning_state WHERE expires_at <= $1",
      [now],
    );
    return result.rowCount;
  }

  async applyProviderReasoningRetentionPolicy(input: {
    retentionScope: string;
    mode: "live_only" | "provider_visible";
    expiresAt: string;
  }): Promise<number> {
    await this.ensureSchemaV3();
    const result = input.mode === "live_only"
      ? await this.db.query(
          `DELETE FROM provider_reasoning_state
            WHERE retention_scope = $1 AND record_kind = 'retained_visible'`,
          [input.retentionScope],
        )
      : await this.db.query(
          `UPDATE provider_reasoning_state
              SET expires_at = LEAST(expires_at, $2::timestamptz)
            WHERE retention_scope = $1
              AND record_kind = 'retained_visible'
              AND expires_at > $2::timestamptz`,
          [input.retentionScope, input.expiresAt],
        );
    return result.rowCount;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    await this.ensureSchemaV3();
    const result = await this.db.query<{
      session_id: string;
      current_version: number;
      current_step_agent: string | null;
      updated_at: unknown;
      current_state_json: Record<string, unknown> | null;
      legacy_readonly?: boolean;
    }>(
      `SELECT session_id, current_version, current_step_agent, updated_at, current_state_json, legacy_readonly
         FROM sessions
        WHERE session_id = $1`,
      [sessionId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }

    return this.buildSessionRecord(row);
  }

  async getSessionProductState(sessionId: string): Promise<SessionProductStateRecord | null> {
    await this.ensureSchemaV3();
    const result = await this.db.query<SessionProductStateRow>(
      `SELECT session_id, version, project_snapshot_json, task_graph_json, workspace_checkpoint_state_json, created_at, updated_at
         FROM session_product_state
        WHERE session_id = $1`,
      [sessionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.mapSessionProductStateRow(row);
  }

  async updateSessionProjectSnapshot(input: {
    sessionId: string;
    graphVersion?: ProductProjectSnapshot["graphVersion"] | undefined;
    reason?: string | undefined;
    apply: (snapshot: ProductProjectSnapshot) => ProductProjectSnapshot | Promise<ProductProjectSnapshot>;
  }): Promise<SessionProductStateRecord> {
    await this.ensureSchemaV3();
    return this.withTransaction(async (executor) => {
      const session = await this.getSessionForUpdate(input.sessionId, executor);
      if (session === null) {
        throw createRuntimeFailure("STORE_SESSION_NOT_FOUND", `Session does not exist: ${input.sessionId}.`, {
          sessionId: input.sessionId,
        });
      }
      if (session.legacyReadonly === true) {
        throw new LegacyReadonlySessionError(
          `Session ${input.sessionId} is legacy_readonly and cannot be mutated`,
        );
      }
      const current = await this.getSessionProductStateRowForUpdate(input.sessionId, executor);
      const graphVersion = input.graphVersion ?? 1;
      const baseSnapshot = current === null
        ? readProjectSnapshotFromRuntimeState(session.state, graphVersion)
        : normalizeProjectSnapshot(current.project_snapshot_json, graphVersion);
      const applied = await input.apply(baseSnapshot);
      const nextSnapshot = normalizeProjectSnapshot(applied, input.graphVersion ?? applied.graphVersion);
      return this.persistSessionProjectSnapshotWithExecutor({
        executor,
        session,
        current,
        snapshot: nextSnapshot,
      });
    });
  }

  async saveSessionProjectSnapshot(input: {
    sessionId: string;
    snapshot: ProductProjectSnapshot;
  }): Promise<SessionProductStateRecord> {
    await this.ensureSchemaV3();
    return this.withTransaction(async (executor) => {
      const session = await this.getSessionForUpdate(input.sessionId, executor);
      if (session === null) {
        throw createRuntimeFailure("STORE_SESSION_NOT_FOUND", `Session does not exist: ${input.sessionId}.`, {
          sessionId: input.sessionId,
        });
      }
      if (session.legacyReadonly === true) {
        throw new LegacyReadonlySessionError(
          `Session ${input.sessionId} is legacy_readonly and cannot be mutated`,
        );
      }
      const current = await this.getSessionProductStateRowForUpdate(input.sessionId, executor);
      return this.persistSessionProjectSnapshotWithExecutor({
        executor,
        session,
        current,
        snapshot: normalizeProjectSnapshot(input.snapshot, input.snapshot.graphVersion),
      });
    });
  }

  async getRun(runId: string): Promise<PersistedRunRecord | null> {
    await this.ensureSchemaV3();
    const result = await this.db.query<{
      run_id: string;
      session_id: string;
      event_type: string;
      status: TransitionStatus | "RUNNING";
      started_at: string;
      completed_at: string | null;
      error_json: Record<string, unknown> | null;
    }>(
      `SELECT run_id, session_id, event_type, status, started_at, completed_at, error_json
         FROM runs
        WHERE run_id = $1`,
      [runId],
    );

    const row = result.rows[0];
    return row === undefined ? null : this.mapRunRow(row);
  }

  async getRunState(runId: string): Promise<PersistedRunStateRecord | null> {
    await this.ensureSchemaV3();
    const targetResult = await this.db.query<{
      session_id: string;
      version: number;
    }>(
      `SELECT session_id, version
         FROM session_versions
        WHERE run_id = $1
        ORDER BY version DESC
        LIMIT 1`,
      [runId],
    );
    const target = targetResult.rows[0];
    if (target === undefined) {
      return null;
    }

    const baseResult = await this.db.query<{
      version: number;
      state_json: Record<string, unknown> | null;
    }>(
      `SELECT version, state_json
         FROM session_versions
        WHERE session_id = $1
          AND version <= $2
          AND snapshot_kind = 'full'
        ORDER BY version DESC
        LIMIT 1`,
      [target.session_id, target.version],
    );
    const base = baseResult.rows[0];
    if (base === undefined || base.state_json === null) {
      return null;
    }

    const deltasResult = await this.db.query<{
      version: number;
      snapshot_kind: "full" | "delta";
      state_json: Record<string, unknown> | null;
      state_patch_json: Record<string, unknown> | null;
    }>(
      `SELECT version, snapshot_kind, state_json, state_patch_json
         FROM session_versions
        WHERE session_id = $1
          AND version > $2
          AND version <= $3
        ORDER BY version ASC`,
      [target.session_id, base.version, target.version],
    );

    let nextState = normalizeRuntimeStateForPersist(base.state_json);
    let deltaCount = 0;
    for (const row of deltasResult.rows) {
      nextState = normalizeRuntimeStateForPersist({
        ...nextState,
        ...(row.snapshot_kind === "full"
          ? (row.state_json ?? {})
          : (row.state_patch_json ?? {})),
      });
      if (row.snapshot_kind === "delta") {
        deltaCount += 1;
      }
    }
    const validationError = validateRuntimeSessionState(nextState);
    if (validationError !== undefined) {
      throw createRuntimeFailure(validationError.code, validationError.message, {
        runId,
        sessionId: target.session_id,
      });
    }

    return {
      runId,
      sessionId: target.session_id,
      version: target.version,
      baseVersion: base.version,
      state: nextState,
      deltaCount,
    };
  }

  async listRuns(input: {
    sessionId?: string | undefined;
    status?: TransitionStatus | "RUNNING" | undefined;
    limit?: number | undefined;
  } = {}): Promise<PersistedRunRecord[]> {
    await this.ensureSchemaV3();
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.sessionId !== undefined) {
      values.push(input.sessionId);
      clauses.push(`session_id = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      clauses.push(`status = $${values.length}`);
    }
    values.push(Math.max(1, Math.min(input.limit ?? 50, 200)));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query<{
      run_id: string;
      session_id: string;
      event_type: string;
      status: TransitionStatus | "RUNNING";
      started_at: string;
      completed_at: string | null;
      error_json: Record<string, unknown> | null;
    }>(
      `SELECT run_id, session_id, event_type, status, started_at, completed_at, error_json
         FROM runs
         ${where}
        ORDER BY started_at DESC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => this.mapRunRow(row));
  }

  async listRunSummaries(input: {
    sessionId?: string | undefined;
    status?: TransitionStatus | "RUNNING" | undefined;
    limit?: number | undefined;
  } = {}): Promise<PersistedRunSummaryRecord[]> {
    await this.ensureSchemaV3();
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.sessionId !== undefined) {
      values.push(input.sessionId);
      clauses.push(`session_id = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      clauses.push(`status = $${values.length}`);
    }
    values.push(Math.max(1, Math.min(input.limit ?? 50, 200)));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query<{
      run_id: string;
      session_id: string;
      event_type: string;
      status: TransitionStatus | "RUNNING";
      started_at: string;
      completed_at: string | null;
      error_json: Record<string, unknown> | null;
      event_count: number | string;
      thread_id: string | null;
    }>(
      `WITH selected_runs AS (
         SELECT run_id, session_id, event_type, status, started_at, completed_at, error_json
           FROM runs
           ${where}
          ORDER BY started_at DESC
          LIMIT $${values.length}
       )
       SELECT selected_runs.*,
              (
                SELECT COUNT(*)::integer
                  FROM run_events
                 WHERE run_events.run_id = selected_runs.run_id
              ) AS event_count,
              (
                SELECT NULLIF(run_events.metadata_json ->> 'threadId', '')
                  FROM run_events
                 WHERE run_events.run_id = selected_runs.run_id
                   AND NULLIF(run_events.metadata_json ->> 'threadId', '') IS NOT NULL
                 ORDER BY run_events.occurred_at DESC, run_events.id DESC
                 LIMIT 1
              ) AS thread_id
         FROM selected_runs
        ORDER BY selected_runs.started_at DESC`,
      values,
    );
    return result.rows.map((row) => ({
      run: this.mapRunRow(row),
      eventCount: Number(row.event_count),
      ...(row.thread_id !== null ? { threadId: row.thread_id } : {}),
    }));
  }

  async ensureSession(sessionId: string, initialStepAgent?: string): Promise<SessionRecord> {
    await this.ensureSchemaV3();
    await this.withTransaction(async (executor) => {
      const inserted = await executor.query<{ inserted: boolean }>(
        `INSERT INTO sessions (session_id, current_version, current_step_agent)
         VALUES ($1, 0, $2)
         ON CONFLICT (session_id) DO NOTHING
         RETURNING true AS inserted`,
        [sessionId, initialStepAgent ?? null],
      );

      if (inserted.rowCount > 0) {
        await executor.query(
          `INSERT INTO session_versions (session_id, version, state_json, step_agent, run_id)
           VALUES ($1, 0, '{}'::jsonb, $2, 'bootstrap')
           ON CONFLICT (session_id, version) DO NOTHING`,
          [sessionId, initialStepAgent ?? null],
        );
      }
    });

    const session = await this.getSession(sessionId);
    if (session === null) {
      throw createRuntimeFailure("STORE_ENSURE_SESSION_FAILED", `Failed to ensure session ${sessionId}.`, {
        sessionId,
      });
    }

    if (initialStepAgent !== undefined && session.currentStepAgent === undefined) {
      await this.db.query(
        `UPDATE sessions
            SET current_step_agent = $2,
                updated_at = NOW()
          WHERE session_id = $1`,
        [sessionId, initialStepAgent],
      );

      const updated = await this.getSession(sessionId);
      if (updated !== null) {
        return updated;
      }
    }

    return session;
  }

  async patchSessionState(input: {
    sessionId: string;
    statePatch: Record<string, unknown>;
    expectedVersion?: number | undefined;
    nextStepAgent?: string | undefined;
    reason?: string | undefined;
  }): Promise<SessionRecord> {
    await this.ensureSchemaV3();
    const now = new Date().toISOString();

    return this.withTransaction(async (executor) => {
      const current = await this.getSessionForUpdate(input.sessionId, executor);
      if (current === null) {
        throw createRuntimeFailure("STORE_SESSION_NOT_FOUND", `Session does not exist: ${input.sessionId}.`, {
          sessionId: input.sessionId,
        });
      }
      if (current.legacyReadonly === true) {
        throw new LegacyReadonlySessionError(
          `Session ${input.sessionId} is legacy_readonly and cannot be mutated`,
        );
      }
      if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
        throw new OptimisticConcurrencyError(
          `Version conflict for session ${input.sessionId}; expected=${input.expectedVersion} actual=${current.version}`,
        );
      }

      const nextVersion = current.version + 1;
      const nextState = normalizeRuntimeStateForPersist({
        ...current.state,
        ...input.statePatch,
      });
      const validationError = validateRuntimeSessionState(nextState);
      if (validationError !== undefined) {
        throw createRuntimeFailure(validationError.code, validationError.message, {
          sessionId: input.sessionId,
        });
      }

      const updateResult = await executor.query(
        `UPDATE sessions
            SET current_version = $2,
                current_step_agent = $3,
                updated_at = NOW(),
                current_state_json = $4::jsonb
          WHERE session_id = $1
            ${input.expectedVersion !== undefined ? "AND current_version = $5" : ""}`,
        input.expectedVersion !== undefined
          ? [
              input.sessionId,
              nextVersion,
              input.nextStepAgent ?? current.currentStepAgent ?? null,
              stringifySanitizedJson(nextState),
              input.expectedVersion,
            ]
          : [
              input.sessionId,
              nextVersion,
              input.nextStepAgent ?? current.currentStepAgent ?? null,
              stringifySanitizedJson(nextState),
            ],
      );
      if (updateResult.rowCount !== 1) {
        throw new OptimisticConcurrencyError(
          `Failed to update session ${input.sessionId} due to version mismatch`,
        );
      }

      const shouldPersistFullSnapshot = nextVersion % 20 === 0 || nextVersion <= 1;
      await executor.query(
        `INSERT INTO session_versions
          (session_id, version, state_json, state_patch_json, snapshot_kind, step_agent, run_id)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)`,
        [
          input.sessionId,
          nextVersion,
          shouldPersistFullSnapshot ? stringifySanitizedJson(nextState) : stringifySanitizedJson({}),
          shouldPersistFullSnapshot ? null : stringifySanitizedJson(input.statePatch),
          shouldPersistFullSnapshot ? "full" : "delta",
          input.nextStepAgent ?? current.currentStepAgent ?? null,
          `system:${input.reason ?? "session_patch"}`,
        ],
      );

      return {
        sessionId: input.sessionId,
        version: nextVersion,
        state: nextState,
        currentStepAgent: input.nextStepAgent ?? current.currentStepAgent ?? undefined,
        updatedAt: now,
      };
    });
  }

  async startRun(runId: string, event: RuntimeEvent): Promise<void> {
    await this.ensureSchemaV3();
    await this.withTransaction(async (executor) => {
      const session = await this.getSessionLeaseStateForUpdate(event.sessionId, executor);
      if (session === null) {
        throw createRuntimeFailure("STORE_SESSION_NOT_FOUND", `Session does not exist: ${event.sessionId}.`, {
          sessionId: event.sessionId,
          runId,
        });
      }

      await this.reconcileTerminalActiveRunWithExecutor(executor, session);
      await this.acquireRunLeaseWithExecutor(executor, runId, event.sessionId);
      await executor.query(
        `INSERT INTO runs (run_id, session_id, event_type, status)
         VALUES ($1, $2, $3, 'RUNNING')`,
        [runId, event.sessionId, event.type],
      );
    });
  }

  async acquireRunLease(runId: string, sessionId: string): Promise<void> {
    await this.ensureSchemaV3();
    await this.withTransaction(async (executor) => {
      await this.acquireRunLeaseWithExecutor(executor, runId, sessionId);
    });
  }

  async releaseRunLease(runId: string, sessionId: string): Promise<void> {
    await this.ensureSchemaV3();
    await this.db.query(
      `UPDATE sessions
          SET active_run_id = NULL,
              active_run_started_at = NULL,
              updated_at = NOW()
        WHERE session_id = $1
          AND active_run_id = $2`,
      [sessionId, runId],
    );
  }

  async cancelActiveRun(sessionId: string, error?: RuntimeError): Promise<{ runId?: string | undefined }> {
    await this.ensureSchemaV3();
    return this.withTransaction(async (executor) => {
      const session = await this.getSessionLeaseStateForUpdate(sessionId, executor);
      if (session === null || session.activeRunId === undefined) {
        return {};
      }

      const activeRun = await this.getRunLeaseStateForUpdate(session.activeRunId, executor);
      if (activeRun !== null && activeRun.sessionId !== session.sessionId) {
        throw createRuntimeFailure(
          "STORE_ACTIVE_RUN_SESSION_MISMATCH",
          `Active run ${activeRun.runId} does not belong to session ${session.sessionId}.`,
          {
            sessionId: session.sessionId,
            activeRunId: activeRun.runId,
            activeRunSessionId: activeRun.sessionId,
          },
        );
      }

      if (activeRun !== null && (activeRun.status === "RUNNING" || activeRun.completedAt === undefined)) {
        await executor.query(
          `UPDATE runs
              SET status = 'FAILED',
                  completed_at = COALESCE(completed_at, NOW()),
                  error_json = CASE
                    WHEN error_json IS NULL THEN $2::jsonb
                    ELSE error_json
                  END
            WHERE run_id = $1`,
          [
            activeRun.runId,
            stringifySanitizedJson(error ?? createRuntimeFailure("RUN_CANCELLED", "Run cancelled.", {
              sessionId,
              runId: activeRun.runId,
            })),
          ],
        );
      }

      await executor.query(
        `UPDATE sessions
            SET active_run_id = NULL,
                active_run_started_at = NULL,
                updated_at = NOW()
          WHERE session_id = $1
            AND active_run_id = $2`,
        [session.sessionId, session.activeRunId],
      );

      return { runId: session.activeRunId };
    });
  }

  async commitStep(input: CommitStepInput): Promise<CommitStepResult> {
    await this.ensureSchemaV3();
    const now = new Date().toISOString();

    return this.withTransaction(async (executor) => {
      const current = await this.getSessionForUpdate(input.sessionId, executor);
      if (current === null) {
        throw createRuntimeFailure("STORE_SESSION_NOT_FOUND", `Session does not exist: ${input.sessionId}.`, {
          sessionId: input.sessionId,
          runId: input.runId,
        });
      }

      if (current.version !== input.expectedVersion) {
        throw new OptimisticConcurrencyError(
          `Version conflict for session ${input.sessionId}; expected=${input.expectedVersion} actual=${current.version}`,
        );
      }
      if (current.legacyReadonly === true) {
        throw new LegacyReadonlySessionError(
          `Session ${input.sessionId} is legacy_readonly and cannot be mutated`,
        );
      }

      const nextVersion = current.version + 1;
      const nextState = normalizeRuntimeStateForPersist({
        ...current.state,
        ...(input.statePatch ?? {}),
      });
      const validationError = validateRuntimeSessionState(nextState);
      if (validationError !== undefined) {
        const invalidStatePath = readInvalidStatePath(validationError);
        throw createRuntimeFailure(validationError.code, validationError.message, {
          sessionId: input.sessionId,
          runId: input.runId,
          expectedVersion: input.expectedVersion,
          ...(invalidStatePath !== undefined ? { invalidStatePath } : {}),
          runtimeStateDiagnostic: buildRuntimeStateDiagnosticMetadata({
            sessionId: input.sessionId,
            runId: input.runId,
            version: nextVersion,
            expectedVersion: input.expectedVersion,
            stepAgent: input.stepAgent ?? undefined,
            nextStepAgent: input.nextStepAgent ?? undefined,
            stepIndex: input.stepIndex,
            state: nextState,
            statePatch: input.statePatch,
          }),
        });
      }

      const updateResult = await executor.query(
        `UPDATE sessions
            SET current_version = $2,
                current_step_agent = $3,
                updated_at = NOW(),
                current_state_json = $5::jsonb
          WHERE session_id = $1
            AND current_version = $4`,
        [
          input.sessionId,
          nextVersion,
          input.nextStepAgent ?? null,
          input.expectedVersion,
          stringifySanitizedJson(nextState),
        ],
      );

      if (updateResult.rowCount !== 1) {
        throw new OptimisticConcurrencyError(
          `Failed to update session ${input.sessionId} due to version mismatch`,
        );
      }

      const shouldPersistFullSnapshot = nextVersion % 20 === 0 || nextVersion <= 1;
      await executor.query(
        `INSERT INTO session_versions
          (session_id, version, state_json, state_patch_json, snapshot_kind, step_agent, run_id)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)`,
        [
          input.sessionId,
          nextVersion,
          shouldPersistFullSnapshot ? stringifySanitizedJson(nextState) : stringifySanitizedJson({}),
          shouldPersistFullSnapshot ? null : stringifySanitizedJson(input.statePatch ?? {}),
          shouldPersistFullSnapshot ? "full" : "delta",
          input.nextStepAgent ?? null,
          input.runId,
        ],
      );

      const persistedEffects = await this.insertEffectsBatchWithExecutor(
        executor,
        input.runId,
        input.sessionId,
        input.stepIndex,
        input.effects,
      );
      const persistedOutboxEventIds = await this.insertOutboxEventsBatchWithExecutor(
        executor,
        input.runId,
        input.sessionId,
        input.emitEvents,
      );
      await this.appendRunLogsBatchWithExecutor(executor, input.runLogs ?? []);
      await this.appendRunEventsBatchWithExecutor(executor, [
        ...(input.runEvents ?? []),
        buildRuntimeStatePersistedEvent({
          sessionId: input.sessionId,
          runId: input.runId,
          version: nextVersion,
          expectedVersion: input.expectedVersion,
          snapshotKind: shouldPersistFullSnapshot ? "full" : "delta",
          stepAgent: input.stepAgent ?? undefined,
          nextStepAgent: input.nextStepAgent ?? undefined,
          stepIndex: input.stepIndex,
          state: nextState,
          statePatch: input.statePatch,
        }),
      ]);

      const session: SessionRecord = {
        sessionId: input.sessionId,
        version: nextVersion,
        state: nextState,
        currentStepAgent: input.nextStepAgent,
        updatedAt: now,
      };
      const persistedArtifacts = await this.appendArtifactsWithExecutor(
        executor,
        input.runId,
        input.sessionId,
        input.stepIndex,
        input.artifacts ?? [],
      );
      const persistedClaims = await this.appendClaimsWithExecutor(
        executor,
        input.runId,
        input.sessionId,
        input.stepIndex,
        input.claims ?? [],
      );

      if (input.memory !== undefined || input.budget !== undefined) {
        await executor.query(
          `INSERT INTO memory_budget_ledger (run_id, session_id, step_index, memory_json, budget_json)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
          [
            input.runId,
            input.sessionId,
            input.stepIndex,
            stringifySanitizedJson(input.memory ?? null),
            stringifySanitizedJson(input.budget ?? null),
          ],
        );
      }

      return {
        session,
        persistedEffects,
        persistedOutboxEventIds,
        persistedArtifacts,
        persistedClaims,
      };
    });
  }

  async listPendingEffects(sessionId: string): Promise<PersistedEffect[]> {
    await this.ensureSchemaV3();
    const result = await this.db.query<{
      run_id: string;
      session_id: string;
      step_index: number;
      effect_type: string;
      payload_json: Record<string, unknown>;
      idempotency_key: string;
      failure_policy: PersistedEffect["failurePolicy"];
      status: PersistedEffect["status"];
      created_at: string;
    }>(
      `SELECT e.run_id, e.session_id, e.step_index, e.effect_type,
              e.payload_json, e.idempotency_key, e.failure_policy, e.status, e.created_at
         FROM effects e
        WHERE e.session_id = $1
          AND e.status = 'PENDING'
        ORDER BY e.id ASC`,
      [sessionId],
    );

    return result.rows.map((row) => ({
      runId: row.run_id,
      sessionId: row.session_id,
      stepIndex: row.step_index,
      type: row.effect_type,
      payload: row.payload_json,
      idempotencyKey: row.idempotency_key,
      failurePolicy: row.failure_policy,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  async getEffectResult(idempotencyKey: string): Promise<EffectResult | null> {
    await this.ensureSchemaV3();
    const result = await this.db.query<{
      idempotency_key: string;
      status: "DONE" | "FAILED";
      output_json: Record<string, unknown> | null;
      error_json: RuntimeError | null;
      created_at: string;
    }>(
      `SELECT idempotency_key, status, output_json, error_json, created_at
         FROM effect_results
        WHERE idempotency_key = $1
        LIMIT 1`,
      [idempotencyKey],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }

    return {
      idempotencyKey: row.idempotency_key,
      status: row.status,
      output: row.output_json ?? undefined,
      error: row.error_json ?? undefined,
      timestamp: row.created_at,
    };
  }

  async saveEffectResult(
    runId: string,
    sessionId: string,
    result: EffectResult,
  ): Promise<void> {
    await this.ensureSchemaV3();
    await this.db.query(
      `INSERT INTO effect_results
         (run_id, session_id, idempotency_key, status, output_json, error_json, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::timestamptz)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        runId,
        sessionId,
        result.idempotencyKey,
        result.status,
        stringifySanitizedJson(result.output ?? null),
        stringifySanitizedJson(result.error ?? null),
        normalizeTimestampString(result.timestamp),
      ],
    );
  }

  async markEffectStatus(
    idempotencyKey: string,
    status: EffectExecutionStatus,
  ): Promise<void> {
    await this.ensureSchemaV3();
    await this.db.query(
      `UPDATE effects
          SET status = $2
        WHERE idempotency_key = $1`,
      [idempotencyKey, status],
    );
  }

  async listUndeliveredOutbox(limit: number, runId?: string): Promise<OutboxEventRecord[]> {
    await this.ensureSchemaV3();
    if (runId !== undefined) {
      const result = await this.db.query<{
        id: number;
        run_id: string;
        session_id: string;
        event_type: string;
        payload_json: Record<string, unknown>;
        status: OutboxEventRecord["status"];
        attempt_count: number;
        last_error: string | null;
        delivered_at: string | null;
        created_at: string;
      }>(
        `SELECT id, run_id, session_id, event_type, payload_json, status, attempt_count, last_error, delivered_at, created_at
           FROM runtime_events_outbox
          WHERE run_id = $1
            AND status <> 'DELIVERED'
          ORDER BY id ASC
          LIMIT $2`,
        [runId, limit],
      );

      return result.rows.map((row) => this.mapOutboxRow(row));
    }

    const result = await this.db.query<{
      id: number;
      run_id: string;
      session_id: string;
      event_type: string;
      payload_json: Record<string, unknown>;
      status: OutboxEventRecord["status"];
      attempt_count: number;
      last_error: string | null;
      delivered_at: string | null;
      created_at: string;
    }>(
      `SELECT id, run_id, session_id, event_type, payload_json, status, attempt_count, last_error, delivered_at, created_at
         FROM runtime_events_outbox
        WHERE status <> 'DELIVERED'
        ORDER BY id ASC
        LIMIT $1`,
      [limit],
    );

    return result.rows.map((row) => this.mapOutboxRow(row));
  }

  async markOutboxDelivered(id: number): Promise<void> {
    await this.markOutboxDeliveredBatch([id]);
  }

  async markOutboxAttemptFailed(id: number, error: string): Promise<void> {
    await this.markOutboxAttemptFailedBatch([{ id, error }]);
  }

  async markOutboxDeliveredBatch(ids: number[]): Promise<void> {
    await this.ensureSchemaV3();
    if (ids.length === 0) {
      return;
    }

    await this.db.query(
      `UPDATE runtime_events_outbox
          SET status = 'DELIVERED',
              delivered_at = NOW(),
              last_error = NULL
        WHERE id = ANY($1::int[])`,
      [ids],
    );
  }

  async markOutboxAttemptFailedBatch(entries: Array<{ id: number; error: string }>): Promise<void> {
    await this.ensureSchemaV3();
    if (entries.length === 0) {
      return;
    }

    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const entry of entries) {
      const offset = values.length;
      values.push(entry.id, entry.error);
      tuples.push(`($${offset + 1}::int, $${offset + 2}::text)`);
    }

    await this.db.query(
      `UPDATE runtime_events_outbox
          SET status = 'FAILED',
              attempt_count = attempt_count + 1,
              last_error = failed.error
         FROM (VALUES ${tuples.join(", ")}) AS failed(id, error)
        WHERE runtime_events_outbox.id = failed.id`,
      values,
    );
  }

  async appendRunLogsBatch(entries: RunLogEntry[]): Promise<void> {
    await this.ensureSchemaV3();
    await this.appendRunLogsBatchWithExecutor(this.db, entries);
  }

  async appendRunEventsBatch(events: RunEvent[]): Promise<void> {
    await this.ensureSchemaV3();
    await this.appendRunEventsBatchWithExecutor(this.db, events);
  }

  async appendRunLog(entry: RunLogEntry): Promise<void> {
    await this.appendRunLogsBatch([entry]);
  }

  async appendRunEvent(event: RunEvent): Promise<void> {
    await this.appendRunEventsBatch([event]);
  }

  async upsertConversationTurn(record: ConversationTurnRecord): Promise<void> {
    await this.ensureSchemaV3();
    await this.db.query(
      `INSERT INTO conversation_turns
         (turn_id, thread_id, session_id, root_run_id, status, initial_event_type,
          active_run_id, terminal_run_id, terminal_status, metadata_json, started_at, updated_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz, $12::timestamptz, $13::timestamptz)
       ON CONFLICT (turn_id) DO UPDATE
          SET status = EXCLUDED.status,
              active_run_id = EXCLUDED.active_run_id,
              terminal_run_id = EXCLUDED.terminal_run_id,
              terminal_status = EXCLUDED.terminal_status,
              metadata_json = EXCLUDED.metadata_json,
              updated_at = EXCLUDED.updated_at,
              completed_at = EXCLUDED.completed_at`,
      [
        record.turnId,
        record.threadId,
        record.sessionId,
        record.rootRunId ?? null,
        record.status,
        record.initialEventType,
        record.activeRunId ?? null,
        record.terminalRunId ?? null,
        record.terminalStatus ?? null,
        stringifySanitizedJson(record.metadata ?? null),
        normalizeTimestampString(record.startedAt),
        normalizeTimestampString(record.updatedAt),
        normalizeOptionalTimestampString(record.completedAt),
      ],
    );
  }

  async appendConversationTurnSegment(record: ConversationTurnSegmentRecord): Promise<void> {
    await this.ensureSchemaV3();
    await this.db.query(
      `INSERT INTO conversation_turn_segments
         (segment_id, turn_id, thread_id, session_id, run_id, kind, event_type,
          request_id, grant_id, message_hash, metadata_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::timestamptz)
       ON CONFLICT (segment_id) DO NOTHING`,
      [
        record.segmentId,
        record.turnId,
        record.threadId,
        record.sessionId,
        record.runId,
        record.kind,
        record.eventType,
        record.requestId ?? null,
        record.grantId ?? null,
        record.messageHash,
        stringifySanitizedJson(record.metadata ?? null),
        normalizeTimestampString(record.createdAt),
      ],
    );
  }

  async getConversationTurn(turnId: string): Promise<ConversationTurnRecord | null> {
    await this.ensureSchemaV3();
    const result = await this.db.query<ConversationTurnRow>(
      `SELECT turn_id, thread_id, session_id, root_run_id, status, initial_event_type,
              active_run_id, terminal_run_id, terminal_status, metadata_json,
              started_at, updated_at, completed_at
         FROM conversation_turns
        WHERE turn_id = $1`,
      [turnId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapConversationTurnRow(row);
  }

  async listConversationTurns(input: {
    threadId?: string | undefined;
    sessionId?: string | undefined;
    status?: ConversationTurnRecord["status"] | undefined;
    limit?: number | undefined;
  } = {}): Promise<ConversationTurnRecord[]> {
    await this.ensureSchemaV3();
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.threadId !== undefined) {
      values.push(input.threadId);
      clauses.push(`thread_id = $${values.length}`);
    }
    if (input.sessionId !== undefined) {
      values.push(input.sessionId);
      clauses.push(`session_id = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      clauses.push(`status = $${values.length}`);
    }
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
    values.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query<ConversationTurnRow>(
      `SELECT turn_id, thread_id, session_id, root_run_id, status, initial_event_type,
              active_run_id, terminal_run_id, terminal_status, metadata_json,
              started_at, updated_at, completed_at
         FROM conversation_turns
         ${whereClause}
        ORDER BY updated_at DESC, turn_id ASC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => mapConversationTurnRow(row));
  }

  async listConversationTurnSegments(turnId: string): Promise<ConversationTurnSegmentRecord[]> {
    await this.ensureSchemaV3();
    const result = await this.db.query<ConversationTurnSegmentRow>(
      `SELECT segment_id, turn_id, thread_id, session_id, run_id, kind, event_type,
              request_id, grant_id, message_hash, metadata_json, created_at
         FROM conversation_turn_segments
        WHERE turn_id = $1
        ORDER BY created_at ASC, segment_id ASC`,
      [turnId],
    );
    return result.rows.map((row) => mapConversationTurnSegmentRow(row));
  }

  async appendModelCallProvenance(record: ModelCallProvenanceRecord): Promise<void> {
    await this.ensureSchemaV3();
    await this.db.query(
      `INSERT INTO model_call_provenance
         (call_id, run_id, session_id, thread_id, turn_id, step_index, step_agent, phase,
          model, provider, response_format, schema_name, provider_payload_hash, component_hash,
          template_ids_json, tool_manifest_hash, assembly_id, source_bucket_hashes_json,
          metadata_json, status, latency_ms, created_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15::jsonb, $16, $17, $18::jsonb, $19::jsonb, $20, $21, $22::timestamptz, $23::timestamptz)
       ON CONFLICT (call_id) DO NOTHING`,
      [
        record.callId,
        record.runId,
        record.sessionId,
        record.threadId ?? null,
        record.turnId ?? null,
        record.stepIndex ?? null,
        record.stepAgent ?? null,
        record.phase ?? null,
        record.model ?? null,
        record.provider ?? null,
        record.responseFormat ?? null,
        record.schemaName ?? null,
        record.providerPayloadHash,
        record.componentHash,
        stringifySanitizedJson(record.templateIds ?? null),
        record.toolManifestHash ?? null,
        record.assemblyId ?? null,
        stringifySanitizedJson(record.sourceBucketHashes ?? null),
        stringifySanitizedJson(record.metadata ?? null),
        record.status,
        record.latencyMs ?? null,
        normalizeTimestampString(record.createdAt),
        normalizeOptionalTimestampString(record.completedAt),
      ],
    );
  }

  async updateModelCallProvenance(input: {
    callId: string;
    status: ModelCallProvenanceRecord["status"];
    completedAt: string;
    latencyMs?: number | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<void> {
    await this.ensureSchemaV3();
    await this.db.query(
      `UPDATE model_call_provenance
          SET status = $2,
              completed_at = $3::timestamptz,
              latency_ms = $4,
              metadata_json = COALESCE($5::jsonb, metadata_json)
        WHERE call_id = $1`,
      [
        input.callId,
        input.status,
        normalizeTimestampString(input.completedAt),
        input.latencyMs ?? null,
        input.metadata === undefined ? null : stringifySanitizedJson(input.metadata),
      ],
    );
  }

  async listModelCallProvenance(input: {
    runId?: string | undefined;
    sessionId?: string | undefined;
    turnId?: string | undefined;
    limit?: number | undefined;
  } = {}): Promise<ModelCallProvenanceRecord[]> {
    await this.ensureSchemaV3();
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.runId !== undefined) {
      values.push(input.runId);
      clauses.push(`run_id = $${values.length}`);
    }
    if (input.sessionId !== undefined) {
      values.push(input.sessionId);
      clauses.push(`session_id = $${values.length}`);
    }
    if (input.turnId !== undefined) {
      values.push(input.turnId);
      clauses.push(`turn_id = $${values.length}`);
    }
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
    values.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query<ModelCallProvenanceRow>(
      `SELECT call_id, run_id, session_id, thread_id, turn_id, step_index, step_agent,
              phase, model, provider, response_format, schema_name, provider_payload_hash,
              component_hash, template_ids_json, tool_manifest_hash, assembly_id,
              source_bucket_hashes_json, metadata_json, status, latency_ms, created_at, completed_at
         FROM model_call_provenance
         ${whereClause}
        ORDER BY created_at ASC, call_id ASC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => mapModelCallProvenanceRow(row));
  }

  private async insertEffectsBatchWithExecutor(
    executor: SqlExecutor,
    runId: string,
    sessionId: string,
    stepIndex: number,
    effects: CommitStepInput["effects"],
  ): Promise<PersistedEffect[]> {
    if (effects.length === 0) {
      return [];
    }

    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const effect of effects) {
      const offset = values.length;
      values.push(
        runId,
        sessionId,
        stepIndex,
        effect.type,
        effect.idempotencyKey,
        effect.failurePolicy,
        stringifySanitizedJson(effect.payload),
      );
      tuples.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::jsonb, 'PENDING')`,
      );
    }

    const inserted = await executor.query<{
      run_id: string;
      session_id: string;
      step_index: number;
      effect_type: string;
      payload_json: Record<string, unknown>;
      idempotency_key: string;
      failure_policy: PersistedEffect["failurePolicy"];
      status: PersistedEffect["status"];
      created_at: string;
    }>(
      `INSERT INTO effects
         (run_id, session_id, step_index, effect_type, idempotency_key, failure_policy, payload_json, status)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING run_id, session_id, step_index, effect_type, payload_json, idempotency_key, failure_policy, status, created_at`,
      values,
    );

    return inserted.rows.map((row) => ({
      runId: row.run_id,
      sessionId: row.session_id,
      stepIndex: row.step_index,
      type: row.effect_type,
      payload: row.payload_json,
      idempotencyKey: row.idempotency_key,
      failurePolicy: row.failure_policy,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  private async insertOutboxEventsBatchWithExecutor(
    executor: SqlExecutor,
    runId: string,
    sessionId: string,
    emitEvents: CommitStepInput["emitEvents"],
  ): Promise<number[]> {
    if (emitEvents.length === 0) {
      return [];
    }

    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const emitEvent of emitEvents) {
      const offset = values.length;
      values.push(runId, sessionId, emitEvent.type, stringifySanitizedJson(emitEvent.payload));
      tuples.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}::jsonb, 'PENDING')`);
    }

    const inserted = await executor.query<{ id: number }>(
      `INSERT INTO runtime_events_outbox (run_id, session_id, event_type, payload_json, status)
       VALUES ${tuples.join(", ")}
       RETURNING id`,
      values,
    );

    return inserted.rows
      .map((row) => row.id)
      .filter((id): id is number => typeof id === "number");
  }

  private async appendRunLogsBatchWithExecutor(
    executor: SqlExecutor,
    entries: RunLogEntry[],
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const entry of entries) {
      const offset = values.length;
      values.push(
        entry.runId,
        entry.sessionId,
        entry.stepIndex ?? null,
        entry.eventName,
        entry.level,
        stringifySanitizedJson(entry.metadata ?? null),
      );
      tuples.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}::jsonb)`,
      );
    }

    await executor.query(
      `INSERT INTO run_logs (run_id, session_id, step_index, event_name, level, metadata_json)
       VALUES ${tuples.join(", ")}`,
      values,
    );
  }

  private async appendRunEventsBatchWithExecutor(
    executor: SqlExecutor,
    events: RunEvent[],
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const event of events) {
      const offset = values.length;
      values.push(
        event.runId,
        event.sessionId,
        event.stepIndex ?? null,
        event.type,
        event.level,
        stringifySanitizedJson(event.metadata ?? null),
        normalizeTimestampString(event.timestamp),
      );
      tuples.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}::jsonb, $${offset + 7}::timestamptz)`,
      );
    }

    await executor.query(
      `INSERT INTO run_events (run_id, session_id, step_index, event_type, level, metadata_json, occurred_at)
       VALUES ${tuples.join(", ")}`,
      values,
    );
  }

  async appendArtifacts(
    runId: string,
    sessionId: string,
    stepIndex: number,
    artifacts: Array<{ type: string; id?: string | undefined; payload: Record<string, unknown> }>,
  ): Promise<PersistedArtifact[]> {
    await this.ensureSchemaV3();
    return this.appendArtifactsWithExecutor(this.db, runId, sessionId, stepIndex, artifacts);
  }

  async getArtifact(input: GetArtifactInput): Promise<PersistedArtifact | null> {
    await this.ensureSchemaV3();
    const result = await this.db.query<ArtifactRow>(
      `SELECT artifact_id, run_id, session_id, step_index, artifact_type, payload_json, created_at
         FROM artifacts
        WHERE artifact_id = $1 AND session_id = $2
        LIMIT 1`,
      [input.artifactId, input.sessionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.mapArtifactRow(row);
  }

  async listArtifacts(input: ListArtifactsInput): Promise<PersistedArtifact[]> {
    await this.ensureSchemaV3();
    const clauses = ["session_id = $1"];
    const values: unknown[] = [input.sessionId];
    if (input.runId !== undefined) {
      values.push(input.runId);
      clauses.push(`run_id = $${values.length}`);
    }
    if (input.stepIndex !== undefined) {
      values.push(input.stepIndex);
      clauses.push(`step_index = $${values.length}`);
    }
    if (input.type !== undefined) {
      values.push(input.type);
      clauses.push(`artifact_type = $${values.length}`);
    }
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
    values.push(limit);
    const result = await this.db.query<ArtifactRow>(
      `SELECT artifact_id, run_id, session_id, step_index, artifact_type, payload_json, created_at
         FROM artifacts
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC, artifact_id ASC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => this.mapArtifactRow(row));
  }

  private async appendArtifactsWithExecutor(
    executor: SqlExecutor,
    runId: string,
    sessionId: string,
    stepIndex: number,
    artifacts: Array<{ type: string; id?: string | undefined; payload: Record<string, unknown> }>,
  ): Promise<PersistedArtifact[]> {
    if (artifacts.length === 0) {
      return [];
    }

    const normalized = artifacts.map((artifact, index) => ({
      artifactId: artifact.id ?? `${runId}:artifact:${stepIndex}:${index}:${artifact.type}`,
      type: artifact.type,
      payload: artifact.payload,
    }));
    const artifactById = new Map(
      normalized.map((item) => [item.artifactId, item] as const),
    );

    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const artifact of normalized) {
      const offset = values.length;
      values.push(
        artifact.artifactId,
        runId,
        sessionId,
        stepIndex,
        artifact.type,
        stringifySanitizedJson(artifact.payload),
      );
      tuples.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}::jsonb)`,
      );
    }

    const inserted = await executor.query<{
      artifact_id: string;
      created_at: string;
    }>(
      `INSERT INTO artifacts (artifact_id, run_id, session_id, step_index, artifact_type, payload_json)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (artifact_id) DO NOTHING
       RETURNING artifact_id, created_at`,
      values,
    );

    return inserted.rows.flatMap((row) => {
      const artifact = artifactById.get(row.artifact_id);
      if (artifact === undefined) {
        return [];
      }
      return [{
        artifactId: artifact.artifactId,
        sessionId,
        runId,
        stepIndex,
        type: artifact.type,
        payload: artifact.payload,
        createdAt: row.created_at ?? new Date().toISOString(),
      }];
    });
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
    await this.ensureSchemaV3();
    return this.appendClaimsWithExecutor(this.db, runId, sessionId, stepIndex, claims);
  }

  async listReadyRegionWorkItems(sessionId: string): Promise<RegionWorkItem[]> {
    await this.ensureSchemaV3();
    const result = await this.db.query<{
      id: number;
      session_id: string;
      region: string;
      step_agent: string;
      status: RegionWorkItem["status"];
      state_node_json: Record<string, unknown> | null;
      created_at: string;
      claimed_at: string | null;
      completed_at: string | null;
      error_json: Record<string, unknown> | null;
    }>(
      `SELECT id, session_id, region, step_agent, status, state_node_json, created_at, claimed_at, completed_at, error_json
         FROM region_work_items
        WHERE session_id = $1
          AND status = 'PENDING'
        ORDER BY region ASC, id ASC`,
      [sessionId],
    );

    return result.rows.map((row) => this.mapRegionWorkItemRow(row));
  }

  async claimNextRegionWorkItem(
    sessionId: string,
    cursor?: string,
  ): Promise<RegionWorkItem | null> {
    await this.ensureSchemaV3();
    return this.withTransaction(async (executor) => {
      const tryClaim = async (queryCursor?: string): Promise<RegionWorkItem | null> => {
        const row = await executor.query<{
          id: number;
        }>(
          queryCursor === undefined
            ? `SELECT id
                 FROM region_work_items
                WHERE session_id = $1
                  AND status = 'PENDING'
                ORDER BY region ASC, id ASC
                LIMIT 1`
            : `SELECT id
                 FROM region_work_items
                WHERE session_id = $1
                  AND status = 'PENDING'
                  AND region > $2
                ORDER BY region ASC, id ASC
                LIMIT 1`,
          queryCursor === undefined ? [sessionId] : [sessionId, queryCursor],
        );

        const candidateId = row.rows[0]?.id;
        if (candidateId === undefined) {
          return null;
        }

        const claimed = await executor.query<{
          id: number;
          session_id: string;
          region: string;
          step_agent: string;
          status: RegionWorkItem["status"];
          state_node_json: Record<string, unknown> | null;
          created_at: string;
          claimed_at: string | null;
          completed_at: string | null;
          error_json: Record<string, unknown> | null;
        }>(
          `UPDATE region_work_items
              SET status = 'CLAIMED',
                  claimed_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1
              AND status = 'PENDING'
            RETURNING id, session_id, region, step_agent, status, state_node_json, created_at, claimed_at, completed_at, error_json`,
          [candidateId],
        );

        if (claimed.rowCount === 0) {
          return null;
        }

        return this.mapRegionWorkItemRow(claimed.rows[0]!);
      };

      const claimedAfterCursor = await tryClaim(cursor);
      if (claimedAfterCursor !== null) {
        return claimedAfterCursor;
      }
      if (cursor === undefined) {
        return null;
      }
      return tryClaim(undefined);
    });
  }

  async completeRegionWorkItem(
    itemId: number,
    outcome: "DONE" | "FAILED",
    error?: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureSchemaV3();
    await this.db.query(
      `UPDATE region_work_items
          SET status = $2,
              completed_at = NOW(),
              updated_at = NOW(),
              error_json = $3::jsonb
        WHERE id = $1`,
      [itemId, outcome, stringifySanitizedJson(error ?? null)],
    );
  }

  async spawnRegionWorkItems(sessionId: string, items: RegionWorkIntent[]): Promise<void> {
    await this.ensureSchemaV3();
    if (items.length === 0) {
      return;
    }

    await this.withTransaction(async (executor) => {
      for (const item of items) {
        await executor.query(
          `INSERT INTO region_work_items (session_id, region, step_agent, state_node_json, status)
           VALUES ($1, $2, $3, $4::jsonb, 'PENDING')`,
          [sessionId, item.region, item.stepAgent, stringifySanitizedJson(item.stateNode ?? null)],
        );
      }
    });
  }

  private async appendClaimsWithExecutor(
    executor: SqlExecutor,
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
    if (claims.length === 0) {
      return [];
    }

    const normalized = claims.map((claim, index) => ({
      claimId: claim.id ?? `${runId}:claim:${stepIndex}:${index}`,
      text: claim.text,
      status: claim.status,
      evidenceIds: [...claim.evidenceIds],
    }));
    const claimById = new Map(
      normalized.map((claim) => [claim.claimId, claim] as const),
    );

    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const claim of normalized) {
      const offset = values.length;
      values.push(claim.claimId, runId, sessionId, stepIndex, claim.text, claim.status);
      tuples.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`,
      );
    }

    const insertedClaims = await executor.query<{
      claim_id: string;
      created_at: string;
    }>(
      `INSERT INTO claims (claim_id, run_id, session_id, step_index, claim_text, status)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (claim_id) DO NOTHING
       RETURNING claim_id, created_at`,
      values,
    );
    if (insertedClaims.rowCount === 0) {
      return [];
    }

    const insertedClaimIds = new Set(
      insertedClaims.rows
        .map((row) => row.claim_id)
        .filter((claimId): claimId is string => typeof claimId === "string"),
    );

    const evidenceValues: unknown[] = [];
    const evidenceTuples: string[] = [];
    for (const claimId of insertedClaimIds) {
      const claim = claimById.get(claimId);
      if (claim === undefined) {
        continue;
      }
      for (const artifactId of claim.evidenceIds) {
        const offset = evidenceValues.length;
        evidenceValues.push(claimId, artifactId);
        evidenceTuples.push(`($${offset + 1}, $${offset + 2})`);
      }
    }
    if (evidenceTuples.length > 0) {
      await executor.query(
        `INSERT INTO claim_evidence (claim_id, artifact_id)
         VALUES ${evidenceTuples.join(", ")}
         ON CONFLICT DO NOTHING`,
        evidenceValues,
      );
    }

    return insertedClaims.rows.flatMap((row) => {
      const claim = claimById.get(row.claim_id);
      if (claim === undefined) {
        return [];
      }
      return [{
        claimId: claim.claimId,
        sessionId,
        runId,
        stepIndex,
        text: claim.text,
        status: claim.status,
        evidenceIds: [...claim.evidenceIds],
        createdAt: row.created_at ?? new Date().toISOString(),
      }];
    });
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
    await this.ensureSchemaV3();
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (input.runId !== undefined) {
      values.push(input.runId);
      clauses.push(`run_id = $${values.length}`);
    }

    if (input.sessionId !== undefined) {
      values.push(input.sessionId);
      clauses.push(`session_id = $${values.length}`);
    }

    let threadSessionId: string | undefined;
    if (input.threadId !== undefined) {
      threadSessionId = (await this.getThread(input.threadId))?.sessionId;
      if (threadSessionId === undefined) {
        return [];
      }
    }

    let delegationChildSessionId: string | undefined;
    let delegationSupervisionGroupId: string | undefined;
    if (input.delegationId !== undefined) {
      const delegation = await this.getDelegation(input.delegationId);
      delegationChildSessionId =
        delegation === null ? undefined : (await this.getThread(delegation.childThreadId))?.sessionId;
      delegationSupervisionGroupId =
        delegation === null ? undefined : this.readDelegationSupervisionGroupId(delegation);
    }

    if (threadSessionId !== undefined && input.delegationId === undefined) {
      values.push(threadSessionId);
      clauses.push(`session_id = $${values.length}`);
    }

    if (input.delegationId !== undefined) {
      values.push(input.delegationId);
      const relationClauses = [`metadata_json ->> 'delegationId' = $${values.length}`];
      if (delegationSupervisionGroupId !== undefined) {
        values.push(delegationSupervisionGroupId);
        relationClauses.push(`metadata_json ->> 'supervisionGroupId' = $${values.length}`);
      }
      if (threadSessionId !== undefined) {
        values.push(threadSessionId);
        relationClauses.push(`session_id = $${values.length}`);
      }
      if (delegationChildSessionId !== undefined && delegationChildSessionId !== threadSessionId) {
        values.push(delegationChildSessionId);
        relationClauses.push(`session_id = $${values.length}`);
      }
      clauses.push(`(${relationClauses.join(" OR ")})`);
    }

    if (input.fromTimestamp !== undefined) {
      values.push(normalizeTimestampString(input.fromTimestamp));
      clauses.push(`occurred_at >= $${values.length}::timestamptz`);
    }

    if (input.toTimestamp !== undefined) {
      values.push(normalizeTimestampString(input.toTimestamp));
      clauses.push(`occurred_at <= $${values.length}::timestamptz`);
    }

    values.push(input.limit ?? 1000);
    const limitPlaceholder = `$${values.length}`;

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query<{
      run_id: string;
      session_id: string;
      step_index: number | null;
      event_type: string;
      level: "INFO" | "WARN" | "ERROR";
      metadata_json: Record<string, unknown> | null;
      occurred_at: string;
    }>(
      `SELECT run_id, session_id, step_index, event_type, level, metadata_json, occurred_at
         FROM run_events
         ${whereClause}
        ORDER BY occurred_at ASC, id ASC
        LIMIT ${limitPlaceholder}`,
      values,
    );

    return result.rows.map((row) => ({
      runId: row.run_id,
      sessionId: row.session_id,
      ...(row.step_index !== null ? { stepIndex: row.step_index } : {}),
      type: row.event_type as RunEvent["type"],
      level: row.level,
      timestamp: row.occurred_at,
      ...(row.metadata_json !== null ? { metadata: row.metadata_json } : {}),
    }));
  }

  async upsertThread(thread: ThreadRecord): Promise<void> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.upsertThread(thread);
  }

  async getThread(threadId: string): Promise<ThreadRecord | null> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.getThread(threadId);
  }

  async listThreads(input?: {
    parentThreadId?: string | undefined;
    sessionId?: string | undefined;
    status?: ThreadRecord["status"] | undefined;
  }): Promise<ThreadRecord[]> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.listThreads(input);
  }

  async upsertDelegation(record: DelegationRecord): Promise<void> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.upsertDelegation(record);
  }

  async getDelegation(delegationId: string): Promise<DelegationRecord | null> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.getDelegation(delegationId);
  }

  async getDelegationByChildThreadId(childThreadId: string): Promise<DelegationRecord | null> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.getDelegationByChildThreadId(childThreadId);
  }

  async listDelegations(input?: {
    parentThreadId?: string | undefined;
    childThreadId?: string | undefined;
    status?: DelegationRecord["status"] | undefined;
  }): Promise<DelegationRecord[]> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.listDelegations(input);
  }

  async upsertInteractionRequest(record: InteractionRequestRecord): Promise<void> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.upsertInteractionRequest(record);
  }

  async getInteractionRequest(requestId: string): Promise<InteractionRequestRecord | null> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.getInteractionRequest(requestId);
  }

  async listInteractionRequests(input?: {
    threadId?: string | undefined;
    delegationId?: string | undefined;
    status?: InteractionRequestRecord["status"] | undefined;
  }): Promise<InteractionRequestRecord[]> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.listInteractionRequests(input);
  }

  async upsertApprovalGrant(record: ApprovalGrantRecord): Promise<void> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.upsertApprovalGrant(record);
  }

  async listApprovalGrants(input?: {
    threadId?: string | undefined;
    requestId?: string | undefined;
    status?: ApprovalGrantRecord["status"] | undefined;
  }): Promise<ApprovalGrantRecord[]> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.listApprovalGrants(input);
  }

  async upsertContextCheckpoint(record: ContextCheckpointRecord): Promise<void> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.upsertContextCheckpoint(record);
  }

  async getContextCheckpoint(checkpointId: string) {
    await this.ensureSchemaV3();
    return this.orchestrationStore.getContextCheckpoint(checkpointId);
  }

  async listContextCheckpoints(input?: {
    threadId?: string | undefined;
    status?: ContextCheckpointRecord["status"] | undefined;
  }) {
    await this.ensureSchemaV3();
    return this.orchestrationStore.listContextCheckpoints(input);
  }

  async upsertOperatorFocus(record: OperatorFocusRecord): Promise<void> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.upsertOperatorFocus(record);
  }

  async getOperatorFocus(sessionId: string) {
    await this.ensureSchemaV3();
    return this.orchestrationStore.getOperatorFocus(sessionId);
  }

  async upsertOperatorAttention(record: OperatorAttentionRecord): Promise<void> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.upsertOperatorAttention(record);
  }

  async getOperatorAttention(attentionId: string) {
    await this.ensureSchemaV3();
    return this.orchestrationStore.getOperatorAttention(attentionId);
  }

  async listOperatorAttention(input?: {
    sessionId?: string | undefined;
    threadId?: string | undefined;
    kind?: OperatorAttentionRecord["kind"] | undefined;
    status?: OperatorAttentionRecord["status"] | undefined;
  }) {
    await this.ensureSchemaV3();
    return this.orchestrationStore.listOperatorAttention(input);
  }

  async saveContextSummaryArtifact(record: ContextSummaryArtifactRecord): Promise<void> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.saveContextSummaryArtifact(record);
  }

  async listContextSummaryArtifacts(threadId: string): Promise<ContextSummaryArtifactRecord[]> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.listContextSummaryArtifacts(threadId);
  }

  async appendThreadCompactionEvent(record: ThreadCompactionEventRecord): Promise<void> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.appendThreadCompactionEvent(record);
  }

  async listThreadCompactionEvents(threadId: string): Promise<ThreadCompactionEventRecord[]> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.listThreadCompactionEvents(threadId);
  }

  async upsertAssemblyBundle(record: AssemblyBundleRecord): Promise<void> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.upsertAssemblyBundle(record);
  }

  async getAssemblyBundle(bundleId: string) {
    await this.ensureSchemaV3();
    return this.orchestrationStore.getAssemblyBundle(bundleId);
  }

  async listAssemblyBundles(input?: {
    source?: AssemblyBundleRecord["source"] | undefined;
  }) {
    await this.ensureSchemaV3();
    return this.orchestrationStore.listAssemblyBundles(input);
  }

  async appendThreadAssemblyRecord(record: ThreadAssemblyRecord): Promise<void> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.appendThreadAssemblyRecord(record);
  }

  async listThreadAssemblyRecords(threadId: string) {
    await this.ensureSchemaV3();
    return this.orchestrationStore.listThreadAssemblyRecords(threadId);
  }

  async upsertAssemblyChangeProposal(record: AssemblyChangeProposalRecord): Promise<void> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.upsertAssemblyChangeProposal(record);
  }

  async getAssemblyChangeProposal(proposalId: string) {
    await this.ensureSchemaV3();
    return this.orchestrationStore.getAssemblyChangeProposal(proposalId);
  }

  async listAssemblyChangeProposals(input?: {
    threadId?: string | undefined;
    status?: AssemblyProposalStatus | undefined;
  }) {
    await this.ensureSchemaV3();
    return this.orchestrationStore.listAssemblyChangeProposals(input);
  }

  async appendAssemblyChangeDecision(record: AssemblyChangeDecisionRecord): Promise<void> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.appendAssemblyChangeDecision(record);
  }

  async listAssemblyChangeDecisions(input?: {
    threadId?: string | undefined;
    proposalId?: string | undefined;
  }) {
    await this.ensureSchemaV3();
    return this.orchestrationStore.listAssemblyChangeDecisions(input);
  }

  async upsertSpecialistDefinition(record: SpecialistDefinitionRecord): Promise<void> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.upsertSpecialistDefinition(record);
  }

  async listSpecialistDefinitions() {
    await this.ensureSchemaV3();
    return this.orchestrationStore.listSpecialistDefinitions();
  }

  async upsertContextPolicyDefinition(record: ContextPolicyDefinitionRecord): Promise<void> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.upsertContextPolicyDefinition(record);
  }

  async listContextPolicyDefinitions() {
    await this.ensureSchemaV3();
    return this.orchestrationStore.listContextPolicyDefinitions();
  }

  async appendLegacyArchive(archive: LegacySessionArchive): Promise<void> {
    await this.ensureSchemaV3();
    await this.db.query(
      `INSERT INTO legacy_session_archives (session_id, snapshot_json, reason, created_at)
       VALUES ($1, $2::jsonb, $3, COALESCE($4::timestamptz, NOW()))`,
      [
        archive.sessionId,
        stringifySanitizedJson(archive.snapshot),
        archive.reason,
        normalizeOptionalTimestampString(archive.createdAt) ?? null,
      ],
    );
  }

  async completeRun(
    runId: string,
    status: TransitionStatus,
    error?: RuntimeError,
  ): Promise<void> {
    await this.ensureSchemaV3();
    await this.withTransaction(async (executor) => {
      const runResult = await executor.query<{ session_id: string }>(
        `UPDATE runs
            SET status = $2,
                completed_at = NOW(),
                error_json = $3::jsonb
          WHERE run_id = $1
          RETURNING session_id`,
        [runId, status, stringifySanitizedJson(error ?? null)],
      );
      const sessionId = runResult.rows[0]?.session_id;
      await executor.query(
        "DELETE FROM provider_reasoning_state WHERE run_id = $1 AND record_kind = 'continuation'",
        [runId],
      );
      if (sessionId !== undefined) {
        await executor.query(
          `UPDATE sessions
              SET active_run_id = NULL,
                  active_run_started_at = NULL,
                  updated_at = NOW()
            WHERE session_id = $1
              AND active_run_id = $2`,
          [sessionId, runId],
        );
      }
    });
  }

  private async acquireRunLeaseWithExecutor(
    executor: SqlExecutor,
    runId: string,
    sessionId: string,
  ): Promise<void> {
    const updated = await executor.query<{ session_id: string }>(
      `UPDATE sessions
          SET active_run_id = $2,
              active_run_started_at = NOW(),
              updated_at = NOW()
        WHERE session_id = $1
          AND (active_run_id IS NULL OR active_run_id = $2)
        RETURNING session_id`,
      [sessionId, runId],
    );
    if (updated.rowCount === 1) {
      return;
    }

    const existing = await executor.query<{ active_run_id: string | null }>(
      `SELECT active_run_id
         FROM sessions
        WHERE session_id = $1
        FOR UPDATE`,
      [sessionId],
    );
    const activeRunId = existing.rows[0]?.active_run_id ?? undefined;
    throw new SessionBusyError(sessionId, activeRunId ?? undefined);
  }

  private async getSessionLeaseStateForUpdate(
    sessionId: string,
    executor: SqlExecutor,
  ): Promise<LockedSessionLeaseState | null> {
    const result = await executor.query<{
      session_id: string;
      active_run_id: string | null;
      current_state_json: Record<string, unknown> | null;
    }>(
      `SELECT session_id, active_run_id, current_state_json
         FROM sessions
        WHERE session_id = $1
        FOR UPDATE`,
      [sessionId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }

    return {
      sessionId: row.session_id,
      activeRunId: row.active_run_id ?? undefined,
      state: normalizeRuntimeStateForPersist(row.current_state_json ?? {}),
    };
  }

  private async getRunLeaseStateForUpdate(
    runId: string,
    executor: SqlExecutor,
  ): Promise<LockedRunLeaseState | null> {
    const result = await executor.query<{
      run_id: string;
      session_id: string;
      status: TransitionStatus | "RUNNING";
      completed_at: string | null;
      error_json: Record<string, unknown> | null;
    }>(
      `SELECT run_id, session_id, status, completed_at, error_json
         FROM runs
        WHERE run_id = $1
        FOR UPDATE`,
      [runId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }

    return {
      runId: row.run_id,
      sessionId: row.session_id,
      status: row.status,
      completedAt: row.completed_at ?? undefined,
      error: row.error_json,
    };
  }

  private async reconcileTerminalActiveRunWithExecutor(
    executor: SqlExecutor,
    session: LockedSessionLeaseState,
  ): Promise<void> {
    if (session.activeRunId === undefined) {
      return;
    }

    const activeRun = await this.getRunLeaseStateForUpdate(session.activeRunId, executor);
    if (activeRun !== null && activeRun.sessionId !== session.sessionId) {
      throw createRuntimeFailure(
        "STORE_ACTIVE_RUN_SESSION_MISMATCH",
        `Active run ${activeRun.runId} does not belong to session ${session.sessionId}.`,
        {
          sessionId: session.sessionId,
          activeRunId: activeRun.runId,
          activeRunSessionId: activeRun.sessionId,
        },
      );
    }

    if (activeRun === null) {
      await this.releaseActiveRunLeaseWithExecutor(executor, session.sessionId, session.activeRunId);
      return;
    }

    const terminalStatus = this.readSessionTerminalStatus(session.state);
    if (terminalStatus === undefined) {
      return;
    }

    if (activeRun !== null && (activeRun.status === "RUNNING" || activeRun.completedAt === undefined)) {
      await executor.query(
        `UPDATE runs
            SET status = $2,
                completed_at = COALESCE(completed_at, NOW()),
                error_json = CASE
                  WHEN error_json IS NULL THEN $3::jsonb
                  ELSE error_json
                END
          WHERE run_id = $1`,
        [
          activeRun.runId,
          terminalStatus,
          stringifySanitizedJson(this.buildRecoveredRunError(terminalStatus, session.state)),
        ],
      );
    }

    await this.releaseActiveRunLeaseWithExecutor(executor, session.sessionId, session.activeRunId);
  }

  private async releaseActiveRunLeaseWithExecutor(
    executor: SqlExecutor,
    sessionId: string,
    activeRunId: string,
  ): Promise<void> {
    await executor.query(
      `UPDATE sessions
          SET active_run_id = NULL,
              active_run_started_at = NULL,
              updated_at = NOW()
        WHERE session_id = $1
          AND active_run_id = $2`,
      [sessionId, activeRunId],
    );
  }

  private readSessionTerminalStatus(state: Record<string, unknown>): TransitionStatus | undefined {
    const react = this.asRecord(state.agent);
    const terminal = this.asRecord(react?.terminal);
    const status = terminal?.status;
    if (status === "WAITING" || status === "COMPLETED" || status === "FAILED") {
      return status;
    }
    return ;
  }

  private buildRecoveredRunError(
    status: TransitionStatus,
    state: Record<string, unknown>,
  ): RuntimeError | null {
    if (status !== "FAILED") {
      return null;
    }

    const react = this.asRecord(state.agent);
    const terminal = this.asRecord(react?.terminal);
    const reasonCode = typeof terminal?.reasonCode === "string" ? terminal.reasonCode : undefined;

    return {
      code: "RECOVERED_STALE_FAILED_RUN",
      message: "Recovered stale failed run from persisted terminal session state.",
      details: {
        recoveredFromSessionState: true,
        ...(reasonCode !== undefined ? { terminalReasonCode: reasonCode } : {}),
      },
    };
  }

  private async getSessionForUpdate(
    sessionId: string,
    executor: SqlExecutor,
  ): Promise<(SessionRecord & { legacyReadonly: boolean }) | null> {
    const result = await executor.query<{
      session_id: string;
      current_version: number;
      current_step_agent: string | null;
      updated_at: unknown;
      current_state_json: Record<string, unknown> | null;
      legacy_readonly?: boolean;
    }>(
      `SELECT session_id, current_version, current_step_agent, updated_at, current_state_json, legacy_readonly
         FROM sessions
        WHERE session_id = $1
        FOR UPDATE`,
      [sessionId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }

    return this.buildSessionRecord(row);
  }

  private buildSessionRecord(row: {
    session_id: string;
    current_version: number;
    current_step_agent: string | null;
    updated_at: unknown;
    current_state_json: Record<string, unknown> | null;
    legacy_readonly?: boolean;
  }): SessionRecord & { legacyReadonly: boolean } {
    return {
      sessionId: row.session_id,
      version: row.current_version,
      state: normalizeRuntimeStateForPersist(row.current_state_json ?? {}),
      currentStepAgent: row.current_step_agent ?? undefined,
      updatedAt: normalizeTimestampString(row.updated_at),
      legacyReadonly: row.legacy_readonly ?? false,
    };
  }

  private async getSessionProductStateRowForUpdate(
    sessionId: string,
    executor: SqlExecutor,
  ): Promise<SessionProductStateRow | null> {
    const result = await executor.query<SessionProductStateRow>(
      `SELECT session_id, version, project_snapshot_json, task_graph_json, workspace_checkpoint_state_json, created_at, updated_at
         FROM session_product_state
        WHERE session_id = $1
        FOR UPDATE`,
      [sessionId],
    );
    return result.rows[0] ?? null;
  }

  private async persistSessionProjectSnapshotWithExecutor(input: {
    executor: SqlExecutor;
    session: SessionRecord;
    current: SessionProductStateRow | null;
    snapshot: ProductProjectSnapshot;
  }): Promise<SessionProductStateRecord> {
    const product = this.asRecord(input.session.state.product) ?? {};
    const taskGraph = input.current?.task_graph_json ?? this.asRecord(product.taskGraph) ?? {};
    const workspaceCheckpointState =
      input.current?.workspace_checkpoint_state_json ?? this.asRecord(product.workspaceCheckpointState) ?? {};
    const normalizedSnapshot = normalizeProjectSnapshot(input.snapshot, input.snapshot.graphVersion);

    const result = input.current === null
      ? await input.executor.query<SessionProductStateRow>(
          `INSERT INTO session_product_state
            (session_id, version, project_snapshot_json, task_graph_json, workspace_checkpoint_state_json)
           VALUES ($1, 1, $2::jsonb, $3::jsonb, $4::jsonb)
           RETURNING session_id, version, project_snapshot_json, task_graph_json, workspace_checkpoint_state_json, created_at, updated_at`,
          [
            input.session.sessionId,
            stringifySanitizedJson(normalizedSnapshot),
            stringifySanitizedJson(taskGraph),
            stringifySanitizedJson(workspaceCheckpointState),
          ],
        )
      : await input.executor.query<SessionProductStateRow>(
          `UPDATE session_product_state
              SET version = version + 1,
                  project_snapshot_json = $2::jsonb,
                  updated_at = NOW()
            WHERE session_id = $1
            RETURNING session_id, version, project_snapshot_json, task_graph_json, workspace_checkpoint_state_json, created_at, updated_at`,
          [
            input.session.sessionId,
            stringifySanitizedJson(normalizedSnapshot),
          ],
        );

    const row = result.rows[0];
    if (row === undefined) {
      throw createRuntimeFailure(
        "STORE_PRODUCT_STATE_WRITE_FAILED",
        `Failed to persist product state for session ${input.session.sessionId}.`,
        { sessionId: input.session.sessionId },
      );
    }
    return this.mapSessionProductStateRow(row);
  }

  private mapSessionProductStateRow(row: SessionProductStateRow): SessionProductStateRecord {
    const snapshotRecord = this.asRecord(row.project_snapshot_json);
    const graphVersion = (
      typeof snapshotRecord?.graphVersion === "number" && Number.isFinite(snapshotRecord.graphVersion)
        ? snapshotRecord.graphVersion
        : 1
    ) as ProductProjectSnapshot["graphVersion"];
    return {
      sessionId: row.session_id,
      version: row.version,
      projectSnapshot: normalizeProjectSnapshot(row.project_snapshot_json, graphVersion),
      taskGraph: row.task_graph_json ?? {},
      workspaceCheckpointState: row.workspace_checkpoint_state_json ?? {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return ;
    }
    return value as Record<string, unknown>;
  }

  private mapRunRow(row: {
    run_id: string;
    session_id: string;
    event_type: string;
    status: TransitionStatus | "RUNNING";
    started_at: string;
    completed_at: string | null;
    error_json: Record<string, unknown> | null;
  }): PersistedRunRecord {
    return {
      runId: row.run_id,
      sessionId: row.session_id,
      eventType: row.event_type,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      error:
        row.error_json === null
          ? undefined
          : {
              code:
                typeof row.error_json.code === "string"
                  ? row.error_json.code
                  : "RUNTIME_ERROR",
              message:
                typeof row.error_json.message === "string"
                  ? row.error_json.message
                  : "Run failed",
              ...(typeof row.error_json.details === "object" &&
              row.error_json.details !== null &&
              Array.isArray(row.error_json.details) === false
                ? { details: row.error_json.details as Record<string, unknown> }
                : {}),
            },
    };
  }

  private readDelegationSupervisionGroupId(record: DelegationRecord): string | undefined {
    const policy = record.policy;
    if (policy === undefined || typeof policy !== "object" || policy === null || Array.isArray(policy)) {
      return ;
    }
    const flatGroupId = policy.supervisionGroupId;
    if (typeof flatGroupId === "string" && flatGroupId.trim().length > 0) {
      return flatGroupId;
    }
    const supervision = policy.supervision;
    if (typeof supervision !== "object" || supervision === null || Array.isArray(supervision)) {
      return ;
    }
    const nestedGroupId = (supervision as Record<string, unknown>).groupId;
    return typeof nestedGroupId === "string" && nestedGroupId.trim().length > 0
      ? nestedGroupId
      : undefined;
  }

  private mapOutboxRow(row: {
    id: number;
    run_id: string;
    session_id: string;
    event_type: string;
    payload_json: Record<string, unknown>;
    status: OutboxEventRecord["status"];
    attempt_count: number;
    last_error: string | null;
    delivered_at: string | null;
    created_at: string;
  }): OutboxEventRecord {
    return {
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      eventType: row.event_type,
      payload: row.payload_json,
      status: row.status,
      attemptCount: row.attempt_count,
      lastError: row.last_error ?? undefined,
      deliveredAt: row.delivered_at ?? undefined,
      createdAt: row.created_at,
    };
  }

  private mapArtifactRow(row: ArtifactRow): PersistedArtifact {
    return {
      artifactId: row.artifact_id,
      runId: row.run_id,
      sessionId: row.session_id,
      stepIndex: row.step_index,
      type: row.artifact_type,
      payload: row.payload_json,
      createdAt: row.created_at,
    };
  }

  private mapRegionWorkItemRow(row: {
    id: number;
    session_id: string;
    region: string;
    step_agent: string;
    status: RegionWorkItem["status"];
    state_node_json: Record<string, unknown> | null;
    created_at: string;
    claimed_at: string | null;
    completed_at: string | null;
    error_json: Record<string, unknown> | null;
  }): RegionWorkItem {
    const stateNodeJson = row.state_node_json;
    const parent =
      stateNodeJson !== null && typeof stateNodeJson.parent === "string"
        ? stateNodeJson.parent
        : undefined;
    const child =
      stateNodeJson !== null && typeof stateNodeJson.child === "string"
        ? stateNodeJson.child
        : undefined;
    const region =
      stateNodeJson !== null && typeof stateNodeJson.region === "string"
        ? stateNodeJson.region
        : undefined;

    return {
      id: row.id,
      sessionId: row.session_id,
      region: row.region,
      stepAgent: row.step_agent,
      status: row.status,
      ...(parent !== undefined && child !== undefined
        ? {
            stateNode: {
              parent,
              child,
              ...(region !== undefined ? { region } : {}),
            },
          }
        : {}),
      createdAt: row.created_at,
      ...(row.claimed_at !== null ? { claimedAt: row.claimed_at } : {}),
      ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
      ...(row.error_json !== null ? { error: row.error_json } : {}),
    };
  }

  private async withTransaction<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    if (typeof this.db.transaction === "function") {
      return this.db.transaction(operation);
    }

    await this.db.query("BEGIN");
    try {
      const result = await operation(this.db);
      await this.db.query("COMMIT");
      return result;
    } catch (error) {
      await this.db.query("ROLLBACK");
      throw error;
    }
  }

  private async ensureSchemaV3(): Promise<void> {
    if (this.enforceSchemaV3 === false || this.schemaValidated) {
      return;
    }

    const result = await this.db.query<{
      has_schema_version: boolean;
      has_legacy_readonly: boolean;
      has_run_events: boolean;
      has_run_logs: boolean;
      has_region_work_items: boolean;
      has_claimed_at: boolean;
      has_completed_at: boolean;
      has_error_json: boolean;
      has_legacy_session_archives: boolean;
      has_current_state_json: boolean;
      has_active_run_id: boolean;
      has_active_run_started_at: boolean;
      has_state_patch_json: boolean;
      has_snapshot_kind: boolean;
      has_orchestration_threads: boolean;
      has_orchestration_delegations: boolean;
      has_orchestration_interaction_requests: boolean;
      has_orchestration_approval_grants: boolean;
      has_orchestration_context_summary_artifacts: boolean;
      has_orchestration_thread_compaction_events: boolean;
      has_orchestration_operator_focus: boolean;
      has_orchestration_operator_attention: boolean;
      has_orchestration_assembly_bundles: boolean;
      has_orchestration_thread_assembly_records: boolean;
      has_orchestration_assembly_change_proposals: boolean;
      has_assembly_proposal_requested_provider: boolean;
      has_assembly_proposal_requested_model: boolean;
      has_assembly_proposal_requested_prompt_variant: boolean;
      has_orchestration_assembly_change_decisions: boolean;
      has_orchestration_specialist_definitions: boolean;
      has_orchestration_context_policy_definitions: boolean;
      has_conversation_turns: boolean;
      has_conversation_turn_segments: boolean;
      has_model_call_provenance: boolean;
      has_session_product_state: boolean;
    }>(
      `SELECT
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'schema_version'
         ) AS has_schema_version,
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'legacy_readonly'
         ) AS has_legacy_readonly,
         to_regclass('public.run_events') IS NOT NULL AS has_run_events,
         to_regclass('public.run_logs') IS NOT NULL AS has_run_logs,
         to_regclass('public.region_work_items') IS NOT NULL AS has_region_work_items,
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'region_work_items' AND column_name = 'claimed_at'
         ) AS has_claimed_at,
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'region_work_items' AND column_name = 'completed_at'
         ) AS has_completed_at,
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'region_work_items' AND column_name = 'error_json'
         ) AS has_error_json,
         to_regclass('public.legacy_session_archives') IS NOT NULL AS has_legacy_session_archives,
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'current_state_json'
         ) AS has_current_state_json,
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'active_run_id'
         ) AS has_active_run_id,
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'active_run_started_at'
         ) AS has_active_run_started_at,
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'session_versions' AND column_name = 'state_patch_json'
         ) AS has_state_patch_json,
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'session_versions' AND column_name = 'snapshot_kind'
         ) AS has_snapshot_kind,
         to_regclass('public.orchestration_threads') IS NOT NULL AS has_orchestration_threads,
         to_regclass('public.orchestration_delegations') IS NOT NULL AS has_orchestration_delegations,
         to_regclass('public.orchestration_interaction_requests') IS NOT NULL AS has_orchestration_interaction_requests,
         to_regclass('public.orchestration_approval_grants') IS NOT NULL AS has_orchestration_approval_grants,
         to_regclass('public.orchestration_context_summary_artifacts') IS NOT NULL AS has_orchestration_context_summary_artifacts,
         to_regclass('public.orchestration_thread_compaction_events') IS NOT NULL AS has_orchestration_thread_compaction_events,
         to_regclass('public.orchestration_operator_focus') IS NOT NULL AS has_orchestration_operator_focus,
         to_regclass('public.orchestration_operator_attention') IS NOT NULL AS has_orchestration_operator_attention,
         to_regclass('public.orchestration_assembly_bundles') IS NOT NULL AS has_orchestration_assembly_bundles,
         to_regclass('public.orchestration_thread_assembly_records') IS NOT NULL AS has_orchestration_thread_assembly_records,
         to_regclass('public.orchestration_assembly_change_proposals') IS NOT NULL AS has_orchestration_assembly_change_proposals,
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'orchestration_assembly_change_proposals' AND column_name = 'requested_provider'
         ) AS has_assembly_proposal_requested_provider,
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'orchestration_assembly_change_proposals' AND column_name = 'requested_model'
         ) AS has_assembly_proposal_requested_model,
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'orchestration_assembly_change_proposals' AND column_name = 'requested_prompt_variant'
         ) AS has_assembly_proposal_requested_prompt_variant,
         to_regclass('public.orchestration_assembly_change_decisions') IS NOT NULL AS has_orchestration_assembly_change_decisions,
         to_regclass('public.orchestration_specialist_definitions') IS NOT NULL AS has_orchestration_specialist_definitions,
         to_regclass('public.orchestration_context_policy_definitions') IS NOT NULL AS has_orchestration_context_policy_definitions,
         to_regclass('public.conversation_turns') IS NOT NULL AS has_conversation_turns,
         to_regclass('public.conversation_turn_segments') IS NOT NULL AS has_conversation_turn_segments,
         to_regclass('public.model_call_provenance') IS NOT NULL AS has_model_call_provenance,
         to_regclass('public.session_product_state') IS NOT NULL AS has_session_product_state`,
    );

    const row = result.rows[0];
    if (
      row?.has_schema_version !== true ||
      row.has_legacy_readonly !== true ||
      row.has_run_events !== true ||
      row.has_run_logs !== true ||
      row.has_region_work_items !== true ||
      row.has_claimed_at !== true ||
      row.has_completed_at !== true ||
      row.has_error_json !== true ||
      row.has_legacy_session_archives !== true ||
      row.has_current_state_json !== true ||
      row.has_active_run_id !== true ||
      row.has_active_run_started_at !== true ||
      row.has_state_patch_json !== true ||
      row.has_snapshot_kind !== true ||
      row.has_orchestration_threads !== true ||
      row.has_orchestration_delegations !== true ||
      row.has_orchestration_interaction_requests !== true ||
      row.has_orchestration_approval_grants !== true ||
      row.has_orchestration_context_summary_artifacts !== true ||
      row.has_orchestration_thread_compaction_events !== true ||
      row.has_orchestration_operator_focus !== true ||
      row.has_orchestration_operator_attention !== true ||
      row.has_orchestration_assembly_bundles !== true ||
      row.has_orchestration_thread_assembly_records !== true ||
      row.has_orchestration_assembly_change_proposals !== true ||
      row.has_assembly_proposal_requested_provider !== true ||
      row.has_assembly_proposal_requested_model !== true ||
      row.has_assembly_proposal_requested_prompt_variant !== true ||
      row.has_orchestration_assembly_change_decisions !== true ||
      row.has_orchestration_specialist_definitions !== true ||
      row.has_orchestration_context_policy_definitions !== true ||
      row.has_conversation_turns !== true ||
      row.has_conversation_turn_segments !== true ||
      row.has_model_call_provenance !== true ||
      row.has_session_product_state !== true
    ) {
      throw createRuntimeFailure(
        "STORE_SCHEMA_V3_REQUIRED",
        "Kestrel schema v3 is required. Run database migrations before starting runtime.",
      );
    }

    this.schemaValidated = true;
  }
}

interface ConversationTurnRow {
  [key: string]: unknown;
  turn_id: string;
  thread_id: string;
  session_id: string;
  root_run_id: string | null;
  status: ConversationTurnRecord["status"];
  initial_event_type: string;
  active_run_id: string | null;
  terminal_run_id: string | null;
  terminal_status: TransitionStatus | null;
  metadata_json: Record<string, unknown> | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface ConversationTurnSegmentRow {
  [key: string]: unknown;
  segment_id: string;
  turn_id: string;
  thread_id: string;
  session_id: string;
  run_id: string;
  kind: ConversationTurnSegmentRecord["kind"];
  event_type: string;
  request_id: string | null;
  grant_id: string | null;
  message_hash: string;
  metadata_json: Record<string, unknown> | null;
  created_at: string;
}

interface ModelCallProvenanceRow {
  [key: string]: unknown;
  call_id: string;
  run_id: string;
  session_id: string;
  thread_id: string | null;
  turn_id: string | null;
  step_index: number | null;
  step_agent: string | null;
  phase: string | null;
  model: string | null;
  provider: string | null;
  response_format: string | null;
  schema_name: string | null;
  provider_payload_hash: string;
  component_hash: string;
  template_ids_json: string[] | null;
  tool_manifest_hash: string | null;
  assembly_id: string | null;
  source_bucket_hashes_json: Record<string, string> | null;
  metadata_json: Record<string, unknown> | null;
  status: ModelCallProvenanceRecord["status"];
  latency_ms: number | null;
  created_at: string;
  completed_at: string | null;
}

function mapConversationTurnRow(row: ConversationTurnRow): ConversationTurnRecord {
  return {
    turnId: row.turn_id,
    threadId: row.thread_id,
    sessionId: row.session_id,
    ...(row.root_run_id !== null ? { rootRunId: row.root_run_id } : {}),
    status: row.status,
    initialEventType: row.initial_event_type,
    ...(row.active_run_id !== null ? { activeRunId: row.active_run_id } : {}),
    ...(row.terminal_run_id !== null ? { terminalRunId: row.terminal_run_id } : {}),
    ...(row.terminal_status !== null ? { terminalStatus: row.terminal_status } : {}),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.metadata_json !== null ? { metadata: row.metadata_json } : {}),
  };
}

function mapConversationTurnSegmentRow(row: ConversationTurnSegmentRow): ConversationTurnSegmentRecord {
  return {
    segmentId: row.segment_id,
    turnId: row.turn_id,
    threadId: row.thread_id,
    sessionId: row.session_id,
    runId: row.run_id,
    kind: row.kind,
    eventType: row.event_type,
    ...(row.request_id !== null ? { requestId: row.request_id } : {}),
    ...(row.grant_id !== null ? { grantId: row.grant_id } : {}),
    messageHash: row.message_hash,
    createdAt: row.created_at,
    ...(row.metadata_json !== null ? { metadata: row.metadata_json } : {}),
  };
}

function mapModelCallProvenanceRow(row: ModelCallProvenanceRow): ModelCallProvenanceRecord {
  return {
    callId: row.call_id,
    runId: row.run_id,
    sessionId: row.session_id,
    ...(row.thread_id !== null ? { threadId: row.thread_id } : {}),
    ...(row.turn_id !== null ? { turnId: row.turn_id } : {}),
    ...(row.step_index !== null ? { stepIndex: row.step_index } : {}),
    ...(row.step_agent !== null ? { stepAgent: row.step_agent } : {}),
    ...(row.phase !== null ? { phase: row.phase } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.provider !== null ? { provider: row.provider } : {}),
    ...(row.response_format !== null ? { responseFormat: row.response_format } : {}),
    ...(row.schema_name !== null ? { schemaName: row.schema_name } : {}),
    providerPayloadHash: row.provider_payload_hash,
    componentHash: row.component_hash,
    ...(row.template_ids_json !== null ? { templateIds: row.template_ids_json } : {}),
    ...(row.tool_manifest_hash !== null ? { toolManifestHash: row.tool_manifest_hash } : {}),
    ...(row.assembly_id !== null ? { assemblyId: row.assembly_id } : {}),
    ...(row.source_bucket_hashes_json !== null ? { sourceBucketHashes: row.source_bucket_hashes_json } : {}),
    ...(row.metadata_json !== null ? { metadata: row.metadata_json } : {}),
    createdAt: row.created_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.latency_ms !== null ? { latencyMs: row.latency_ms } : {}),
    status: row.status,
  };
}
