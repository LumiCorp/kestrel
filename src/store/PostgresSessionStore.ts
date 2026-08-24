import type {
  EffectExecutionStatus,
  RuntimeError,
  TransitionStatus,
} from "../kestrel/contracts/base.js";
import {
  SandboxCapabilityExactResultCancelledError,
  SandboxCapabilityExactResultConflictError,
  exactEffectRequiresCapabilityTenantBinding,
  validateExactEffectCancellationCandidate,
  validateExactEffectCancellationTenantBinding,
  validateExactEffectResultRead,
  validateExactEffectResultTenantBinding,
} from "../kestrel/contracts/store.js";
import type {
  RunEvent,
  RunLogEntry,
  RuntimeEvent,
} from "../kestrel/contracts/events.js";
import type {
  CommitStepInput,
  CommitStepResult,
  ClaimConversationTurnExecutionInput,
  ClaimConversationTurnExecutionResult,
  GetArtifactInput,
  ListArtifactsInput,
  PersistedArtifact,
  PersistedClaim,
  PersistedRunRecord,
  PersistedRunSummaryRecord,
  PersistedRunStateRecord,
  ProviderReasoningEncryptedRecord,
  ProviderReasoningRecordKind,
  RunLifecycleSettlement,
  OutboxEventRecord,
  PersistedEffect,
  SessionProductStateRecord,
  SessionRecord,
  SessionStore,
  LegacySessionArchive,
  UpdateConversationTurnTerminalEnvelopeInput,
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
  ConversationTurnSuspensionEnvelopeV1,
  ConversationTurnTerminalEnvelopeV1,
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
import {
  assertSandboxCapabilityLeaseTransitionV1,
  fingerprintSandboxCapabilityLeaseBinding,
  parseSandboxCapabilityChildReservationV1,
  parseSandboxCapabilityLeaseTransitionRecordV1,
  type SandboxCapabilityChildReservationV1,
  type SandboxCapabilityLeaseTransitionRecordV1,
} from "../kestrel/contracts/sandbox-capability.js";
import { SessionBusyError, asRuntimeError, createRuntimeFailure } from "../runtime/RuntimeFailure.js";
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
import {
  buildCanonicalWaitingFor,
  readActiveWaitState,
  type CanonicalRuntimeWaitingFor,
} from "../runtime/waitState.js";
import { PostgresOrchestrationStore } from "../orchestration/PostgresOrchestrationStore.js";
import {
  normalizeProjectSnapshot,
  readProjectSnapshotFromRuntimeState,
} from "../project/state.js";
import type { ProductProjectSnapshot } from "../project/contracts.js";
import type {
  MissionControlLegacyProjectSource,
  MissionControlMigrationSourceBinding,
} from "../missionControl/migrationContracts.js";
import { requireMissionControlMigrationFingerprint } from "../missionControl/migrationContracts.js";
import { parseMissionControlLegacyProjectSnapshot } from "../missionControl/legacyContracts.js";
import {
  MISSION_CONTROL_AUTHORITY_EPOCH,
  MISSION_CONTROL_PROJECT_SCHEMA_VERSION,
  assertMissionControlExpectedRevision,
  assertMissionControlReceiptFingerprint,
  createEmptyMissionControlProjectDocument,
  parseMissionControlPersistedMutationResult,
  parseMissionControlProjectDocument,
  parseMissionControlProjectStateRecord,
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

interface QueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

interface PostgresSessionStoreOptions {
  enforceSchemaV3?: boolean | undefined;
  tenantId?: string | undefined;
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

type MissionControlProjectRow = Record<string, unknown> & {
  project_id: string;
  schema_version: number;
  revision: number | string;
  authority_epoch: number | string;
  document_json: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type MissionControlReceiptRow = Record<string, unknown> & {
  request_fingerprint: string;
  result_json: unknown;
};

type MissionControlOutboxRow = Record<string, unknown> & {
  id: number | string;
  project_id: string;
  action_id: string;
  effect_id: string;
  effect_type: string;
  payload_json: unknown;
  status: string;
  attempt_count: number | string;
  last_error: string | null;
  created_at: unknown;
};

type MissionControlMigrationBindingRow = Record<string, unknown> & {
  source_id: string;
  project_id: string;
  source_fingerprint: string;
  action_id: string;
  bound_at: unknown;
};

function readMissionControlRunCorrelation(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const record = value as Record<string, unknown>;
  const projectId = readNonEmptyString(record.projectId);
  const itemId = readNonEmptyString(record.itemId);
  const attemptId = readNonEmptyString(record.attemptId);
  const commandId = readNonEmptyString(record.commandId);
  const runId = readNonEmptyString(record.runId);
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
  private readonly tenantId: string | undefined;
  private schemaValidated = false;

  constructor(db: SqlExecutor, options: PostgresSessionStoreOptions = {}) {
    this.db = db;
    this.enforceSchemaV3 = options.enforceSchemaV3 ?? false;
    this.tenantId = options.tenantId?.trim() || undefined;
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

  async getMissionControlProjectState(
    projectIdValue: string,
  ): Promise<MissionControlProjectStateRecord | null> {
    await this.ensureSchemaV3();
    const projectId = requireMissionControlProjectId(projectIdValue);
    const result = await this.db.query<MissionControlProjectRow>(
      `SELECT project_id, schema_version, revision, authority_epoch,
              document_json, created_at, updated_at
         FROM mission_control_projects
        WHERE project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.mapMissionControlProjectRow(row);
  }

  async listMissionControlLegacySources(): Promise<
    MissionControlLegacyProjectSource[]
  > {
    await this.ensureSchemaV3();
    const result = await this.db.query<
      Record<string, unknown> & {
        session_id: string;
        current_version: number | string;
        current_state_json: Record<string, unknown> | null;
        product_version: number | string | null;
        project_snapshot_json: Record<string, unknown> | null;
      }
    >(
      `SELECT sessions.session_id,
              sessions.current_version,
              sessions.current_state_json,
              session_product_state.version AS product_version,
              session_product_state.project_snapshot_json
         FROM sessions
         LEFT JOIN session_product_state
           ON session_product_state.session_id = sessions.session_id
        ORDER BY sessions.session_id ASC`,
    );
    const sources: MissionControlLegacyProjectSource[] = [];
    for (const row of result.rows) {
      const snapshot =
        row.project_snapshot_json === null
          ? parseMissionControlLegacyProjectSnapshot(
              this.asRecord(
                this.asRecord(row.current_state_json)?.product,
              )?.projectSnapshot,
            )
          : parseMissionControlLegacyProjectSnapshot(row.project_snapshot_json);
      const hasDedicated = row.project_snapshot_json !== null;
      const state = this.asRecord(row.current_state_json) ?? {};
      const product = this.asRecord(state.product) ?? {};
      if (hasDedicated === false && product.projectSnapshot === undefined) {
        continue;
      }
      const projectPath = snapshot.setup.workspaceRoot.trim();
      sources.push({
        sourceId: `session:${row.session_id}`,
        kind: "session_snapshot",
        sessionId: row.session_id,
        sourceVersion: this.normalizeSafeInteger(
          hasDedicated ? (row.product_version ?? 0) : row.current_version,
          "Mission Control legacy source version",
        ),
        ...(projectPath.length === 0 ? {} : { projectPath }),
        snapshot,
      });
    }
    return sources;
  }

  async listMissionControlMigrationSourceBindings(): Promise<
    MissionControlMigrationSourceBinding[]
  > {
    await this.ensureSchemaV3();
    const result = await this.db.query<MissionControlMigrationBindingRow>(
      `SELECT source_id, project_id, source_fingerprint, action_id, bound_at
         FROM mission_control_migration_source_bindings
        ORDER BY source_id ASC`,
    );
    return result.rows.map((row) => ({
      sourceId: row.source_id,
      projectId: requireMissionControlProjectId(row.project_id),
      sourceFingerprint: requireMissionControlMigrationFingerprint(
        row.source_fingerprint,
      ),
      actionId: requireMissionControlActionId(row.action_id),
      boundAt: normalizeTimestampString(row.bound_at),
    }));
  }

  async updateMissionControlProjectState(
    input: MissionControlProjectMutationInput,
  ): Promise<MissionControlProjectMutationResult> {
    await this.ensureSchemaV3();
    const projectId = requireMissionControlProjectId(input.projectId);
    const actionId = requireMissionControlActionId(input.actionId);
    const requestFingerprint = requireMissionControlRequestFingerprint(
      input.requestFingerprint,
    );
    const expectedRevision = requireMissionControlExpectedRevision(
      input.expectedRevision,
    );
    return this.withMissionControlTransaction(async (executor) => {
      const empty = createEmptyMissionControlProjectDocument(projectId);
      await executor.query(
        `INSERT INTO mission_control_projects (
           project_id, schema_version, revision, authority_epoch, document_json
         ) VALUES ($1, $2, 0, $3, $4::jsonb)
         ON CONFLICT (project_id) DO NOTHING`,
        [
          projectId,
          MISSION_CONTROL_PROJECT_SCHEMA_VERSION,
          MISSION_CONTROL_AUTHORITY_EPOCH,
          stringifySanitizedJson(empty),
        ],
      );

      const projectResult = await executor.query<MissionControlProjectRow>(
        `SELECT project_id, schema_version, revision, authority_epoch,
                document_json, created_at, updated_at
           FROM mission_control_projects
          WHERE project_id = $1
          FOR UPDATE`,
        [projectId],
      );
      const projectRow = projectResult.rows[0];
      if (projectRow === undefined) {
        throw new Error(
          `Mission Control project ${projectId} could not be locked.`,
        );
      }

      const receiptResult = await executor.query<MissionControlReceiptRow>(
        `SELECT request_fingerprint, result_json
           FROM mission_control_action_receipts
          WHERE project_id = $1 AND action_id = $2`,
        [projectId, actionId],
      );
      const priorReceipt = receiptResult.rows[0];
      if (priorReceipt !== undefined) {
        assertMissionControlReceiptFingerprint(
          actionId,
          priorReceipt.request_fingerprint,
          requestFingerprint,
        );
        return {
          ...parseMissionControlPersistedMutationResult(
            priorReceipt.result_json,
          ),
          duplicate: true,
        };
      }

      const current = this.mapMissionControlProjectRow(projectRow);
      assertMissionControlExpectedRevision(
        current.revision,
        expectedRevision,
      );
      const transition = input.apply(structuredClone(current.document));
      const document = parseMissionControlProjectDocument(
        transition.document,
        projectId,
      );
      const updatedResult = await executor.query<MissionControlProjectRow>(
        `UPDATE mission_control_projects
            SET revision = revision + 1,
                document_json = $2::jsonb,
                updated_at = NOW()
          WHERE project_id = $1
          RETURNING project_id, schema_version, revision, authority_epoch,
                    document_json, created_at, updated_at`,
        [
          projectId,
          stringifySanitizedJson(document),
        ],
      );
      const updatedRow = updatedResult.rows[0];
      if (updatedRow === undefined) {
        throw new Error(
          `Mission Control project ${projectId} could not be updated.`,
        );
      }

      const effects: MissionControlOutboxRecord[] = [];
      for (const effect of transition.effects) {
        if (
          effect.effectId.trim().length === 0 ||
          effect.effectType.trim().length === 0
        ) {
          throw new Error(
            "Mission Control outbox effectId and effectType are required.",
          );
        }
        const inserted = await executor.query<MissionControlOutboxRow>(
          `INSERT INTO mission_control_outbox (
             project_id, action_id, effect_id, effect_type, payload_json
           ) VALUES ($1, $2, $3, $4, $5::jsonb)
           RETURNING id, project_id, action_id, effect_id, effect_type,
                     payload_json, status, attempt_count, last_error, created_at`,
          [
            projectId,
            actionId,
            effect.effectId,
            effect.effectType,
            stringifySanitizedJson(effect.payload),
          ],
        );
        const effectRow = inserted.rows[0];
        if (effectRow === undefined) {
          throw new Error(
            `Mission Control effect ${effect.effectId} could not be persisted.`,
          );
        }
        effects.push(this.mapMissionControlOutboxRow(effectRow));
      }

      const result: MissionControlPersistedMutationResult = {
        project: this.mapMissionControlProjectRow(updatedRow),
        effects,
      };
      await executor.query(
        `INSERT INTO mission_control_action_receipts (
           project_id, action_id, request_fingerprint, result_json
         ) VALUES ($1, $2, $3, $4::jsonb)`,
        [
          projectId,
          actionId,
          requestFingerprint,
          stringifySanitizedJson(result),
        ],
      );
      return {
        ...result,
        duplicate: false,
      };
    });
  }

  async listMissionControlOutbox(
    projectIdValue: string,
  ): Promise<MissionControlOutboxRecord[]> {
    await this.ensureSchemaV3();
    const projectId = requireMissionControlProjectId(projectIdValue);
    const result = await this.db.query<MissionControlOutboxRow>(
      `SELECT id, project_id, action_id, effect_id, effect_type,
              payload_json, status, attempt_count, last_error, created_at
         FROM mission_control_outbox
        WHERE project_id = $1
        ORDER BY id ASC`,
      [projectId],
    );
    return result.rows.map((row) => this.mapMissionControlOutboxRow(row));
  }

  async markMissionControlOutboxDelivered(
    projectIdValue: string,
    effectIdValue: string,
  ): Promise<void> {
    await this.ensureSchemaV3();
    const projectId = requireMissionControlProjectId(projectIdValue);
    const effectId = requireMissionControlActionId(effectIdValue);
    const result = await this.db.query(
      `UPDATE mission_control_outbox
          SET status = 'DELIVERED',
              last_error = NULL,
              delivered_at = NOW()
        WHERE project_id = $1
          AND effect_id = $2`,
      [projectId, effectId],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Mission Control outbox effect not found: ${effectId}.`);
    }
  }

  async recordMissionControlOutboxFailure(
    projectIdValue: string,
    effectIdValue: string,
    errorValue: string,
  ): Promise<void> {
    await this.ensureSchemaV3();
    const projectId = requireMissionControlProjectId(projectIdValue);
    const effectId = requireMissionControlActionId(effectIdValue);
    const error = errorValue.trim();
    if (error.length === 0) {
      throw new Error("Mission Control outbox failure must not be empty.");
    }
    const result = await this.db.query(
      `UPDATE mission_control_outbox
          SET status = 'PENDING',
              attempt_count = attempt_count + 1,
              last_error = $3,
              delivered_at = NULL
        WHERE project_id = $1
          AND effect_id = $2`,
      [projectId, effectId, error],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Mission Control outbox effect not found: ${effectId}.`);
    }
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
      started_at: string | Date;
      completed_at: string | Date | null;
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
      started_at: string | Date;
      completed_at: string | Date | null;
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
      started_at: string | Date;
      completed_at: string | Date | null;
      error_json: Record<string, unknown> | null;
      event_count: number | string;
      thread_id: string | null;
      mission_control_json: unknown;
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
              ) AS thread_id,
              (
                SELECT run_events.metadata_json -> 'missionControl'
                  FROM run_events
                 WHERE run_events.run_id = selected_runs.run_id
                   AND run_events.event_type = 'run.started'
                   AND run_events.metadata_json -> 'missionControl' IS NOT NULL
                 ORDER BY run_events.occurred_at ASC, run_events.id ASC
                 LIMIT 1
              ) AS mission_control_json
         FROM selected_runs
        ORDER BY selected_runs.started_at DESC`,
      values,
    );
    return result.rows.map((row) => ({
      run: this.mapRunRow(row),
      eventCount: Number(row.event_count),
      ...(row.thread_id !== null ? { threadId: row.thread_id } : {}),
      ...(readMissionControlRunCorrelation(row.mission_control_json) === undefined
        ? {}
        : {
            missionControl: readMissionControlRunCorrelation(
              row.mission_control_json,
            )!,
          }),
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
        `INSERT INTO runs (run_id, session_id, event_type, status, tenant_id, tenant_ownership_state)
         VALUES ($1, $2, $3, 'RUNNING', $4, $5)`,
        [runId, event.sessionId, event.type, this.tenantId ?? null, this.tenantId === undefined ? "explicit_unbound" : "tenant_bound"],
      );
    });
  }

  async validatePrestartedRun(runId: string, event: RuntimeEvent): Promise<void> {
    await this.ensureSchemaV3();
    await this.withTransaction(async (executor) => {
      const session = await executor.query<{ active_run_id: string | null }>(
        `SELECT active_run_id FROM sessions WHERE session_id = $1 FOR UPDATE`,
        [event.sessionId],
      );
      const run = await executor.query<{
        session_id: string; event_type: string; status: string; tenant_id: string | null;
        tenant_ownership_state: "legacy_unknown" | "explicit_unbound" | "tenant_bound";
      }>(
        `SELECT session_id, event_type, status, tenant_id, tenant_ownership_state FROM runs WHERE run_id = $1 FOR UPDATE`,
        [runId],
      );
      const row = run.rows[0];
      const effects = await executor.query<{ tenant_id: string | null; tenant_ownership_state: string }>(
        `SELECT tenant_id, tenant_ownership_state FROM effects WHERE run_id = $1 FOR UPDATE`,
        [runId],
      );
      if (
        row === undefined || row.session_id !== event.sessionId || row.event_type !== event.type ||
        row.status !== "RUNNING" || session.rows[0]?.active_run_id !== runId ||
        row.tenant_ownership_state === "legacy_unknown" ||
        (row.tenant_ownership_state === "tenant_bound"
          ? this.tenantId === undefined || row.tenant_id !== this.tenantId
          : this.tenantId !== undefined || row.tenant_id !== null) ||
        effects.rows.some((effect) =>
          effect.tenant_ownership_state !== row.tenant_ownership_state || effect.tenant_id !== row.tenant_id)
      ) {
        throw createRuntimeFailure(
          "PRESTARTED_RUN_INVALID",
          `Run '${runId}' is not a valid prestarted run for session '${event.sessionId}'.`,
          { runId, sessionId: event.sessionId, eventType: event.type },
        );
      }
    });
  }

  async recoverOrphanedActiveRun(sessionId: string): Promise<{ runId?: string | undefined }> {
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

      const orphanError: RuntimeError = {
        code: "RUNNER_ORPHANED_ACTIVE_RUN",
        message: "The process-owned runner no longer has a live execution for this persisted run.",
        details: { sessionId: session.sessionId, runId: session.activeRunId },
      };
      await this.projectRecoveredRunWithExecutor(executor, session, {
        runId: session.activeRunId,
        status: "FAILED",
        error: orphanError,
      });
      return { runId: session.activeRunId };
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

  async getPersistedEffect(idempotencyKey: string): Promise<PersistedEffect | null> {
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
        WHERE e.idempotency_key = $1
        LIMIT 1`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : {
      runId: row.run_id,
      sessionId: row.session_id,
      stepIndex: row.step_index,
      type: row.effect_type,
      payload: row.payload_json,
      idempotencyKey: row.idempotency_key,
      failurePolicy: row.failure_policy,
      status: row.status,
      createdAt: row.created_at,
    };
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
      ...(row.output_json === null ? {} : { output: row.output_json }),
      ...(row.error_json === null ? {} : { error: row.error_json }),
      timestamp: normalizeTimestampString(row.created_at),
    };
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
    await this.ensureSchemaV3();
    return this.withTransaction(async (executor) => {
      const effectResult = await executor.query<{
        run_id: string; session_id: string; step_index: number; effect_type: string;
        payload_json: Record<string, unknown>; idempotency_key: string;
        failure_policy: PersistedEffect["failurePolicy"]; status: PersistedEffect["status"]; created_at: string; tenant_id: string | null;
        tenant_ownership_state: "legacy_unknown" | "explicit_unbound" | "tenant_bound";
      }>(
        `SELECT run_id, session_id, step_index, effect_type, payload_json,
                idempotency_key, failure_policy, status, created_at, tenant_id, tenant_ownership_state
           FROM effects WHERE idempotency_key = $1 FOR UPDATE`,
        [input.idempotencyKey],
      );
      const row = effectResult.rows[0];
      const effect: PersistedEffect | null = row === undefined ? null : {
        runId: row.run_id, sessionId: row.session_id, stepIndex: row.step_index,
        type: row.effect_type, payload: row.payload_json, idempotencyKey: row.idempotency_key,
        failurePolicy: row.failure_policy, status: row.status, createdAt: normalizeTimestampString(row.created_at),
      };
      const candidate = validateExactEffectCancellationCandidate({ requested: input, effect });
      if (candidate !== "ready") return { status: candidate } as const;
      if (effect === null) return { status: "not_found" } as const;
      if (row?.tenant_ownership_state === "explicit_unbound") return { status: "conflict" } as const;
      if (row?.tenant_id !== null && row?.tenant_id !== input.tenantId) return { status: "not_found" } as const;
      const requiresTenantBinding = exactEffectRequiresCapabilityTenantBinding(effect);
      if (row?.tenant_id === null &&
        (row?.tenant_ownership_state !== "legacy_unknown" || !requiresTenantBinding)) {
        return { status: "conflict" } as const;
      }
      const leaseResult = requiresTenantBinding
        ? await executor.query<{ record_json: unknown }>(
        `SELECT transition.record_json
           FROM sandbox_capability_leases lease
           JOIN sandbox_capability_lease_transitions transition
             ON transition.lease_id = lease.lease_id AND transition.sequence = lease.sequence
          WHERE transition.record_json->'binding'->>'sessionId' = $1
            AND transition.record_json->'binding'->>'runId' = $2
            AND transition.record_json->'binding'->>'toolCallId' = $3
          LIMIT 2
          FOR UPDATE OF lease`,
        [input.sessionId, input.runId, input.idempotencyKey],
      )
        : { rows: [] };
      if (requiresTenantBinding && leaseResult.rows.length > 1) return { status: "conflict" } as const;
      let lease: SandboxCapabilityLeaseTransitionRecordV1 | null = null;
      try {
        lease = leaseResult.rows[0] === undefined
          ? null
          : parseSandboxCapabilityLeaseTransitionRecordV1(leaseResult.rows[0].record_json);
      } catch {
        return { status: "conflict" } as const;
      }
      if (requiresTenantBinding) {
        const tenantBinding = validateExactEffectCancellationTenantBinding({ requested: input, lease });
        if (tenantBinding !== "ready") return { status: tenantBinding } as const;
      }
      const recordedResult = await executor.query<{
        idempotency_key: string; status: "DONE" | "FAILED"; output_json: unknown;
        error_json: RuntimeError | null; created_at: string;
      }>(
        `SELECT idempotency_key, status, output_json, error_json, created_at
           FROM effect_results WHERE idempotency_key = $1 FOR UPDATE`,
        [input.idempotencyKey],
      );
      const resultRow = recordedResult.rows[0];
      if (resultRow !== undefined) {
        const recorded: EffectResult = {
          idempotencyKey: resultRow.idempotency_key,
          status: resultRow.status,
          ...(resultRow.output_json === null ? {} : { output: resultRow.output_json }),
          ...(resultRow.error_json === null ? {} : { error: resultRow.error_json }),
          timestamp: normalizeTimestampString(resultRow.created_at),
        };
        const read = validateExactEffectResultRead({
          requested: input,
          effect: { ...effect, status: "DONE" },
          effectResult: recorded,
        });
        const tenantRead = requiresTenantBinding
          ? validateExactEffectResultTenantBinding({ read, requested: input, lease })
          : read;
        return {
          status: tenantRead.status === "found"
            ? "completed"
            : tenantRead.status === "not_found" ? "not_found" : "conflict",
        } as const;
      }
      if (effect.status !== "PENDING") return { status: "conflict" } as const;
      await executor.query(
        `UPDATE effects SET status = 'FAILED' WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      return { status: "cancelled" } as const;
    });
  }

  async saveEffectResult(
    runId: string,
    sessionId: string,
    result: EffectResult,
  ): Promise<void> {
    await this.ensureSchemaV3();
    await this.withTransaction(async (executor) => {
      const effect = await executor.query<{
        run_id: string; session_id: string; status: PersistedEffect["status"];
        tenant_id: string | null; tenant_ownership_state: "legacy_unknown" | "explicit_unbound" | "tenant_bound";
        effect_type: string; payload_json: Record<string, unknown>;
        step_index: number; failure_policy: PersistedEffect["failurePolicy"]; created_at: string;
      }>(
        `SELECT run_id, session_id, status, tenant_id, tenant_ownership_state, effect_type, payload_json,
                step_index, failure_policy, created_at
           FROM effects WHERE idempotency_key = $1 FOR UPDATE`,
        [result.idempotencyKey],
      );
      const row = effect.rows[0];
      if (row === undefined || row.run_id !== runId || row.session_id !== sessionId) {
        throw new SandboxCapabilityExactResultConflictError("Effect result owner does not match the locked effect");
      }
      if (result.status === "DONE" && row.status === "FAILED") {
        throw new SandboxCapabilityExactResultCancelledError("Completed effect-result persistence lost to durable cancellation");
      }
      if (!await this.hasTrustedPostgresEffectTenant(executor, {
        runId: row.run_id, sessionId: row.session_id, stepIndex: row.step_index,
        type: row.effect_type, payload: row.payload_json, idempotencyKey: result.idempotencyKey,
        failurePolicy: row.failure_policy, status: row.status, createdAt: normalizeTimestampString(row.created_at),
      }, row.tenant_id, row.tenant_ownership_state, result)) {
        throw new SandboxCapabilityExactResultConflictError("Effect result tenant does not match durable authority");
      }
      await executor.query(
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
    });
  }

  async markEffectStatus(
    idempotencyKey: string,
    status: EffectExecutionStatus,
    owner: { runId: string; sessionId: string },
  ): Promise<void> {
    await this.ensureSchemaV3();
    await this.withTransaction(async (executor) => {
      const effect = await executor.query<{
        run_id: string; session_id: string; status: PersistedEffect["status"];
        tenant_id: string | null; tenant_ownership_state: "legacy_unknown" | "explicit_unbound" | "tenant_bound";
        effect_type: string; payload_json: Record<string, unknown>;
        step_index: number; failure_policy: PersistedEffect["failurePolicy"]; created_at: string;
      }>(
        `SELECT run_id, session_id, status, tenant_id, tenant_ownership_state, effect_type, payload_json,
                step_index, failure_policy, created_at
           FROM effects WHERE idempotency_key = $1 FOR UPDATE`,
        [idempotencyKey],
      );
      const row = effect.rows[0];
      if (row === undefined || row.run_id !== owner.runId || row.session_id !== owner.sessionId) {
        throw new SandboxCapabilityExactResultConflictError("Effect status owner or tenant does not match the locked effect");
      }
      if (status === "DONE" && row?.status === "FAILED") {
        const exactResult = await executor.query<{ status: "DONE" | "FAILED" }>(
          `SELECT status FROM effect_results WHERE idempotency_key = $1 FOR UPDATE`,
          [idempotencyKey],
        );
        if (exactResult.rows[0]?.status !== "DONE") {
          throw new SandboxCapabilityExactResultCancelledError("Completed effect status lost to durable cancellation");
        }
      }
      if (!await this.hasTrustedPostgresEffectTenant(executor, {
        runId: row.run_id, sessionId: row.session_id, stepIndex: row.step_index,
        type: row.effect_type, payload: row.payload_json, idempotencyKey,
        failurePolicy: row.failure_policy, status: row.status, createdAt: normalizeTimestampString(row.created_at),
      }, row.tenant_id, row.tenant_ownership_state)) {
        throw new SandboxCapabilityExactResultConflictError("Effect status owner or tenant does not match durable authority");
      }
      await executor.query(
        `UPDATE effects SET status = $2 WHERE idempotency_key = $1`,
        [idempotencyKey, status],
      );
    });
  }

  private async hasTrustedPostgresEffectTenant(
    executor: SqlExecutor,
    effect: PersistedEffect,
    persistedTenantId: string | null,
    ownershipState: "legacy_unknown" | "explicit_unbound" | "tenant_bound",
    result?: EffectResult | undefined,
  ): Promise<boolean> {
    if (this.tenantId === undefined) {
      return ownershipState === "explicit_unbound" && persistedTenantId === null;
    }
    if (persistedTenantId !== null) {
      return ownershipState === "tenant_bound" && persistedTenantId === this.tenantId;
    }
    if (ownershipState !== "legacy_unknown") return false;
    if (!exactEffectRequiresCapabilityTenantBinding(effect)) return false;
    const leases = await executor.query<{ record_json: unknown }>(
      `SELECT transition.record_json
         FROM sandbox_capability_leases lease
         JOIN sandbox_capability_lease_transitions transition
           ON transition.lease_id = lease.lease_id AND transition.sequence = lease.sequence
        WHERE transition.record_json->'binding'->>'sessionId' = $1
          AND transition.record_json->'binding'->>'runId' = $2
          AND transition.record_json->'binding'->>'toolCallId' = $3
        LIMIT 2
        FOR UPDATE OF lease`,
      [effect.sessionId, effect.runId, effect.idempotencyKey],
    );
    if (leases.rows.length !== 1) return false;
    const lease = parseSandboxCapabilityLeaseTransitionRecordV1(leases.rows[0]!.record_json);
    if (validateExactEffectCancellationTenantBinding({
      requested: { runId: effect.runId, sessionId: effect.sessionId, idempotencyKey: effect.idempotencyKey, tenantId: this.tenantId },
      lease,
    }) !== "ready") return false;
    if (result === undefined || result.status === "FAILED") return true;
    const read = validateExactEffectResultRead({
      requested: { runId: effect.runId, sessionId: effect.sessionId, idempotencyKey: effect.idempotencyKey },
      effect: { ...effect, status: "DONE" }, effectResult: result,
    });
    return validateExactEffectResultTenantBinding({
      read,
      requested: { runId: effect.runId, sessionId: effect.sessionId, idempotencyKey: effect.idempotencyKey, tenantId: this.tenantId },
      lease,
    }).status === "found";
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

  async appendSandboxCapabilityLeaseTransition(input: {
    expectedSequence: number;
    record: SandboxCapabilityLeaseTransitionRecordV1;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    await this.ensureSchemaV3();
    return this.withTransaction((executor) =>
      this.appendSandboxCapabilityLeaseTransitionWithExecutor(executor, input));
  }

  async issueSandboxCapabilityLease(input: {
    expectedSequence: number;
    record: SandboxCapabilityLeaseTransitionRecordV1;
    childReservation?: SandboxCapabilityChildReservationV1 | undefined;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    await this.ensureSchemaV3();
    const record = parseSandboxCapabilityLeaseTransitionRecordV1(input.record);
    if (record.transition !== "issued") throw new Error("Sandbox capability issuance must transition to issued");
    return this.withTransaction(async (executor) => {
      if (input.childReservation !== undefined) {
        await this.reserveSandboxCapabilityChildWithExecutor(executor, {
          reservation: input.childReservation,
        });
      }
      return this.appendSandboxCapabilityLeaseTransitionWithExecutor(executor, {
        expectedSequence: input.expectedSequence,
        record,
      });
    });
  }

  async reserveSandboxCapabilityInvocation(input: {
    expectedSequence: number;
    record: SandboxCapabilityLeaseTransitionRecordV1;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1 & { invocationResponseByteLimit: number }> {
    await this.ensureSchemaV3();
    const record = parseSandboxCapabilityLeaseTransitionRecordV1(input.record);
    if (record.transition !== "invoking") throw new Error("Sandbox capability invocation must transition to invoking");
    return this.withTransaction(async (executor) => {
      const parent = await executor.query<{ sequence: number | string }>(
        `SELECT sequence FROM sandbox_capability_leases WHERE lease_id=$1 FOR UPDATE`,
        [record.leaseId],
      );
      if (Number(parent.rows[0]?.sequence) !== input.expectedSequence) {
        throw new Error("Sandbox capability lease transition sequence conflict");
      }
      const allocated = await postgresChildCapacity(executor, record.leaseId);
      const invocationResponseByteLimit = record.usage.responseByteLimit - record.usage.responseBytesConsumed - allocated.bytes;
      if (record.usage.requestsConsumed + allocated.requests > record.usage.requestLimit || invocationResponseByteLimit <= 0) {
        throw new Error("Sandbox capability parent ceiling is reserved by child authority");
      }
      return { ...await this.appendSandboxCapabilityLeaseTransitionWithExecutor(executor, input), invocationResponseByteLimit };
    });
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
      result: JSON.parse(canonicalStoreJson(input.result)) as EffectResult,
    };
    await this.ensureSchemaV3();
    await this.withTransaction(async (executor) => {
      const effectResult = await executor.query<{
        run_id: string; session_id: string; step_index: number; effect_type: string;
        payload_json: Record<string, unknown>; idempotency_key: string;
        failure_policy: PersistedEffect["failurePolicy"]; status: PersistedEffect["status"]; created_at: string;
        tenant_id: string | null;
        tenant_ownership_state: "legacy_unknown" | "explicit_unbound" | "tenant_bound";
      }>(
        `SELECT run_id, session_id, step_index, effect_type, payload_json,
                idempotency_key, failure_policy, status, created_at, tenant_id, tenant_ownership_state
           FROM effects WHERE idempotency_key = $1 FOR UPDATE`,
        [exactInput.toolCallId],
      );
      const effectRow = effectResult.rows[0];
      const effect: PersistedEffect | null = effectRow === undefined ? null : {
        runId: effectRow.run_id, sessionId: effectRow.session_id, stepIndex: effectRow.step_index,
        type: effectRow.effect_type, payload: effectRow.payload_json, idempotencyKey: effectRow.idempotency_key,
        failurePolicy: effectRow.failure_policy, status: effectRow.status,
        createdAt: normalizeTimestampString(effectRow.created_at),
      };
      const candidate = validateExactEffectCancellationCandidate({
        requested: { sessionId: exactInput.sessionId, runId: exactInput.runId, idempotencyKey: exactInput.toolCallId },
        effect,
      });
      if (candidate !== "ready") {
        throw new SandboxCapabilityExactResultConflictError("Sandbox capability exact result has no matching prepared effect");
      }
      if (effect?.status === "FAILED") {
        throw new SandboxCapabilityExactResultCancelledError("Sandbox capability exact-result persistence was cancelled");
      }
      const leaseResult = await executor.query<{ record_json: unknown }>(
        `SELECT transition.record_json
           FROM sandbox_capability_leases lease
           JOIN sandbox_capability_lease_transitions transition
             ON transition.lease_id = lease.lease_id AND transition.sequence = lease.sequence
          WHERE lease.lease_id = $1
          FOR UPDATE OF lease`,
        [exactInput.leaseId],
      );
      const lease = leaseResult.rows[0] === undefined
        ? undefined
        : parseSandboxCapabilityLeaseTransitionRecordV1(leaseResult.rows[0].record_json);
      assertReplayableSandboxCapabilityEffectBinding(lease, exactInput);
      if (
        this.tenantId === undefined ||
        lease?.binding.tenantId !== this.tenantId ||
        effectRow === undefined ||
        (effectRow.tenant_ownership_state === "tenant_bound"
          ? effectRow.tenant_id !== this.tenantId
          : effectRow.tenant_ownership_state !== "legacy_unknown" || effectRow.tenant_id !== null)
      ) {
        throw new SandboxCapabilityExactResultConflictError("Sandbox capability effect result tenant does not match durable authority");
      }
      const existing = await executor.query<{
        idempotency_key: string;
        status: "DONE" | "FAILED";
        output_json: unknown;
        error_json: RuntimeError | null;
        created_at: string;
      }>(
        `SELECT idempotency_key, status, output_json, error_json, created_at
           FROM effect_results WHERE idempotency_key = $1 FOR UPDATE`,
        [exactInput.result.idempotencyKey],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        const recorded: EffectResult = {
          idempotencyKey: row.idempotency_key,
          status: row.status,
          ...(row.output_json === null ? {} : { output: row.output_json }),
          ...(row.error_json === null ? {} : { error: row.error_json }),
          timestamp: normalizeTimestampString(row.created_at),
        };
        if (canonicalStoreJson(recorded) !== canonicalStoreJson(exactInput.result)) {
          throw new SandboxCapabilityExactResultConflictError("Sandbox capability effect result conflicts with recorded exact replay output");
        }
        return;
      }
      throwIfSandboxCapabilityResultPersistenceCancelled(input.signal);
      await executor.query(
        `INSERT INTO effect_results
          (run_id, session_id, idempotency_key, status, output_json, error_json, created_at)
         VALUES ($1, $2, $3, 'DONE', $4::jsonb, NULL, $5::timestamptz)`,
        [
          exactInput.runId,
          exactInput.sessionId,
          exactInput.result.idempotencyKey,
          stringifySanitizedJson(exactInput.result.output ?? null),
          normalizeTimestampString(exactInput.result.timestamp),
        ],
      );
      throwIfSandboxCapabilityResultPersistenceCancelled(input.signal);
    });
  }

  private async appendSandboxCapabilityLeaseTransitionWithExecutor(
    executor: SqlExecutor,
    input: { expectedSequence: number; record: SandboxCapabilityLeaseTransitionRecordV1 },
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    const record = parseSandboxCapabilityLeaseTransitionRecordV1(input.record);
    if (record.bindingDigest !== fingerprintSandboxCapabilityLeaseBinding(record.binding)) {
      throw new Error("Sandbox capability lease binding digest does not match the immutable binding");
    }
    if (record.sequence !== input.expectedSequence + 1) {
      throw new Error("Sandbox capability lease transition sequence conflict");
    }
      const currentResult = await executor.query<{ sequence: number | string; transition: string; binding_digest: string }>(
        `SELECT sequence, transition, binding_digest FROM sandbox_capability_leases WHERE lease_id = $1 FOR UPDATE`,
        [record.leaseId],
      );
      const current = currentResult.rows[0];
      if ((current === undefined ? 0 : Number(current.sequence)) !== input.expectedSequence) {
        throw new Error("Sandbox capability lease transition sequence conflict");
      }
      assertSandboxCapabilityLeaseTransitionV1(current?.transition as SandboxCapabilityLeaseTransitionRecordV1["transition"] | undefined, record.transition);
      let projected: QueryResult<Record<string, unknown>>;
      const values = sandboxCapabilityLeaseProjectionValues(record);
      if (input.expectedSequence === 0) {
        projected = await executor.query(
          `INSERT INTO sandbox_capability_leases
            (lease_id, sequence, transition, run_id, session_id, tool_call_id, binding_digest,
             binding_json, usage_json, issued_at, expires_at, terminal_outcome, terminal_reason,
             cleaned_at, result_json, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::timestamptz,
                   $11::timestamptz, $12, $13, $14::timestamptz, $15::jsonb, $16::timestamptz)
           ON CONFLICT DO NOTHING`,
          values,
        );
      } else {
        projected = await executor.query(
          `UPDATE sandbox_capability_leases
              SET sequence = $2, transition = $3, usage_json = $4::jsonb,
                  issued_at = $5::timestamptz, expires_at = $6::timestamptz,
                  terminal_outcome = $7, terminal_reason = $8, cleaned_at = $9::timestamptz,
                  result_json = $10::jsonb, occurred_at = $11::timestamptz
            WHERE lease_id = $1 AND sequence = $12 AND binding_digest = $13
              AND binding_json = $14::jsonb`,
          [
            record.leaseId,
            record.sequence,
            record.transition,
            stringifySanitizedJson(record.usage),
            record.issuedAt ?? null,
            record.expiresAt,
            record.terminalOutcome ?? null,
            record.terminalReason ?? null,
            record.cleanedAt ?? null,
            stringifySanitizedJson(record.result ?? null),
            record.occurredAt,
            input.expectedSequence,
            record.bindingDigest,
            stringifySanitizedJson(record.binding),
          ],
        );
      }
      if (projected.rowCount !== 1) throw new Error("Sandbox capability lease transition sequence conflict");
      const inserted = await executor.query(
        `INSERT INTO sandbox_capability_lease_transitions
          (lease_id, sequence, transition, binding_digest, record_json, occurred_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
         ON CONFLICT DO NOTHING`,
        [record.leaseId, record.sequence, record.transition, record.bindingDigest, stringifySanitizedJson(record), record.occurredAt],
      );
      if (inserted.rowCount !== 1) throw new Error("Sandbox capability lease transition sequence conflict");
      await this.appendRunEventsBatchWithExecutor(executor, [{
        runId: record.binding.runId,
        sessionId: record.binding.sessionId,
        type: `sandbox_capability.${record.transition}` as RunEvent["type"],
        level: record.transition === "denied" || record.transition === "revoked" || record.transition === "expired" || record.transition === "cancelled" ? "WARN" : "INFO",
        timestamp: record.occurredAt,
        metadata: { record },
      }]);
      if (["denied", "revoked", "expired", "cancelled", "cleaned"].includes(record.transition)) {
        await revokePostgresChildReservations(executor, record.leaseId, record.occurredAt, `parent_${record.transition}`);
      }
      return record;
  }

  async getSandboxCapabilityLease(leaseId: string): Promise<SandboxCapabilityLeaseTransitionRecordV1 | null> {
    await this.ensureSchemaV3();
    const result = await this.db.query<{ record_json: unknown }>(
      `SELECT record_json FROM sandbox_capability_lease_transitions
        WHERE lease_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [leaseId],
    );
    return result.rows[0] === undefined ? null : parseSandboxCapabilityLeaseTransitionRecordV1(result.rows[0].record_json);
  }

  async listSandboxCapabilityLeaseTransitions(leaseId: string): Promise<SandboxCapabilityLeaseTransitionRecordV1[]> {
    await this.ensureSchemaV3();
    const result = await this.db.query<{ record_json: unknown }>(
      `SELECT record_json FROM sandbox_capability_lease_transitions
        WHERE lease_id = $1 ORDER BY sequence ASC`,
      [leaseId],
    );
    return result.rows.map((row) => parseSandboxCapabilityLeaseTransitionRecordV1(row.record_json));
  }

  async listRecoverableSandboxCapabilityLeases(input: { before: string; limit?: number | undefined }): Promise<SandboxCapabilityLeaseTransitionRecordV1[]> {
    await this.ensureSchemaV3();
    const before = normalizeTimestampString(input.before);
    const limit = input.limit ?? 100;
    if (Number.isSafeInteger(limit) === false || limit < 1 || limit > 10_000) throw new Error("Sandbox capability recovery limit is invalid");
    const result = await this.db.query<{ record_json: unknown }>(
      `SELECT transition.record_json
         FROM sandbox_capability_leases lease
         JOIN sandbox_capability_lease_transitions transition
           ON transition.lease_id = lease.lease_id AND transition.sequence = lease.sequence
        WHERE lease.cleaned_at IS NULL
          AND lease.transition NOT IN ('denied', 'cleaned')
          AND lease.occurred_at <= $1::timestamptz
        ORDER BY lease.occurred_at ASC, lease.lease_id ASC
        LIMIT $2`,
      [before, limit],
    );
    return result.rows.map((row) => parseSandboxCapabilityLeaseTransitionRecordV1(row.record_json));
  }

  async reserveSandboxCapabilityChild(input: { expectedParentSequence: number; reservation: SandboxCapabilityChildReservationV1 }): Promise<SandboxCapabilityChildReservationV1> {
    await this.ensureSchemaV3();
    return this.withTransaction((executor) =>
      this.reserveSandboxCapabilityChildWithExecutor(executor, input));
  }

  private async reserveSandboxCapabilityChildWithExecutor(
    executor: SqlExecutor,
    input: { expectedParentSequence?: number | undefined; reservation: SandboxCapabilityChildReservationV1 },
  ): Promise<SandboxCapabilityChildReservationV1> {
    const reservation = parseSandboxCapabilityChildReservationV1(input.reservation);
    if (reservation.sequence !== 1 || reservation.status !== "reserved") throw new Error("Sandbox capability child reservation must begin reserved at sequence 1");
      const parentResult = await executor.query<{ sequence: number | string; transition: string; binding_digest: string; usage_json: unknown }>(
        `SELECT sequence, transition, binding_digest, usage_json FROM sandbox_capability_leases WHERE lease_id = $1 FOR UPDATE`,
        [reservation.decision.parentLeaseId],
      );
      const parent = parentResult.rows[0];
      if (parent === undefined || (input.expectedParentSequence !== undefined && Number(parent.sequence) !== input.expectedParentSequence) || parent.binding_digest !== reservation.decision.parentBindingDigest || parent.transition !== "issued") throw new Error("Sandbox capability parent authorization is unavailable or stale");
      const usage = parseSandboxCapabilityLeaseTransitionRecordV1((await executor.query<{ record_json: unknown }>(`SELECT record_json FROM sandbox_capability_lease_transitions WHERE lease_id = $1 AND sequence = $2`, [reservation.decision.parentLeaseId, Number(parent.sequence)])).rows[0]?.record_json).usage;
      const allocated = await postgresChildCapacity(executor, reservation.decision.parentLeaseId);
      if (usage.requestsConsumed + allocated.requests + reservation.decision.requestLimit > usage.requestLimit || usage.responseBytesConsumed + allocated.bytes + reservation.decision.responseByteLimit > usage.responseByteLimit) throw new Error("Sandbox capability parent ceiling is exhausted");
      const inserted = await executor.query(
        `INSERT INTO sandbox_capability_child_reservations
          (reservation_id, parent_lease_id, sequence, status, decision_id, parent_binding_digest,
           child_run_id, child_session_id, child_tool_call_id, request_limit, response_byte_limit,
           requests_committed, response_bytes_committed, record_json, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::timestamptz)
         ON CONFLICT DO NOTHING`, childReservationValues(reservation));
      if (inserted.rowCount !== 1) throw new Error("Sandbox capability child reservation conflict");
      await executor.query(`INSERT INTO sandbox_capability_child_reservation_transitions (reservation_id, sequence, status, record_json, occurred_at) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)`, [reservation.reservationId, reservation.sequence, reservation.status, stringifySanitizedJson(reservation), reservation.occurredAt]);
      return reservation;
  }

  async settleSandboxCapabilityChild(input: { reservationId: string; expectedSequence: number; status: "committed" | "released"; requestsCommitted: number; responseBytesCommitted: number; reason?: string | undefined; occurredAt: string }): Promise<SandboxCapabilityChildReservationV1> {
    await this.ensureSchemaV3();
    return this.withTransaction(async (executor) => {
      const currentResult = await executor.query<{ sequence: number | string; status: string; record_json: unknown }>(`SELECT sequence, status, record_json FROM sandbox_capability_child_reservations WHERE reservation_id = $1 FOR UPDATE`, [input.reservationId]);
      const row = currentResult.rows[0];
      if (row === undefined || Number(row.sequence) !== input.expectedSequence || row.status !== "reserved") throw new Error("Sandbox capability child reservation sequence conflict");
      const current = parseSandboxCapabilityChildReservationV1(row.record_json);
      const next = parseSandboxCapabilityChildReservationV1({ ...current, sequence: current.sequence + 1, status: input.status, requestsCommitted: input.requestsCommitted, responseBytesCommitted: input.responseBytesCommitted, ...(input.reason === undefined ? {} : { reason: input.reason }), occurredAt: input.occurredAt });
      const updated = await executor.query(`UPDATE sandbox_capability_child_reservations SET sequence=$2,status=$3,requests_committed=$4,response_bytes_committed=$5,record_json=$6::jsonb,occurred_at=$7::timestamptz WHERE reservation_id=$1 AND sequence=$8 AND status='reserved'`, [next.reservationId, next.sequence, next.status, next.requestsCommitted, next.responseBytesCommitted, stringifySanitizedJson(next), next.occurredAt, input.expectedSequence]);
      if (updated.rowCount !== 1) throw new Error("Sandbox capability child reservation sequence conflict");
      await executor.query(`INSERT INTO sandbox_capability_child_reservation_transitions (reservation_id, sequence, status, record_json, occurred_at) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)`, [next.reservationId, next.sequence, next.status, stringifySanitizedJson(next), next.occurredAt]);
      return next;
    });
  }

  async getSandboxCapabilityChildReservation(reservationId: string): Promise<SandboxCapabilityChildReservationV1 | null> {
    await this.ensureSchemaV3();
    const result = await this.db.query<{ record_json: unknown }>(`SELECT record_json FROM sandbox_capability_child_reservations WHERE reservation_id=$1`, [reservationId]);
    return result.rows[0] === undefined ? null : parseSandboxCapabilityChildReservationV1(result.rows[0].record_json);
  }

  async listSandboxCapabilityChildReservations(parentLeaseId: string): Promise<SandboxCapabilityChildReservationV1[]> {
    await this.ensureSchemaV3();
    const result = await this.db.query<{ record_json: unknown }>(`SELECT record_json FROM sandbox_capability_child_reservations WHERE parent_lease_id=$1 ORDER BY occurred_at,reservation_id`, [parentLeaseId]);
    return result.rows.map((row) => parseSandboxCapabilityChildReservationV1(row.record_json));
  }

  async claimConversationTurnExecution(
    input: ClaimConversationTurnExecutionInput,
  ): Promise<ClaimConversationTurnExecutionResult> {
    await this.ensureSchemaV3();
    return this.withTransaction(async (executor) => {
      if (
        input.segment.turnId !== input.turnId ||
        input.segment.threadId !== input.threadId ||
        input.segment.sessionId !== input.sessionId ||
        input.segment.runId !== input.proposedRunId
      ) {
        throw createRuntimeFailure(
          "STORE_CONVERSATION_TURN_CLAIM_INVALID",
          "The conversation turn segment does not match the execution claim.",
          { turnId: input.turnId, proposedRunId: input.proposedRunId },
        );
      }

      const session = await this.getSessionLeaseStateForUpdate(input.sessionId, executor);
      if (session === null) {
        throw createRuntimeFailure(
          "STORE_SESSION_NOT_FOUND",
          `Session does not exist: ${input.sessionId}.`,
          { sessionId: input.sessionId, runId: input.proposedRunId },
        );
      }

      const threadResult = await executor.query<{
        thread_id: string;
        session_id: string;
        active_run_id: string | null;
        metadata_json: Record<string, unknown> | null;
      }>(
        `SELECT thread_id, session_id, active_run_id, metadata_json
           FROM orchestration_threads
          WHERE thread_id = $1
          FOR UPDATE`,
        [input.threadId],
      );
      const thread = threadResult.rows[0];
      if (thread === undefined || thread.session_id !== input.sessionId) {
        throw createRuntimeFailure(
          "STORE_CONVERSATION_TURN_THREAD_INVALID",
          `Thread '${input.threadId}' does not belong to session '${input.sessionId}'.`,
          { threadId: input.threadId, sessionId: input.sessionId },
        );
      }

      const turnResult = await executor.query<ConversationTurnRow>(
        `SELECT turn_id, thread_id, session_id, root_run_id, status, initial_event_type,
                active_run_id, terminal_run_id, terminal_status, metadata_json,
                started_at, updated_at, completed_at
           FROM conversation_turns
          WHERE turn_id = $1
          FOR UPDATE`,
        [input.turnId],
      );
      const existingTurn = turnResult.rows[0];
      const existingClaim = readRecord(existingTurn?.metadata_json?.executionClaim);
      const existingTurnIdentity = readNonEmptyString(existingClaim?.turnRequestIdentity);
      if (
        existingTurnIdentity !== undefined &&
        existingTurnIdentity !== input.turnRequestIdentity
      ) {
        throw createRuntimeFailure(
          "CONVERSATION_TURN_IDENTITY_CONFLICT",
          `Turn '${input.turnId}' was already claimed by a different initial request.`,
          { turnId: input.turnId },
        );
      }
      if (
        existingTurn !== undefined &&
        (existingTurn.thread_id !== input.threadId || existingTurn.session_id !== input.sessionId)
      ) {
        throw createRuntimeFailure(
          "STORE_CONVERSATION_TURN_CLAIM_INVALID",
          `Turn '${input.turnId}' belongs to a different thread or session.`,
          { turnId: input.turnId },
        );
      }

      if (existingTurn?.status === "COMPLETED" || existingTurn?.status === "FAILED") {
        const terminalEnvelope = readConversationTurnTerminalEnvelope(
          existingTurn.metadata_json?.terminalEnvelope,
        );
        if (terminalEnvelope === undefined) {
          throw createRuntimeFailure(
            "RUNTIME_TERMINAL_HANDOFF_INCOMPLETE",
            `Turn '${input.turnId}' is terminal without a replay envelope.`,
            { turnId: input.turnId },
          );
        }
        return { kind: "terminal", terminalEnvelope };
      }

      const consumedSubmission = await executor.query<{ run_id: string }>(
        `SELECT run_id
           FROM conversation_turn_segments
          WHERE turn_id = $1
            AND metadata_json->>'submissionIdentity' = $2
          LIMIT 1`,
        [input.turnId, input.submissionIdentity],
      );
      const consumedRunId = consumedSubmission.rows[0]?.run_id;
      if (consumedRunId !== undefined) {
        return { kind: "already_running", runId: consumedRunId };
      }

      let recoveredExistingWait = false;
      if (existingTurn?.status === "RUNNING" && existingTurn.active_run_id !== null) {
        const activeRun = await this.getRunLeaseStateForUpdate(existingTurn.active_run_id, executor);
        if (activeRun?.status === "RUNNING") {
          return { kind: "already_running", runId: existingTurn.active_run_id };
        }

        if (activeRun !== null) {
          let recoveredStatus = activeRun.status;
          let recoveredError: RuntimeError | null =
            activeRun.error == null ? null : asRuntimeError(activeRun.error);
          let recoveredWait: CanonicalRuntimeWaitingFor | undefined;
          if (activeRun.status === "WAITING") {
            const activeWait = readActiveWaitState(this.asRecord(session.state.agent));
            if (activeWait === undefined) {
              recoveredStatus = "FAILED";
              recoveredError = {
                code: "RECOVERED_WAIT_STATE_INVALID",
                message: "Persisted WAITING run has no canonical wait to resume.",
                details: {
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  runId: activeRun.runId,
                },
              };
            } else {
              recoveredWait = buildCanonicalWaitingFor({
                waitFor: activeWait,
                resumeStepAgent: activeWait.resumeStepAgent,
                resumeToken: activeWait.resumeToken,
                reason: activeWait.reason,
                resumeInstruction: activeWait.resumeInstruction,
                blockedAction: activeWait.blockedAction,
              });
            }
          }
          await this.projectRecoveredRunWithExecutor(executor, session, {
            runId: activeRun.runId,
            status: recoveredStatus,
            ...(recoveredError !== null ? { error: recoveredError } : {}),
            ...(recoveredWait !== undefined ? { wait: recoveredWait } : {}),
          });
          if (recoveredStatus === "WAITING") {
            recoveredExistingWait = true;
          } else {
            const recoveredTurn = await executor.query<ConversationTurnRow>(
              `SELECT turn_id, thread_id, session_id, root_run_id, status, initial_event_type,
                      active_run_id, terminal_run_id, terminal_status, metadata_json,
                      started_at, updated_at, completed_at
                 FROM conversation_turns
                WHERE turn_id = $1`,
              [input.turnId],
            );
            const terminalEnvelope = readConversationTurnTerminalEnvelope(
              recoveredTurn.rows[0]?.metadata_json?.terminalEnvelope,
            );
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
          const orphanError: RuntimeError = {
            code: "CONVERSATION_TURN_CLAIM_ORPHANED",
            message: "The conversation turn referenced a run that cannot finish the claim.",
            details: {
              turnId: input.turnId,
              runId: existingTurn.active_run_id,
            },
          };
          const terminalEnvelope: ConversationTurnTerminalEnvelopeV1 = {
            version: "v1",
            turnRequestIdentity: input.turnRequestIdentity,
            terminalSubmissionIdentity:
              readNonEmptyString(existingClaim?.submissionIdentity) ?? input.submissionIdentity,
            runId: existingTurn.active_run_id,
            status: "FAILED",
            handoff: { state: "failed", finalizationError: orphanError },
          };
          await executor.query(
            `UPDATE conversation_turns
                SET status = 'FAILED',
                    active_run_id = NULL,
                    terminal_run_id = $2,
                    terminal_status = 'FAILED',
                    metadata_json = COALESCE(metadata_json, '{}'::jsonb)
                      || jsonb_build_object('terminalEnvelope', $3::jsonb),
                    updated_at = NOW(),
                    completed_at = NOW()
              WHERE turn_id = $1`,
            [input.turnId, existingTurn.active_run_id, stringifySanitizedJson(terminalEnvelope)],
          );
          await executor.query(
            `UPDATE orchestration_threads
                SET status = 'FAILED',
                    active_run_id = NULL,
                    current_request_id = NULL,
                    last_run_status = 'FAILED',
                    wait_for_json = NULL,
                    metadata_json = COALESCE(metadata_json, '{}'::jsonb)
                      || jsonb_build_object('terminalEnvelope', $3::jsonb),
                    updated_at = NOW()
              WHERE thread_id = $1
                AND active_run_id = $2`,
            [input.threadId, existingTurn.active_run_id, stringifySanitizedJson(terminalEnvelope)],
          );
          await this.releaseActiveRunLeaseWithExecutor(
            executor,
            input.sessionId,
            existingTurn.active_run_id,
          );
          return { kind: "terminal", terminalEnvelope };
        }
      }

      if (recoveredExistingWait === false) {
        await this.reconcileTerminalActiveRunWithExecutor(executor, session);
      }
      await this.acquireRunLeaseWithExecutor(executor, input.proposedRunId, input.sessionId);
      await executor.query(
        `INSERT INTO runs (run_id, session_id, event_type, status, started_at, tenant_id, tenant_ownership_state)
         VALUES ($1, $2, $3, 'RUNNING', $4::timestamptz, $5, $6)`,
        [input.proposedRunId, input.sessionId, input.eventType, normalizeTimestampString(input.startedAt), this.tenantId ?? null, this.tenantId === undefined ? "explicit_unbound" : "tenant_bound"],
      );

      const claimMetadata = {
        turnRequestIdentity: input.turnRequestIdentity,
        submissionIdentity: input.submissionIdentity,
        submissionKind: input.submissionKind,
        activeRunId: input.proposedRunId,
      };
      await executor.query(
        `INSERT INTO conversation_turns
           (turn_id, thread_id, session_id, root_run_id, status, initial_event_type,
            active_run_id, terminal_run_id, terminal_status, metadata_json, started_at, updated_at, completed_at)
         VALUES ($1, $2, $3, $4, 'RUNNING', $5, $4, NULL, NULL,
                 COALESCE($8::jsonb, '{}'::jsonb)
                   || jsonb_build_object('executionClaim', $6::jsonb),
                 $7::timestamptz, $7::timestamptz, NULL)
         ON CONFLICT (turn_id) DO UPDATE
            SET status = 'RUNNING',
                active_run_id = EXCLUDED.active_run_id,
                terminal_run_id = NULL,
                terminal_status = NULL,
                metadata_json = (
                  COALESCE(conversation_turns.metadata_json, '{}'::jsonb)
                    || COALESCE($8::jsonb, '{}'::jsonb)
                    || jsonb_build_object('executionClaim', $6::jsonb)
                ) - 'suspensionEnvelope' - 'terminalEnvelope',
                updated_at = EXCLUDED.updated_at,
                completed_at = NULL`,
        [
          input.turnId,
          input.threadId,
          input.sessionId,
          input.proposedRunId,
          input.eventType,
          stringifySanitizedJson(claimMetadata),
          normalizeTimestampString(input.startedAt),
          stringifySanitizedJson(input.segment.metadata ?? null),
        ],
      );
      await executor.query(
        `INSERT INTO conversation_turn_segments
           (segment_id, turn_id, thread_id, session_id, run_id, kind, event_type,
            request_id, grant_id, message_hash, metadata_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 COALESCE($11::jsonb, '{}'::jsonb)
                   || jsonb_build_object('submissionIdentity', $12::text),
                 $13::timestamptz)
         ON CONFLICT (segment_id) DO NOTHING`,
        [
          input.segment.segmentId,
          input.segment.turnId,
          input.segment.threadId,
          input.segment.sessionId,
          input.segment.runId,
          input.segment.kind,
          input.segment.eventType,
          input.segment.requestId ?? null,
          input.segment.grantId ?? null,
          input.segment.messageHash,
          stringifySanitizedJson(input.segment.metadata ?? null),
          input.submissionIdentity,
          normalizeTimestampString(input.segment.createdAt),
        ],
      );
      await executor.query(
        `UPDATE orchestration_threads
            SET status = 'RUNNING',
                active_run_id = $2,
                current_request_id = NULL,
                last_run_status = 'RUNNING',
                wait_for_json = NULL,
                metadata_json = (
                  COALESCE(metadata_json, '{}'::jsonb)
                    || COALESCE($5::jsonb, '{}'::jsonb)
                    || jsonb_build_object(
                         'activeTurnId', $3::text,
                         'executionClaim', $4::jsonb
                       )
                ) - 'suspensionEnvelope' - 'terminalEnvelope',
                updated_at = NOW()
          WHERE thread_id = $1`,
        [
          input.threadId,
          input.proposedRunId,
          input.turnId,
          stringifySanitizedJson(claimMetadata),
          stringifySanitizedJson(input.segment.metadata ?? null),
        ],
      );
      return { kind: "claimed", runId: input.proposedRunId };
    });
  }

  async updateConversationTurnTerminalEnvelope(
    input: UpdateConversationTurnTerminalEnvelopeInput,
  ): Promise<boolean> {
    await this.ensureSchemaV3();
    if (
      input.envelope.runId !== input.runId ||
      input.envelope.terminalSubmissionIdentity !== input.terminalSubmissionIdentity
    ) {
      throw createRuntimeFailure(
        "STORE_CONVERSATION_TURN_HANDOFF_INVALID",
        "The terminal handoff envelope does not match its claimed run and submission.",
        { turnId: input.turnId, runId: input.runId },
      );
    }
    return this.withTransaction(async (executor) => {
      const updatedTurn = await executor.query<{ thread_id: string }>(
        `UPDATE conversation_turns
            SET metadata_json = COALESCE(metadata_json, '{}'::jsonb)
                  || jsonb_build_object('terminalEnvelope', $4::jsonb),
                updated_at = NOW()
          WHERE turn_id = $1
            AND terminal_run_id = $2
            AND metadata_json->'executionClaim'->>'submissionIdentity' = $3
            AND metadata_json->'terminalEnvelope'->>'runId' = $2
            AND metadata_json->'terminalEnvelope'->'handoff'->>'state' = 'pending'
          RETURNING thread_id`,
        [
          input.turnId,
          input.runId,
          input.terminalSubmissionIdentity,
          stringifySanitizedJson(input.envelope),
        ],
      );
      const threadId = updatedTurn.rows[0]?.thread_id;
      if (threadId === undefined) {
        return false;
      }
      await executor.query(
        `UPDATE orchestration_threads
            SET metadata_json = COALESCE(metadata_json, '{}'::jsonb)
                  || jsonb_build_object('terminalEnvelope', $4::jsonb),
                updated_at = NOW()
          WHERE thread_id = $1
            AND metadata_json->>'activeTurnId' = $2
            AND metadata_json->'terminalEnvelope'->>'runId' = $3`,
        [
          threadId,
          input.turnId,
          input.runId,
          stringifySanitizedJson(input.envelope),
        ],
      );
      return true;
    });
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
    completedAfter?: { completedAt: string; turnId: string } | undefined;
    terminalMessagesOnly?: boolean | undefined;
    terminalOutcomesOnly?: boolean | undefined;
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
    if (input.completedAfter !== undefined) {
      values.push(input.completedAfter.completedAt, input.completedAfter.turnId);
      clauses.push(`(completed_at, turn_id) > ($${values.length - 1}, $${values.length})`);
    }
    if (input.terminalMessagesOnly === true) {
      clauses.push(`status = 'COMPLETED'`);
      clauses.push(`completed_at IS NOT NULL`);
      clauses.push(`metadata_json->'terminalEnvelope'->'handoff'->>'state' = 'delivered'`);
      clauses.push(`jsonb_typeof(metadata_json->'terminalEnvelope'->'handoff'->'assistantText') = 'string'`);
      clauses.push(`btrim(metadata_json->'terminalEnvelope'->'handoff'->>'assistantText') <> ''`);
    }
    if (input.terminalOutcomesOnly === true) {
      clauses.push(`status IN ('COMPLETED', 'FAILED')`);
      clauses.push(`completed_at IS NOT NULL`);
      clauses.push(`metadata_json->'terminalEnvelope'->'handoff'->>'state' IN ('delivered', 'failed')`);
    }
    const limit = Math.max(1, Math.min(501, Math.trunc(input.limit ?? 100)));
    values.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query<ConversationTurnRow>(
      `SELECT turn_id, thread_id, session_id, root_run_id, status, initial_event_type,
              active_run_id, terminal_run_id, terminal_status, metadata_json,
              started_at, updated_at, completed_at
         FROM conversation_turns
         ${whereClause}
        ORDER BY ${input.completedAfter !== undefined
          ? "completed_at ASC, turn_id ASC"
          : input.terminalMessagesOnly === true || input.terminalOutcomesOnly === true
            ? "completed_at DESC NULLS LAST, turn_id DESC"
            : "updated_at DESC, turn_id ASC"}
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
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::jsonb, 'PENDING', (SELECT tenant_id FROM runs WHERE run_id = $${offset + 1}), (SELECT tenant_ownership_state FROM runs WHERE run_id = $${offset + 1}))`,
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
         (run_id, session_id, step_index, effect_type, idempotency_key, failure_policy, payload_json, status, tenant_id, tenant_ownership_state)
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
    eventTypes?: RunEvent["type"][] | undefined;
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

    if (input.eventTypes !== undefined) {
      values.push(input.eventTypes);
      clauses.push(`event_type = ANY($${values.length}::text[])`);
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

    let limitClause = "";
    if (input.limit !== undefined) {
      values.push(input.limit);
      limitClause = `LIMIT $${values.length}`;
    }

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
        ${limitClause}`,
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

  async updateThreadAfterRun(
    input: Parameters<PostgresOrchestrationStore["updateThreadAfterRun"]>[0],
  ): Promise<boolean> {
    await this.ensureSchemaV3();
    return this.orchestrationStore.updateThreadAfterRun(input);
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

  async getContextPolicyDefinition(contextPolicyId: string) {
    await this.ensureSchemaV3();
    return this.orchestrationStore.getContextPolicyDefinition(contextPolicyId);
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
    settlement?: RunLifecycleSettlement,
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
      if (sessionId === undefined) {
        throw createRuntimeFailure(
          "STORE_RUN_NOT_FOUND",
          `Run does not exist: ${runId}.`,
          { runId, status },
        );
      }

      const turnResult = await executor.query<ConversationTurnRow>(
        `SELECT turn_id, thread_id, session_id, root_run_id, status, initial_event_type,
                active_run_id, terminal_run_id, terminal_status, metadata_json,
                started_at, updated_at, completed_at
           FROM conversation_turns
          WHERE active_run_id = $1
          FOR UPDATE`,
        [runId],
      );
      const turn = turnResult.rows[0];
      if (turn !== undefined) {
        const claim = readRecord(turn.metadata_json?.executionClaim);
        const turnRequestIdentity = readNonEmptyString(claim?.turnRequestIdentity);
        const submissionIdentity = readNonEmptyString(claim?.submissionIdentity);
        if (turnRequestIdentity === undefined || submissionIdentity === undefined) {
          throw createRuntimeFailure(
            "STORE_CONVERSATION_TURN_CLAIM_INVALID",
            `Run '${runId}' has no valid active conversation turn claim.`,
            { runId, turnId: turn.turn_id },
          );
        }

        if (status === "WAITING") {
          if (settlement?.wait === undefined) {
            throw createRuntimeFailure(
              "STORE_WAIT_SETTLEMENT_REQUIRED",
              `Run '${runId}' cannot enter WAITING without a canonical wait settlement.`,
              { runId, turnId: turn.turn_id },
            );
          }
          const suspensionEnvelope: ConversationTurnSuspensionEnvelopeV1 = {
            version: "v1",
            turnRequestIdentity,
            submissionIdentity,
            runId,
            wait: settlement.wait,
          };
          await executor.query(
            `UPDATE conversation_turns
                SET status = 'WAITING',
                    metadata_json = COALESCE(metadata_json, '{}'::jsonb)
                      || jsonb_build_object('suspensionEnvelope', $2::jsonb),
                    updated_at = NOW()
              WHERE turn_id = $1
                AND active_run_id = $3`,
            [turn.turn_id, stringifySanitizedJson(suspensionEnvelope), runId],
          );
          const threadUpdate = await executor.query(
            `UPDATE orchestration_threads
                SET status = 'WAITING',
                    active_run_id = $2,
                    current_request_id = NULL,
                    last_run_status = 'WAITING',
                    wait_for_json = $3::jsonb,
                    metadata_json = COALESCE(metadata_json, '{}'::jsonb)
                      || jsonb_build_object('suspensionEnvelope', $4::jsonb),
                    updated_at = NOW()
              WHERE thread_id = $1
                AND active_run_id = $2
                AND metadata_json->>'activeTurnId' = $5
                AND metadata_json->'executionClaim'->>'turnRequestIdentity' = $6
                AND metadata_json->'executionClaim'->>'submissionIdentity' = $7`,
            [
              turn.thread_id,
              runId,
              stringifySanitizedJson(settlement.wait),
              stringifySanitizedJson(suspensionEnvelope),
              turn.turn_id,
              turnRequestIdentity,
              submissionIdentity,
            ],
          );
          if (threadUpdate.rowCount !== 1) {
            throw createRuntimeFailure(
              "STORE_THREAD_SETTLEMENT_CONFLICT",
              `Run '${runId}' no longer owns thread '${turn.thread_id}'.`,
              { runId, turnId: turn.turn_id, threadId: turn.thread_id },
            );
          }
        } else if (status === "COMPLETED" || status === "FAILED") {
          const terminalEnvelope: ConversationTurnTerminalEnvelopeV1 = {
            version: "v1",
            turnRequestIdentity,
            terminalSubmissionIdentity: submissionIdentity,
            runId,
            status,
            handoff: { state: "pending" },
          };
          await executor.query(
            `UPDATE conversation_turns
                SET status = $2,
                    active_run_id = NULL,
                    terminal_run_id = $3,
                    terminal_status = $2,
                    metadata_json = COALESCE(metadata_json, '{}'::jsonb)
                      || jsonb_build_object('terminalEnvelope', $4::jsonb),
                    updated_at = NOW(),
                    completed_at = NOW()
              WHERE turn_id = $1
                AND active_run_id = $3`,
            [turn.turn_id, status, runId, stringifySanitizedJson(terminalEnvelope)],
          );
          const threadUpdate = await executor.query(
            `UPDATE orchestration_threads
                SET status = $2,
                    active_run_id = NULL,
                    current_request_id = NULL,
                    last_run_status = $2,
                    wait_for_json = NULL,
                    metadata_json = COALESCE(metadata_json, '{}'::jsonb)
                      || jsonb_build_object('terminalEnvelope', $4::jsonb),
                    updated_at = NOW()
              WHERE thread_id = $1
                AND active_run_id = $3
                AND metadata_json->>'activeTurnId' = $5
                AND metadata_json->'executionClaim'->>'turnRequestIdentity' = $6
                AND metadata_json->'executionClaim'->>'submissionIdentity' = $7`,
            [
              turn.thread_id,
              status,
              runId,
              stringifySanitizedJson(terminalEnvelope),
              turn.turn_id,
              turnRequestIdentity,
              submissionIdentity,
            ],
          );
          if (threadUpdate.rowCount !== 1) {
            throw createRuntimeFailure(
              "STORE_THREAD_SETTLEMENT_CONFLICT",
              `Run '${runId}' no longer owns thread '${turn.thread_id}'.`,
              { runId, turnId: turn.turn_id, threadId: turn.thread_id },
            );
          }
        }
      }
      await executor.query(
        "DELETE FROM provider_reasoning_state WHERE run_id = $1 AND record_kind = 'continuation'",
        [runId],
      );
      await executor.query(
        `UPDATE sessions
            SET active_run_id = NULL,
                active_run_started_at = NULL,
                updated_at = NOW()
          WHERE session_id = $1
            AND active_run_id = $2`,
        [sessionId, runId],
      );
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
      const orphanError: RuntimeError = {
        code: "CONVERSATION_TURN_CLAIM_ORPHANED",
        message: "The active conversation turn references a run that no longer exists.",
        details: {
          sessionId: session.sessionId,
          runId: session.activeRunId,
        },
      };
      await this.projectRecoveredRunWithExecutor(executor, session, {
        runId: session.activeRunId,
        status: "FAILED",
        error: orphanError,
      });
      return;
    }

    const terminalStatus = this.readSessionTerminalStatus(session.state);
    if (terminalStatus === undefined) {
      return;
    }

    let recoveredStatus = terminalStatus;
    let recoveredError = this.buildRecoveredRunError(terminalStatus, session.state);
    let recoveredWait: CanonicalRuntimeWaitingFor | undefined;
    if (terminalStatus === "WAITING") {
      const activeWait = readActiveWaitState(this.asRecord(session.state.agent));
      if (activeWait === undefined) {
        recoveredStatus = "FAILED";
        recoveredError = {
          code: "RECOVERED_WAIT_STATE_INVALID",
          message: "Persisted WAITING session state has no canonical wait to resume.",
          details: {
            sessionId: session.sessionId,
            runId: activeRun.runId,
          },
        };
      } else {
        recoveredWait = buildCanonicalWaitingFor({
          waitFor: activeWait,
          resumeStepAgent: activeWait.resumeStepAgent,
          resumeToken: activeWait.resumeToken,
          reason: activeWait.reason,
          resumeInstruction: activeWait.resumeInstruction,
          blockedAction: activeWait.blockedAction,
        });
      }
    }

    await this.projectRecoveredRunWithExecutor(executor, session, {
      runId: activeRun.runId,
      status: recoveredStatus,
      ...(recoveredError !== null ? { error: recoveredError } : {}),
      ...(recoveredWait !== undefined ? { wait: recoveredWait } : {}),
    });
  }

  private async projectRecoveredRunWithExecutor(
    executor: SqlExecutor,
    session: LockedSessionLeaseState,
    input: {
      runId: string;
      status: Exclude<TransitionStatus, "RUNNING">;
      error?: RuntimeError | undefined;
      wait?: CanonicalRuntimeWaitingFor | undefined;
    },
  ): Promise<void> {
    const turnResult = await executor.query<ConversationTurnRow>(
      `SELECT turn_id, thread_id, session_id, root_run_id, status, initial_event_type,
              active_run_id, terminal_run_id, terminal_status, metadata_json,
              started_at, updated_at, completed_at
         FROM conversation_turns
        WHERE active_run_id = $1
        FOR UPDATE`,
      [input.runId],
    );
    const turn = turnResult.rows[0];
    const claim = readRecord(turn?.metadata_json?.executionClaim);
    const turnRequestIdentity =
      readNonEmptyString(claim?.turnRequestIdentity) ??
      (turn === undefined ? `recovered:${input.runId}` : `recovered:${turn.turn_id}`);
    const submissionIdentity =
      readNonEmptyString(claim?.submissionIdentity) ?? `recovered:${input.runId}`;

    await executor.query(
      `UPDATE runs
          SET status = $2,
              completed_at = COALESCE(completed_at, NOW()),
              error_json = CASE
                WHEN error_json IS NULL THEN $3::jsonb
                ELSE error_json
              END
        WHERE run_id = $1`,
      [input.runId, input.status, stringifySanitizedJson(input.error ?? null)],
    );

    if (turn !== undefined && input.status === "WAITING") {
      if (input.wait === undefined) {
        throw createRuntimeFailure(
          "STORE_WAIT_SETTLEMENT_REQUIRED",
          `Recovered run '${input.runId}' cannot enter WAITING without a canonical wait.`,
          { runId: input.runId, turnId: turn.turn_id },
        );
      }
      const suspensionEnvelope: ConversationTurnSuspensionEnvelopeV1 = {
        version: "v1",
        turnRequestIdentity,
        submissionIdentity,
        runId: input.runId,
        wait: input.wait,
      };
      const turnUpdate = await executor.query(
        `UPDATE conversation_turns
            SET status = 'WAITING',
                metadata_json = COALESCE(metadata_json, '{}'::jsonb)
                  || jsonb_build_object('suspensionEnvelope', $3::jsonb),
                updated_at = NOW()
          WHERE turn_id = $1
            AND active_run_id = $2`,
        [turn.turn_id, input.runId, stringifySanitizedJson(suspensionEnvelope)],
      );
      if (turnUpdate.rowCount !== 1) {
        throw createRuntimeFailure(
          "STORE_CONVERSATION_TURN_SETTLEMENT_CONFLICT",
          `Recovered run '${input.runId}' no longer owns turn '${turn.turn_id}'.`,
          { runId: input.runId, turnId: turn.turn_id },
        );
      }
      const threadUpdate = await executor.query(
        `UPDATE orchestration_threads
            SET status = 'WAITING',
                active_run_id = $2,
                current_request_id = NULL,
                last_run_status = 'WAITING',
                wait_for_json = $3::jsonb,
                metadata_json = COALESCE(metadata_json, '{}'::jsonb)
                  || jsonb_build_object('suspensionEnvelope', $4::jsonb),
                updated_at = NOW()
          WHERE thread_id = $1
            AND active_run_id = $2
            AND metadata_json->>'activeTurnId' = $5`,
        [
          turn.thread_id,
          input.runId,
          stringifySanitizedJson(input.wait),
          stringifySanitizedJson(suspensionEnvelope),
          turn.turn_id,
        ],
      );
      await this.assertRecoveredThreadProjectionWithExecutor(executor, {
        threadId: turn.thread_id,
        turnId: turn.turn_id,
        runId: input.runId,
        rowCount: threadUpdate.rowCount,
      });
    } else if (turn !== undefined && input.status !== "WAITING") {
      const terminalEnvelope: ConversationTurnTerminalEnvelopeV1 = {
        version: "v1",
        turnRequestIdentity,
        terminalSubmissionIdentity: submissionIdentity,
        runId: input.runId,
        status: input.status,
        handoff: input.status === "COMPLETED"
          ? { state: "pending" }
          : {
              state: "failed",
              finalizationError: input.error ?? {
                code: "RECOVERED_STALE_FAILED_RUN",
                message: "Recovered a failed run without a persisted runtime error.",
                details: { sessionId: session.sessionId, runId: input.runId },
              },
            },
      };
      const turnUpdate = await executor.query(
        `UPDATE conversation_turns
            SET status = $2,
                active_run_id = NULL,
                terminal_run_id = $3,
                terminal_status = $2,
                metadata_json = COALESCE(metadata_json, '{}'::jsonb)
                  || jsonb_build_object('terminalEnvelope', $4::jsonb),
                updated_at = NOW(),
                completed_at = NOW()
          WHERE turn_id = $1
            AND active_run_id = $3`,
        [
          turn.turn_id,
          input.status,
          input.runId,
          stringifySanitizedJson(terminalEnvelope),
        ],
      );
      if (turnUpdate.rowCount !== 1) {
        throw createRuntimeFailure(
          "STORE_CONVERSATION_TURN_SETTLEMENT_CONFLICT",
          `Recovered run '${input.runId}' no longer owns turn '${turn.turn_id}'.`,
          { runId: input.runId, turnId: turn.turn_id },
        );
      }
      const threadUpdate = await executor.query(
        `UPDATE orchestration_threads
            SET status = $2,
                active_run_id = NULL,
                current_request_id = NULL,
                last_run_status = $2,
                wait_for_json = NULL,
                metadata_json = COALESCE(metadata_json, '{}'::jsonb)
                  || jsonb_build_object('terminalEnvelope', $4::jsonb),
                updated_at = NOW()
          WHERE thread_id = $1
            AND active_run_id = $3
            AND metadata_json->>'activeTurnId' = $5`,
        [
          turn.thread_id,
          input.status,
          input.runId,
          stringifySanitizedJson(terminalEnvelope),
          turn.turn_id,
        ],
      );
      await this.assertRecoveredThreadProjectionWithExecutor(executor, {
        threadId: turn.thread_id,
        turnId: turn.turn_id,
        runId: input.runId,
        rowCount: threadUpdate.rowCount,
      });
    }

    await this.releaseActiveRunLeaseWithExecutor(
      executor,
      session.sessionId,
      input.runId,
    );
  }

  private async assertRecoveredThreadProjectionWithExecutor(
    executor: SqlExecutor,
    input: {
      threadId: string;
      turnId: string;
      runId: string;
      rowCount: number;
    },
  ): Promise<void> {
    if (input.rowCount === 1) {
      return;
    }
    const current = await executor.query<{ active_run_id: string | null }>(
      `SELECT active_run_id
         FROM orchestration_threads
        WHERE thread_id = $1
        FOR UPDATE`,
      [input.threadId],
    );
    if (current.rows[0]?.active_run_id !== input.runId) {
      return;
    }
    throw createRuntimeFailure(
      "STORE_THREAD_SETTLEMENT_CONFLICT",
      `Recovered run '${input.runId}' still owns thread '${input.threadId}' but its projection could not be settled.`,
      {
        runId: input.runId,
        turnId: input.turnId,
        threadId: input.threadId,
      },
    );
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

  private readSessionTerminalStatus(
    state: Record<string, unknown>,
  ): Exclude<TransitionStatus, "RUNNING"> | undefined {
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

  private mapMissionControlProjectRow(
    row: MissionControlProjectRow,
  ): MissionControlProjectStateRecord {
    return parseMissionControlProjectStateRecord({
      projectId: row.project_id,
      schemaVersion: row.schema_version,
      revision: this.normalizeSafeInteger(row.revision, "revision"),
      authorityEpoch: this.normalizeSafeInteger(
        row.authority_epoch,
        "authority_epoch",
      ),
      document: row.document_json,
      createdAt: normalizeTimestampString(row.created_at),
      updatedAt: normalizeTimestampString(row.updated_at),
    });
  }

  private mapMissionControlOutboxRow(
    row: MissionControlOutboxRow,
  ): MissionControlOutboxRecord {
    return {
      id: this.normalizeSafeInteger(row.id, "mission_control_outbox.id"),
      projectId: requireMissionControlProjectId(row.project_id),
      actionId: row.action_id,
      effectId: row.effect_id,
      effectType: row.effect_type,
      payload: this.asRecord(row.payload_json) ?? {},
      status: this.normalizeMissionControlOutboxStatus(row.status),
      attemptCount: this.normalizeSafeInteger(
        row.attempt_count,
        "mission_control_outbox.attempt_count",
      ),
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
      createdAt: normalizeTimestampString(row.created_at),
    };
  }

  private normalizeMissionControlOutboxStatus(
    value: string,
  ): MissionControlOutboxRecord["status"] {
    if (value !== "PENDING" && value !== "DELIVERED" && value !== "FAILED") {
      throw new Error(`Invalid Mission Control outbox status: ${value}.`);
    }
    return value;
  }

  private normalizeSafeInteger(
    value: number | string,
    field: string,
  ): number {
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isSafeInteger(numeric) === false || numeric < 0) {
      throw new Error(`${field} must be a non-negative safe integer.`);
    }
    return numeric;
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
    started_at: string | Date;
    completed_at: string | Date | null;
    error_json: Record<string, unknown> | null;
  }): PersistedRunRecord {
    return {
      runId: row.run_id,
      sessionId: row.session_id,
      eventType: row.event_type,
      status: row.status,
      startedAt: normalizeTimestampString(row.started_at),
      completedAt: row.completed_at === null
        ? undefined
        : normalizeTimestampString(row.completed_at),
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

  private withMissionControlTransaction<T>(
    operation: (executor: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    return this.withTransaction(operation);
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
      has_context_policy_economics: boolean;
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
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'orchestration_context_policy_definitions'
             AND column_name = 'economics_policy_json'
         ) AS has_context_policy_economics,
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
      row.has_context_policy_economics !== true ||
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
  started_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
}

function sandboxCapabilityLeaseProjectionValues(record: SandboxCapabilityLeaseTransitionRecordV1): unknown[] {
  return [
    record.leaseId,
    record.sequence,
    record.transition,
    record.binding.runId,
    record.binding.sessionId,
    record.binding.toolCallId,
    record.bindingDigest,
    stringifySanitizedJson(record.binding),
    stringifySanitizedJson(record.usage),
    record.issuedAt ?? null,
    record.expiresAt,
    record.terminalOutcome ?? null,
    record.terminalReason ?? null,
    record.cleanedAt ?? null,
    stringifySanitizedJson(record.result ?? null),
    record.occurredAt,
  ];
}

function childReservationValues(record: SandboxCapabilityChildReservationV1): unknown[] {
  return [record.reservationId, record.decision.parentLeaseId, record.sequence, record.status, record.decision.decisionId, record.decision.parentBindingDigest, record.decision.childRunId, record.decision.childSessionId, record.decision.childToolCallId, record.decision.requestLimit, record.decision.responseByteLimit, record.requestsCommitted, record.responseBytesCommitted, stringifySanitizedJson(record), record.occurredAt];
}

async function postgresChildCapacity(
  executor: SqlExecutor,
  parentLeaseId: string,
): Promise<{ requests: number; bytes: number }> {
  const allocated = await executor.query<{ requests_allocated: string; bytes_allocated: string }>(
    `SELECT COALESCE(SUM(CASE WHEN status = 'reserved' THEN request_limit WHEN status = 'committed' THEN requests_committed ELSE 0 END), 0)::text AS requests_allocated,
            COALESCE(SUM(CASE WHEN status = 'reserved' THEN response_byte_limit WHEN status = 'committed' THEN response_bytes_committed ELSE 0 END), 0)::text AS bytes_allocated
       FROM sandbox_capability_child_reservations WHERE parent_lease_id = $1`,
    [parentLeaseId],
  );
  return {
    requests: Number(allocated.rows[0]?.requests_allocated ?? 0),
    bytes: Number(allocated.rows[0]?.bytes_allocated ?? 0),
  };
}

async function revokePostgresChildReservations(executor: SqlExecutor, parentLeaseId: string, occurredAt: string, reason: string): Promise<void> {
  const active = await executor.query<{ record_json: unknown }>(`SELECT record_json FROM sandbox_capability_child_reservations WHERE parent_lease_id=$1 AND status='reserved' FOR UPDATE`, [parentLeaseId]);
  for (const row of active.rows) {
    const current = parseSandboxCapabilityChildReservationV1(row.record_json);
    const next = parseSandboxCapabilityChildReservationV1({ ...current, sequence: current.sequence + 1, status: "revoked", reason, occurredAt });
    await executor.query(`UPDATE sandbox_capability_child_reservations SET sequence=$2,status='revoked',record_json=$3::jsonb,occurred_at=$4::timestamptz WHERE reservation_id=$1 AND sequence=$5 AND status='reserved'`, [next.reservationId, next.sequence, stringifySanitizedJson(next), next.occurredAt, current.sequence]);
    await executor.query(`INSERT INTO sandbox_capability_child_reservation_transitions (reservation_id, sequence, status, record_json, occurred_at) VALUES ($1,$2,'revoked',$3::jsonb,$4::timestamptz)`, [next.reservationId, next.sequence, stringifySanitizedJson(next), next.occurredAt]);
  }
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
    startedAt: normalizeTimestampString(row.started_at),
    updatedAt: normalizeTimestampString(row.updated_at),
    ...(row.completed_at !== null
      ? { completedAt: normalizeTimestampString(row.completed_at) }
      : {}),
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

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
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

function canonicalStoreJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStoreJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalStoreJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function throwIfSandboxCapabilityResultPersistenceCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new SandboxCapabilityExactResultCancelledError("Sandbox capability exact-result persistence was cancelled");
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readConversationTurnTerminalEnvelope(
  value: unknown,
): ConversationTurnTerminalEnvelopeV1 | undefined {
  const envelope = readRecord(value);
  const handoff = readRecord(envelope?.handoff);
  if (handoff === undefined) {
    return undefined;
  }
  const status = envelope?.status;
  const handoffState = handoff?.state;
  if (
    envelope?.version !== "v1" ||
    (status !== "COMPLETED" && status !== "FAILED") ||
    readNonEmptyString(envelope.turnRequestIdentity) === undefined ||
    readNonEmptyString(envelope.terminalSubmissionIdentity) === undefined ||
    readNonEmptyString(envelope.runId) === undefined ||
    (handoffState !== "pending" && handoffState !== "delivered" && handoffState !== "failed")
  ) {
    return undefined;
  }
  if (
    handoffState === "delivered" &&
    status === "COMPLETED" &&
    readNonEmptyString(handoff.assistantText) === undefined
  ) {
    return undefined;
  }
  if (handoffState === "delivered" && status === "FAILED" && handoff.assistantText !== null) {
    return undefined;
  }
  const finalizationError = readRecord(handoff.finalizationError);
  if (
    handoffState === "failed" &&
    (
      readNonEmptyString(finalizationError?.code) === undefined ||
      readNonEmptyString(finalizationError?.message) === undefined
    )
  ) {
    return undefined;
  }
  return value as ConversationTurnTerminalEnvelopeV1;
}
