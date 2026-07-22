import type { SqlExecutor } from "../store/PostgresSessionStore.js";
import { stringifySanitizedJson } from "../runtime/jsonSanitizer.js";
import { normalizeOptionalTimestampString, normalizeTimestampString } from "../runtime/timestamps.js";
import type { ApprovalGrantRecord, AssemblyBundleRecord, AssemblyChangeDecisionRecord, AssemblyChangeProposalRecord, ContextCheckpointRecord, ContextPolicyDefinitionRecord, ContextSummaryArtifactRecord, DelegationRecord, InteractionRequestRecord, OperatorAttentionRecord, OperatorFocusRecord, SpecialistDefinitionRecord, ThreadAssemblyRecord, ThreadCompactionEventRecord, ThreadRecord } from "../kestrel/contracts/orchestration.js";

import type { OrchestrationStore } from "./contracts.js";
import { readSubAgentResultEnvelope } from "./subAgentResult.js";

export class PostgresOrchestrationStore implements OrchestrationStore {
  private readonly db: SqlExecutor;
  private schemaReady = true;

  constructor(db: SqlExecutor) {
    this.db = db;
  }

  async upsertThread(thread: ThreadRecord): Promise<void> {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO orchestration_threads
        (thread_id, session_id, title, status, parent_thread_id, active_run_id, current_request_id, last_run_status, wait_for_json, metadata_json, created_at, updated_at)
       VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         CASE
           WHEN $6::text IS NULL THEN NULL
           WHEN EXISTS (
             SELECT 1
               FROM runs
              WHERE run_id = $6::text
                AND session_id = $2
           ) THEN $6::text
           ELSE NULL
         END,
         $7,
         $8,
         $9::jsonb,
         $10::jsonb,
         $11::timestamptz,
         $12::timestamptz
       )
       ON CONFLICT (thread_id) DO UPDATE
         SET session_id = EXCLUDED.session_id,
             title = EXCLUDED.title,
             status = EXCLUDED.status,
             parent_thread_id = EXCLUDED.parent_thread_id,
             active_run_id = CASE
               WHEN EXCLUDED.active_run_id IS NULL THEN NULL
               WHEN EXISTS (
                 SELECT 1
                   FROM runs
                  WHERE run_id = EXCLUDED.active_run_id
                    AND session_id = EXCLUDED.session_id
               ) THEN EXCLUDED.active_run_id
               ELSE NULL
             END,
             current_request_id = EXCLUDED.current_request_id,
             last_run_status = EXCLUDED.last_run_status,
             wait_for_json = EXCLUDED.wait_for_json,
             metadata_json = EXCLUDED.metadata_json,
             updated_at = EXCLUDED.updated_at`,
      [
        thread.threadId,
        thread.sessionId,
        thread.title,
        thread.status,
        thread.parentThreadId ?? null,
        thread.activeRunId ?? null,
        thread.currentRequestId ?? null,
        thread.lastRunStatus ?? null,
        stringifySanitizedJson(thread.waitFor ?? null),
        stringifySanitizedJson(thread.metadata ?? null),
        normalizeTimestampString(thread.createdAt),
        normalizeTimestampString(thread.updatedAt),
      ],
    );
  }

  async getThread(threadId: string): Promise<ThreadRecord | null> {
    await this.ensureSchema();
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT thread_id, session_id, title, status, parent_thread_id, active_run_id, current_request_id, last_run_status, wait_for_json, metadata_json, created_at, updated_at
         FROM orchestration_threads
        WHERE thread_id = $1`,
      [threadId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapThreadRow(row);
  }

  async listThreads(input: {
    parentThreadId?: string | undefined;
    sessionId?: string | undefined;
    status?: ThreadRecord["status"] | undefined;
  } = {}): Promise<ThreadRecord[]> {
    await this.ensureSchema();
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.parentThreadId !== undefined) {
      values.push(input.parentThreadId);
      clauses.push(`parent_thread_id = $${values.length}`);
    }
    if (input.sessionId !== undefined) {
      values.push(input.sessionId);
      clauses.push(`session_id = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      clauses.push(`status = $${values.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT thread_id, session_id, title, status, parent_thread_id, active_run_id, current_request_id, last_run_status, wait_for_json, metadata_json, created_at, updated_at
         FROM orchestration_threads
         ${where}
        ORDER BY updated_at DESC`,
      values,
    );
    return result.rows.map((row) => mapThreadRow(row));
  }

  async upsertDelegation(record: DelegationRecord): Promise<void> {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO orchestration_delegations
        (delegation_id, parent_thread_id, child_thread_id, parent_run_id, title, prompt, status, profile_id, provider, model, skill_pack_id, launched_by, wait_event_type, result_summary, error_message, result_contract, policy_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::timestamptz, $19::timestamptz)
       ON CONFLICT (delegation_id) DO UPDATE
         SET child_thread_id = EXCLUDED.child_thread_id,
             parent_run_id = EXCLUDED.parent_run_id,
             title = EXCLUDED.title,
             prompt = EXCLUDED.prompt,
             status = EXCLUDED.status,
             profile_id = EXCLUDED.profile_id,
             provider = EXCLUDED.provider,
             model = EXCLUDED.model,
             skill_pack_id = EXCLUDED.skill_pack_id,
             launched_by = EXCLUDED.launched_by,
             wait_event_type = EXCLUDED.wait_event_type,
             result_summary = EXCLUDED.result_summary,
             error_message = EXCLUDED.error_message,
             result_contract = EXCLUDED.result_contract,
             policy_json = EXCLUDED.policy_json,
             updated_at = EXCLUDED.updated_at`,
      [
        record.delegationId,
        record.parentThreadId,
        record.childThreadId,
        record.parentRunId ?? null,
        record.title,
        record.prompt,
        record.status,
        record.profileId ?? null,
        record.provider ?? null,
        record.model ?? null,
        null,
        record.launchedBy ?? null,
        record.waitEventType ?? null,
        record.resultSummary ?? null,
        record.errorMessage ?? null,
        record.resultContract ?? null,
        stringifySanitizedJson(buildDelegationPolicyJson(record)),
        normalizeTimestampString(record.createdAt),
        normalizeTimestampString(record.updatedAt),
      ],
    );
  }

  async getDelegation(delegationId: string): Promise<DelegationRecord | null> {
    await this.ensureSchema();
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT delegation_id, parent_thread_id, child_thread_id, parent_run_id, title, prompt, status, profile_id, provider, model, skill_pack_id, launched_by, wait_event_type, result_summary, error_message, result_contract, policy_json, created_at, updated_at
         FROM orchestration_delegations
        WHERE delegation_id = $1`,
      [delegationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapDelegationRow(row);
  }

  async getDelegationByChildThreadId(childThreadId: string): Promise<DelegationRecord | null> {
    await this.ensureSchema();
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT delegation_id, parent_thread_id, child_thread_id, parent_run_id, title, prompt, status, profile_id, provider, model, skill_pack_id, launched_by, wait_event_type, result_summary, error_message, result_contract, policy_json, created_at, updated_at
         FROM orchestration_delegations
        WHERE child_thread_id = $1
        ORDER BY updated_at DESC
        LIMIT 1`,
      [childThreadId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapDelegationRow(row);
  }

  async listDelegations(input: {
    parentThreadId?: string | undefined;
    childThreadId?: string | undefined;
    status?: DelegationRecord["status"] | undefined;
  } = {}): Promise<DelegationRecord[]> {
    await this.ensureSchema();
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.parentThreadId !== undefined) {
      values.push(input.parentThreadId);
      clauses.push(`parent_thread_id = $${values.length}`);
    }
    if (input.childThreadId !== undefined) {
      values.push(input.childThreadId);
      clauses.push(`child_thread_id = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      clauses.push(`status = $${values.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT delegation_id, parent_thread_id, child_thread_id, parent_run_id, title, prompt, status, profile_id, provider, model, skill_pack_id, launched_by, wait_event_type, result_summary, error_message, result_contract, policy_json, created_at, updated_at
         FROM orchestration_delegations
         ${where}
        ORDER BY updated_at DESC, delegation_id DESC`,
      values,
    );
    return result.rows.map((row) => mapDelegationRow(row));
  }

  async upsertInteractionRequest(record: InteractionRequestRecord): Promise<void> {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO orchestration_interaction_requests
        (request_id, thread_id, kind, status, event_type, delegation_id, wait_kind, prompt, metadata_json, response_json, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::timestamptz, $12::timestamptz)
       ON CONFLICT (request_id) DO UPDATE
         SET status = EXCLUDED.status,
             prompt = EXCLUDED.prompt,
             metadata_json = EXCLUDED.metadata_json,
             response_json = EXCLUDED.response_json,
             resolved_at = EXCLUDED.resolved_at`,
      [
        record.requestId,
        record.threadId,
        record.kind,
        record.status,
        record.eventType,
        record.delegationId ?? null,
        record.waitKind ?? null,
        record.prompt ?? null,
        stringifySanitizedJson(record.metadata ?? null),
        stringifySanitizedJson(record.response ?? null),
        normalizeTimestampString(record.createdAt),
        normalizeOptionalTimestampString(record.resolvedAt) ?? null,
      ],
    );
  }

  async getInteractionRequest(requestId: string): Promise<InteractionRequestRecord | null> {
    await this.ensureSchema();
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT request_id, thread_id, kind, status, event_type, delegation_id, wait_kind, prompt, metadata_json, response_json, created_at, resolved_at
         FROM orchestration_interaction_requests
        WHERE request_id = $1`,
      [requestId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapInteractionRequestRow(row);
  }

  async listInteractionRequests(input: {
    threadId?: string | undefined;
    delegationId?: string | undefined;
    status?: InteractionRequestRecord["status"] | undefined;
  } = {}): Promise<InteractionRequestRecord[]> {
    await this.ensureSchema();
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.threadId !== undefined) {
      values.push(input.threadId);
      clauses.push(`thread_id = $${values.length}`);
    }
    if (input.delegationId !== undefined) {
      values.push(input.delegationId);
      clauses.push(`delegation_id = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      clauses.push(`status = $${values.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT request_id, thread_id, kind, status, event_type, delegation_id, wait_kind, prompt, metadata_json, response_json, created_at, resolved_at
         FROM orchestration_interaction_requests
         ${where}
        ORDER BY created_at DESC`,
      values,
    );
    return result.rows.map((row) => mapInteractionRequestRow(row));
  }

  async upsertApprovalGrant(record: ApprovalGrantRecord): Promise<void> {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO orchestration_approval_grants
        (grant_id, thread_id, request_id, delegation_id, scope, status, allowed_tool_classes_json, allowed_capabilities_json, expires_at, issued_by, issued_at, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::timestamptz, $10, $11::timestamptz, $12::jsonb)
       ON CONFLICT (grant_id) DO UPDATE
         SET status = EXCLUDED.status,
             allowed_tool_classes_json = EXCLUDED.allowed_tool_classes_json,
             allowed_capabilities_json = EXCLUDED.allowed_capabilities_json,
             expires_at = EXCLUDED.expires_at,
             metadata_json = EXCLUDED.metadata_json`,
      [
        record.grantId,
        record.threadId,
        record.requestId,
        record.delegationId ?? null,
        record.scope,
        record.status,
        stringifySanitizedJson(record.allowedToolClasses),
        stringifySanitizedJson(record.allowedCapabilities),
        normalizeOptionalTimestampString(record.expiresAt) ?? null,
        record.issuedBy,
        normalizeTimestampString(record.issuedAt),
        stringifySanitizedJson(record.metadata ?? null),
      ],
    );
  }

  async listApprovalGrants(input: {
    threadId?: string | undefined;
    requestId?: string | undefined;
    status?: ApprovalGrantRecord["status"] | undefined;
  } = {}): Promise<ApprovalGrantRecord[]> {
    await this.ensureSchema();
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.threadId !== undefined) {
      values.push(input.threadId);
      clauses.push(`thread_id = $${values.length}`);
    }
    if (input.requestId !== undefined) {
      values.push(input.requestId);
      clauses.push(`request_id = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      clauses.push(`status = $${values.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT grant_id, thread_id, request_id, delegation_id, scope, status, allowed_tool_classes_json, allowed_capabilities_json, expires_at, issued_by, issued_at, metadata_json
         FROM orchestration_approval_grants
         ${where}
        ORDER BY issued_at DESC`,
      values,
    );
    return result.rows.map((row) => mapApprovalGrantRow(row));
  }

  async upsertContextCheckpoint(record: ContextCheckpointRecord): Promise<void> {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO orchestration_context_checkpoints
        (checkpoint_id, thread_id, run_id, status, recommended_action, reason, signals_json, metadata_json, resolution_action, resolved_by, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::timestamptz, $12::timestamptz)
       ON CONFLICT (checkpoint_id) DO UPDATE
         SET thread_id = EXCLUDED.thread_id,
             run_id = EXCLUDED.run_id,
             status = EXCLUDED.status,
             recommended_action = EXCLUDED.recommended_action,
             reason = EXCLUDED.reason,
             signals_json = EXCLUDED.signals_json,
             metadata_json = EXCLUDED.metadata_json,
             resolution_action = EXCLUDED.resolution_action,
             resolved_by = EXCLUDED.resolved_by,
             created_at = EXCLUDED.created_at,
             resolved_at = EXCLUDED.resolved_at`,
      [
        record.checkpointId,
        record.threadId,
        record.runId ?? null,
        record.status,
        record.recommendedAction,
        record.reason,
        stringifySanitizedJson(record.signals ?? null),
        stringifySanitizedJson(record.metadata ?? null),
        record.resolutionAction ?? null,
        record.resolvedBy ?? null,
        normalizeTimestampString(record.createdAt),
        normalizeOptionalTimestampString(record.resolvedAt) ?? null,
      ],
    );
  }

  async getContextCheckpoint(checkpointId: string): Promise<ContextCheckpointRecord | null> {
    await this.ensureSchema();
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT checkpoint_id, thread_id, run_id, status, recommended_action, reason, signals_json, metadata_json, resolution_action, resolved_by, created_at, resolved_at
         FROM orchestration_context_checkpoints
        WHERE checkpoint_id = $1`,
      [checkpointId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapContextCheckpointRow(row);
  }

  async listContextCheckpoints(input: {
    threadId?: string | undefined;
    status?: ContextCheckpointRecord["status"] | undefined;
  } = {}): Promise<ContextCheckpointRecord[]> {
    await this.ensureSchema();
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.threadId !== undefined) {
      values.push(input.threadId);
      clauses.push(`thread_id = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      clauses.push(`status = $${values.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT checkpoint_id, thread_id, run_id, status, recommended_action, reason, signals_json, metadata_json, resolution_action, resolved_by, created_at, resolved_at
         FROM orchestration_context_checkpoints
         ${where}
        ORDER BY created_at DESC`,
      values,
    );
    return result.rows.map((row) => mapContextCheckpointRow(row));
  }

  async upsertOperatorFocus(record: OperatorFocusRecord): Promise<void> {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO orchestration_operator_focus
        (session_id, thread_id, updated_at, updated_by)
       VALUES ($1, $2, $3::timestamptz, $4)
       ON CONFLICT (session_id) DO UPDATE
         SET thread_id = EXCLUDED.thread_id,
             updated_at = EXCLUDED.updated_at,
             updated_by = EXCLUDED.updated_by`,
      [
        record.sessionId,
        record.threadId,
        normalizeTimestampString(record.updatedAt),
        record.updatedBy ?? null,
      ],
    );
  }

  async getOperatorFocus(sessionId: string): Promise<OperatorFocusRecord | null> {
    await this.ensureSchema();
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT session_id, thread_id, updated_at, updated_by
         FROM orchestration_operator_focus
        WHERE session_id = $1`,
      [sessionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapOperatorFocusRow(row);
  }

  async upsertOperatorAttention(record: OperatorAttentionRecord): Promise<void> {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO orchestration_operator_attention
        (attention_id, session_id, thread_id, kind, status, title, detail, checkpoint_id, delegation_id, child_thread_id, recommended_action, metadata_json, created_at, updated_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::timestamptz, $14::timestamptz, $15::timestamptz)
       ON CONFLICT (attention_id) DO UPDATE
         SET status = EXCLUDED.status,
             title = EXCLUDED.title,
             detail = EXCLUDED.detail,
             checkpoint_id = EXCLUDED.checkpoint_id,
             delegation_id = EXCLUDED.delegation_id,
             child_thread_id = EXCLUDED.child_thread_id,
             recommended_action = EXCLUDED.recommended_action,
             metadata_json = EXCLUDED.metadata_json,
             updated_at = EXCLUDED.updated_at,
             resolved_at = EXCLUDED.resolved_at`,
      [
        record.attentionId,
        record.sessionId,
        record.threadId,
        record.kind,
        record.status,
        record.title,
        record.detail ?? null,
        record.checkpointId ?? null,
        record.delegationId ?? null,
        record.childThreadId ?? null,
        record.recommendedAction ?? null,
        stringifySanitizedJson(record.metadata ?? null),
        normalizeTimestampString(record.createdAt),
        normalizeTimestampString(record.updatedAt),
        normalizeOptionalTimestampString(record.resolvedAt) ?? null,
      ],
    );
  }

  async getOperatorAttention(attentionId: string): Promise<OperatorAttentionRecord | null> {
    await this.ensureSchema();
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT attention_id, session_id, thread_id, kind, status, title, detail, checkpoint_id, delegation_id, child_thread_id, recommended_action, metadata_json, created_at, updated_at, resolved_at
         FROM orchestration_operator_attention
        WHERE attention_id = $1`,
      [attentionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapOperatorAttentionRow(row);
  }

  async listOperatorAttention(input: {
    sessionId?: string | undefined;
    threadId?: string | undefined;
    kind?: OperatorAttentionRecord["kind"] | undefined;
    status?: OperatorAttentionRecord["status"] | undefined;
  } = {}): Promise<OperatorAttentionRecord[]> {
    await this.ensureSchema();
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.sessionId !== undefined) {
      values.push(input.sessionId);
      clauses.push(`session_id = $${values.length}`);
    }
    if (input.threadId !== undefined) {
      values.push(input.threadId);
      clauses.push(`thread_id = $${values.length}`);
    }
    if (input.kind !== undefined) {
      values.push(input.kind);
      clauses.push(`kind = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      clauses.push(`status = $${values.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT attention_id, session_id, thread_id, kind, status, title, detail, checkpoint_id, delegation_id, child_thread_id, recommended_action, metadata_json, created_at, updated_at, resolved_at
         FROM orchestration_operator_attention
         ${where}
        ORDER BY updated_at DESC`,
      values,
    );
    return result.rows.map((row) => mapOperatorAttentionRow(row));
  }

  async saveContextSummaryArtifact(record: ContextSummaryArtifactRecord): Promise<void> {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO orchestration_context_summary_artifacts
        (artifact_id, thread_id, summary, source, metadata_json, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
       ON CONFLICT (artifact_id) DO UPDATE
         SET summary = EXCLUDED.summary,
             source = EXCLUDED.source,
             metadata_json = EXCLUDED.metadata_json`,
      [
        record.artifactId,
        record.threadId,
        record.summary,
        record.source,
        stringifySanitizedJson(record.metadata ?? null),
        normalizeTimestampString(record.createdAt),
      ],
    );
  }

  async listContextSummaryArtifacts(threadId: string): Promise<ContextSummaryArtifactRecord[]> {
    await this.ensureSchema();
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT artifact_id, thread_id, summary, source, metadata_json, created_at
         FROM orchestration_context_summary_artifacts
        WHERE thread_id = $1
        ORDER BY created_at DESC`,
      [threadId],
    );
    return result.rows.map((row) => mapContextSummaryArtifactRow(row));
  }

  async appendThreadCompactionEvent(record: ThreadCompactionEventRecord): Promise<void> {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO orchestration_thread_compaction_events
        (event_id, thread_id, action, reason, summary_artifact_id, metadata_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        record.eventId,
        record.threadId,
        record.action,
        record.reason,
        record.summaryArtifactId ?? null,
        stringifySanitizedJson(record.metadata ?? null),
        normalizeTimestampString(record.createdAt),
      ],
    );
  }

  async listThreadCompactionEvents(threadId: string): Promise<ThreadCompactionEventRecord[]> {
    await this.ensureSchema();
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT event_id, thread_id, action, reason, summary_artifact_id, metadata_json, created_at
         FROM orchestration_thread_compaction_events
        WHERE thread_id = $1
        ORDER BY created_at DESC`,
      [threadId],
    );
    return result.rows.map((row) => mapThreadCompactionEventRow(row));
  }

  async upsertAssemblyBundle(record: AssemblyBundleRecord): Promise<void> {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO orchestration_assembly_bundles
        (bundle_id, label, source, tool_allowlist_json, specialist_ids_json, context_policy_id, approval_policy_id, metadata_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb, $9::timestamptz, $10::timestamptz)
       ON CONFLICT (bundle_id) DO UPDATE
         SET label = EXCLUDED.label,
             source = EXCLUDED.source,
             tool_allowlist_json = EXCLUDED.tool_allowlist_json,
             specialist_ids_json = EXCLUDED.specialist_ids_json,
             context_policy_id = EXCLUDED.context_policy_id,
             approval_policy_id = EXCLUDED.approval_policy_id,
             metadata_json = EXCLUDED.metadata_json,
             updated_at = EXCLUDED.updated_at`,
      [
        record.bundleId,
        record.label,
        record.source,
        stringifySanitizedJson(record.toolAllowlist),
        stringifySanitizedJson(record.specialistIds),
        record.contextPolicyId ?? null,
        record.approvalPolicyId ?? null,
        stringifySanitizedJson(record.metadata ?? null),
        normalizeTimestampString(record.createdAt),
        normalizeTimestampString(record.updatedAt),
      ],
    );
  }

  async getAssemblyBundle(bundleId: string): Promise<AssemblyBundleRecord | null> {
    await this.ensureSchema();
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT bundle_id, label, source, tool_allowlist_json, specialist_ids_json, context_policy_id, approval_policy_id, metadata_json, created_at, updated_at
         FROM orchestration_assembly_bundles
        WHERE bundle_id = $1`,
      [bundleId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapAssemblyBundleRow(row);
  }

  async listAssemblyBundles(input: { source?: AssemblyBundleRecord["source"] | undefined } = {}): Promise<AssemblyBundleRecord[]> {
    await this.ensureSchema();
    const values: unknown[] = [];
    const where =
      input.source !== undefined
        ? (() => {
            values.push(input.source);
            return `WHERE source = $${values.length}`;
          })()
        : "";
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT bundle_id, label, source, tool_allowlist_json, specialist_ids_json, context_policy_id, approval_policy_id, metadata_json, created_at, updated_at
         FROM orchestration_assembly_bundles
         ${where}
        ORDER BY updated_at DESC`,
      values,
    );
    return result.rows.map((row) => mapAssemblyBundleRow(row));
  }

  async appendThreadAssemblyRecord(record: ThreadAssemblyRecord): Promise<void> {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO orchestration_thread_assembly_records
        (record_id, thread_id, bundle_id, cause, authority, metadata_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
       ON CONFLICT (record_id) DO NOTHING`,
      [
        record.recordId,
        record.threadId,
        record.bundleId,
        record.cause,
        record.authority,
        stringifySanitizedJson(record.metadata ?? null),
        normalizeTimestampString(record.createdAt),
      ],
    );
  }

  async listThreadAssemblyRecords(threadId: string): Promise<ThreadAssemblyRecord[]> {
    await this.ensureSchema();
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT record_id, thread_id, bundle_id, cause, authority, metadata_json, created_at
         FROM orchestration_thread_assembly_records
        WHERE thread_id = $1
        ORDER BY created_at DESC`,
      [threadId],
    );
    return result.rows.map((row) => mapThreadAssemblyRow(row));
  }

  async upsertAssemblyChangeProposal(record: AssemblyChangeProposalRecord): Promise<void> {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO orchestration_assembly_change_proposals
        (proposal_id, thread_id, requested_bundle_id, requested_tool_allowlist_json, requested_provider, requested_model, requested_prompt_variant, requested_specialist_ids_json, requested_context_policy_id, requested_approval_policy_id, proposed_by, status, reason, metadata_json, created_at, resolved_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14::jsonb, $15::timestamptz, $16::timestamptz)
       ON CONFLICT (proposal_id) DO UPDATE
         SET status = EXCLUDED.status,
             reason = EXCLUDED.reason,
             metadata_json = EXCLUDED.metadata_json,
             resolved_at = EXCLUDED.resolved_at`,
      [
        record.proposalId,
        record.threadId,
        record.requestedBundleId ?? null,
        stringifySanitizedJson(record.requestedToolAllowlist ?? null),
        record.requestedProvider ?? null,
        record.requestedModel ?? null,
        record.requestedPromptVariant ?? null,
        stringifySanitizedJson(record.requestedSpecialistIds ?? null),
        record.requestedContextPolicyId ?? null,
        record.requestedApprovalPolicyId ?? null,
        record.proposedBy,
        record.status,
        record.reason ?? null,
        stringifySanitizedJson(stripProposalCompatibilityRequestMetadata(record.metadata)),
        normalizeTimestampString(record.createdAt),
        normalizeOptionalTimestampString(record.resolvedAt) ?? null,
      ],
    );
  }

  async getAssemblyChangeProposal(proposalId: string): Promise<AssemblyChangeProposalRecord | null> {
    await this.ensureSchema();
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT proposal_id, thread_id, requested_bundle_id, requested_tool_allowlist_json, requested_provider, requested_model, requested_prompt_variant, requested_specialist_ids_json, requested_context_policy_id, requested_approval_policy_id, proposed_by, status, reason, metadata_json, created_at, resolved_at
         FROM orchestration_assembly_change_proposals
        WHERE proposal_id = $1`,
      [proposalId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapAssemblyProposalRow(row);
  }

  async listAssemblyChangeProposals(input: {
    threadId?: string | undefined;
    status?: AssemblyChangeProposalRecord["status"] | undefined;
  } = {}): Promise<AssemblyChangeProposalRecord[]> {
    await this.ensureSchema();
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.threadId !== undefined) {
      values.push(input.threadId);
      clauses.push(`thread_id = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      clauses.push(`status = $${values.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT proposal_id, thread_id, requested_bundle_id, requested_tool_allowlist_json, requested_provider, requested_model, requested_prompt_variant, requested_specialist_ids_json, requested_context_policy_id, requested_approval_policy_id, proposed_by, status, reason, metadata_json, created_at, resolved_at
         FROM orchestration_assembly_change_proposals
         ${where}
        ORDER BY created_at DESC`,
      values,
    );
    return result.rows.map((row) => mapAssemblyProposalRow(row));
  }

  async appendAssemblyChangeDecision(record: AssemblyChangeDecisionRecord): Promise<void> {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO orchestration_assembly_change_decisions
        (decision_id, thread_id, proposal_id, result, decided_by, reason, resulting_bundle_id, metadata_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)
       ON CONFLICT (decision_id) DO NOTHING`,
      [
        record.decisionId,
        record.threadId,
        record.proposalId ?? null,
        record.result,
        record.decidedBy,
        record.reason,
        record.resultingBundleId ?? null,
        stringifySanitizedJson(record.metadata ?? null),
        normalizeTimestampString(record.createdAt),
      ],
    );
  }

  async listAssemblyChangeDecisions(input: {
    threadId?: string | undefined;
    proposalId?: string | undefined;
  } = {}): Promise<AssemblyChangeDecisionRecord[]> {
    await this.ensureSchema();
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.threadId !== undefined) {
      values.push(input.threadId);
      clauses.push(`thread_id = $${values.length}`);
    }
    if (input.proposalId !== undefined) {
      values.push(input.proposalId);
      clauses.push(`proposal_id = $${values.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT decision_id, thread_id, proposal_id, result, decided_by, reason, resulting_bundle_id, metadata_json, created_at
         FROM orchestration_assembly_change_decisions
         ${where}
        ORDER BY created_at DESC`,
      values,
    );
    return result.rows.map((row) => mapAssemblyDecisionRow(row));
  }

  async upsertSpecialistDefinition(record: SpecialistDefinitionRecord): Promise<void> {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO orchestration_specialist_definitions
        (specialist_id, label, description, allowed_tool_allowlist_json, metadata_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::timestamptz, $7::timestamptz)
       ON CONFLICT (specialist_id) DO UPDATE
         SET label = EXCLUDED.label,
             description = EXCLUDED.description,
             allowed_tool_allowlist_json = EXCLUDED.allowed_tool_allowlist_json,
             metadata_json = EXCLUDED.metadata_json,
             updated_at = EXCLUDED.updated_at`,
      [
        record.specialistId,
        record.label,
        record.description ?? null,
        stringifySanitizedJson(record.allowedToolAllowlist),
        stringifySanitizedJson(record.metadata ?? null),
        normalizeTimestampString(record.createdAt),
        normalizeTimestampString(record.updatedAt),
      ],
    );
  }

  async listSpecialistDefinitions(): Promise<SpecialistDefinitionRecord[]> {
    await this.ensureSchema();
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT specialist_id, label, description, allowed_tool_allowlist_json, metadata_json, created_at, updated_at
         FROM orchestration_specialist_definitions
        ORDER BY specialist_id ASC`,
      [],
    );
    return result.rows.map((row) => mapSpecialistRow(row));
  }

  async upsertContextPolicyDefinition(record: ContextPolicyDefinitionRecord): Promise<void> {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO orchestration_context_policy_definitions
        (context_policy_id, label, default_action, metadata_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz)
       ON CONFLICT (context_policy_id) DO UPDATE
         SET label = EXCLUDED.label,
             default_action = EXCLUDED.default_action,
             metadata_json = EXCLUDED.metadata_json,
             updated_at = EXCLUDED.updated_at`,
      [
        record.contextPolicyId,
        record.label,
        record.defaultAction,
        stringifySanitizedJson(record.metadata ?? null),
        normalizeTimestampString(record.createdAt),
        normalizeTimestampString(record.updatedAt),
      ],
    );
  }

  async listContextPolicyDefinitions(): Promise<ContextPolicyDefinitionRecord[]> {
    await this.ensureSchema();
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT context_policy_id, label, default_action, metadata_json, created_at, updated_at
         FROM orchestration_context_policy_definitions
        ORDER BY context_policy_id ASC`,
      [],
    );
    return result.rows.map((row) => mapContextPolicyRow(row));
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) {
      return;
    }
    this.schemaReady = true;
  }
}

function mapThreadRow(row: Record<string, unknown>): ThreadRecord {
  const thread: ThreadRecord = {
    threadId: String(row.thread_id),
    sessionId: String(row.session_id),
    title: String(row.title),
    status: row.status as ThreadRecord["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  if (typeof row.parent_thread_id === "string") {
    thread.parentThreadId = row.parent_thread_id;
  }
  if (typeof row.active_run_id === "string") {
    thread.activeRunId = row.active_run_id;
  }
  if (typeof row.current_request_id === "string") {
    thread.currentRequestId = row.current_request_id;
  }
  if (typeof row.last_run_status === "string") {
    thread.lastRunStatus = row.last_run_status as ThreadRecord["lastRunStatus"];
  }
  if (isRecord(row.wait_for_json)) {
    thread.waitFor = row.wait_for_json as unknown as ThreadRecord["waitFor"];
  }
  if (isRecord(row.metadata_json)) {
    thread.metadata = row.metadata_json;
  }
  return thread;
}

function mapDelegationRow(row: Record<string, unknown>): DelegationRecord {
  const policy = isRecord(row.policy_json) ? row.policy_json : undefined;
  const subAgentResult = readSubAgentResultEnvelope(policy?.subAgentResult);
  const logicalPolicy = stripSubAgentResultFromPolicy(policy);
  return {
    delegationId: String(row.delegation_id),
    parentThreadId: String(row.parent_thread_id),
    childThreadId: String(row.child_thread_id),
    title: String(row.title),
    prompt: String(row.prompt),
    status: row.status as DelegationRecord["status"],
    ...(typeof row.parent_run_id === "string" ? { parentRunId: row.parent_run_id } : {}),
    ...(typeof row.profile_id === "string" ? { profileId: row.profile_id } : {}),
    ...(typeof row.provider === "string" ? { provider: row.provider as DelegationRecord["provider"] } : {}),
    ...(typeof row.model === "string" ? { model: row.model } : {}),
    ...(typeof row.launched_by === "string" ? { launchedBy: row.launched_by as DelegationRecord["launchedBy"] } : {}),
    ...(typeof row.wait_event_type === "string" ? { waitEventType: row.wait_event_type } : {}),
    ...(typeof row.result_summary === "string" ? { resultSummary: row.result_summary } : {}),
    ...(typeof row.error_message === "string" ? { errorMessage: row.error_message } : {}),
    ...(typeof row.result_contract === "string" ? { resultContract: row.result_contract } : {}),
    ...(subAgentResult !== undefined ? { result: subAgentResult } : {}),
    ...(logicalPolicy !== undefined ? { policy: logicalPolicy as DelegationRecord["policy"] } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function buildDelegationPolicyJson(record: DelegationRecord): Record<string, unknown> | null {
  const policy = isRecord(record.policy) ? record.policy : undefined;
  if (record.result === undefined) {
    return policy ?? null;
  }
  return {
    ...(policy ?? {}),
    subAgentResult: record.result,
  };
}

function stripSubAgentResultFromPolicy(policy: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (policy === undefined) {
    return ;
  }
  const { subAgentResult: _subAgentResult, ...rest } = policy;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function mapInteractionRequestRow(row: Record<string, unknown>): InteractionRequestRecord {
  const request: InteractionRequestRecord = {
    requestId: String(row.request_id),
    threadId: String(row.thread_id),
    kind: row.kind as InteractionRequestRecord["kind"],
    status: row.status as InteractionRequestRecord["status"],
    eventType: String(row.event_type),
    createdAt: String(row.created_at),
  };
  if (typeof row.delegation_id === "string") {
    request.delegationId = row.delegation_id;
  }
  if (typeof row.wait_kind === "string") {
    request.waitKind = row.wait_kind as InteractionRequestRecord["waitKind"];
  }
  if (typeof row.prompt === "string") {
    request.prompt = row.prompt;
  }
  if (isRecord(row.metadata_json)) {
    request.metadata = row.metadata_json;
  }
  if (isRecord(row.response_json)) {
    request.response = row.response_json;
  }
  if (typeof row.resolved_at === "string") {
    request.resolvedAt = row.resolved_at;
  }
  return request;
}

function mapApprovalGrantRow(row: Record<string, unknown>): ApprovalGrantRecord {
  return {
    grantId: String(row.grant_id),
    threadId: String(row.thread_id),
    requestId: String(row.request_id),
    ...(typeof row.delegation_id === "string" ? { delegationId: row.delegation_id } : {}),
    scope: row.scope as ApprovalGrantRecord["scope"],
    status: row.status as ApprovalGrantRecord["status"],
    allowedToolClasses: Array.isArray(row.allowed_tool_classes_json)
      ? row.allowed_tool_classes_json as ApprovalGrantRecord["allowedToolClasses"]
      : [],
    allowedCapabilities: Array.isArray(row.allowed_capabilities_json)
      ? row.allowed_capabilities_json as string[]
      : [],
    ...(typeof row.expires_at === "string" ? { expiresAt: row.expires_at } : {}),
    issuedBy: String(row.issued_by),
    issuedAt: String(row.issued_at),
    ...(isRecord(row.metadata_json) ? { metadata: row.metadata_json } : {}),
  };
}

function mapContextCheckpointRow(row: Record<string, unknown>): ContextCheckpointRecord {
  return {
    checkpointId: String(row.checkpoint_id),
    threadId: String(row.thread_id),
    ...(typeof row.run_id === "string" ? { runId: row.run_id } : {}),
    status: row.status as ContextCheckpointRecord["status"],
    recommendedAction: row.recommended_action as ContextCheckpointRecord["recommendedAction"],
    reason: String(row.reason),
    ...(isRecord(row.signals_json) ? { signals: row.signals_json } : {}),
    ...(isRecord(row.metadata_json) ? { metadata: row.metadata_json } : {}),
    ...(typeof row.resolution_action === "string" ? { resolutionAction: row.resolution_action as ContextCheckpointRecord["resolutionAction"] } : {}),
    ...(typeof row.resolved_by === "string" ? { resolvedBy: row.resolved_by } : {}),
    createdAt: String(row.created_at),
    ...(typeof row.resolved_at === "string" ? { resolvedAt: row.resolved_at } : {}),
  };
}

function mapOperatorFocusRow(row: Record<string, unknown>): OperatorFocusRecord {
  return {
    sessionId: String(row.session_id),
    threadId: String(row.thread_id),
    updatedAt: String(row.updated_at),
    ...(typeof row.updated_by === "string" ? { updatedBy: row.updated_by } : {}),
  };
}

function mapOperatorAttentionRow(row: Record<string, unknown>): OperatorAttentionRecord {
  return {
    attentionId: String(row.attention_id),
    sessionId: String(row.session_id),
    threadId: String(row.thread_id),
    kind: row.kind as OperatorAttentionRecord["kind"],
    status: row.status as OperatorAttentionRecord["status"],
    title: String(row.title),
    ...(typeof row.detail === "string" ? { detail: row.detail } : {}),
    ...(typeof row.checkpoint_id === "string" ? { checkpointId: row.checkpoint_id } : {}),
    ...(typeof row.delegation_id === "string" ? { delegationId: row.delegation_id } : {}),
    ...(typeof row.child_thread_id === "string" ? { childThreadId: row.child_thread_id } : {}),
    ...(typeof row.recommended_action === "string" ? { recommendedAction: row.recommended_action } : {}),
    ...(isRecord(row.metadata_json) ? { metadata: row.metadata_json } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(typeof row.resolved_at === "string" ? { resolvedAt: row.resolved_at } : {}),
  };
}

function mapContextSummaryArtifactRow(row: Record<string, unknown>): ContextSummaryArtifactRecord {
  return {
    artifactId: String(row.artifact_id),
    threadId: String(row.thread_id),
    summary: String(row.summary),
    source: row.source as ContextSummaryArtifactRecord["source"],
    ...(isRecord(row.metadata_json) ? { metadata: row.metadata_json } : {}),
    createdAt: String(row.created_at),
  };
}

function mapThreadCompactionEventRow(row: Record<string, unknown>): ThreadCompactionEventRecord {
  return {
    eventId: String(row.event_id),
    threadId: String(row.thread_id),
    action: row.action as ThreadCompactionEventRecord["action"],
    reason: String(row.reason),
    ...(typeof row.summary_artifact_id === "string" ? { summaryArtifactId: row.summary_artifact_id } : {}),
    ...(isRecord(row.metadata_json) ? { metadata: row.metadata_json } : {}),
    createdAt: String(row.created_at),
  };
}

function mapAssemblyBundleRow(row: Record<string, unknown>): AssemblyBundleRecord {
  return {
    bundleId: String(row.bundle_id),
    label: String(row.label),
    source: row.source as AssemblyBundleRecord["source"],
    toolAllowlist: Array.isArray(row.tool_allowlist_json) ? row.tool_allowlist_json as string[] : [],
    specialistIds: Array.isArray(row.specialist_ids_json) ? row.specialist_ids_json as string[] : [],
    ...(typeof row.context_policy_id === "string" ? { contextPolicyId: row.context_policy_id } : {}),
    ...(typeof row.approval_policy_id === "string" ? { approvalPolicyId: row.approval_policy_id } : {}),
    ...(isRecord(row.metadata_json) ? { metadata: row.metadata_json } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapThreadAssemblyRow(row: Record<string, unknown>): ThreadAssemblyRecord {
  return {
    recordId: String(row.record_id),
    threadId: String(row.thread_id),
    bundleId: String(row.bundle_id),
    cause: row.cause as ThreadAssemblyRecord["cause"],
    authority: row.authority as ThreadAssemblyRecord["authority"],
    ...(isRecord(row.metadata_json) ? { metadata: row.metadata_json } : {}),
    createdAt: String(row.created_at),
  };
}

function mapAssemblyProposalRow(row: Record<string, unknown>): AssemblyChangeProposalRecord {
  const metadata = isRecord(row.metadata_json) ? row.metadata_json : undefined;
  const requestedProvider =
    row.requested_provider === "openrouter" ||
    row.requested_provider === "openai" ||
    row.requested_provider === "anthropic" ||
    row.requested_provider === "ollama" ||
    row.requested_provider === "lmstudio"
      ? row.requested_provider
      : metadata?.requestedProvider === "openrouter" ||
          metadata?.requestedProvider === "openai" ||
          metadata?.requestedProvider === "anthropic" ||
          metadata?.requestedProvider === "ollama" ||
          metadata?.requestedProvider === "lmstudio"
        ? metadata.requestedProvider
        : undefined;
  return {
    proposalId: String(row.proposal_id),
    threadId: String(row.thread_id),
    ...(typeof row.requested_bundle_id === "string" ? { requestedBundleId: row.requested_bundle_id } : {}),
    ...(Array.isArray(row.requested_tool_allowlist_json)
      ? { requestedToolAllowlist: row.requested_tool_allowlist_json as string[] }
      : {}),
    ...(Array.isArray(row.requested_specialist_ids_json)
      ? { requestedSpecialistIds: row.requested_specialist_ids_json as string[] }
      : {}),
    ...(typeof row.requested_context_policy_id === "string"
      ? { requestedContextPolicyId: row.requested_context_policy_id }
      : {}),
    ...(typeof row.requested_approval_policy_id === "string"
      ? { requestedApprovalPolicyId: row.requested_approval_policy_id }
      : {}),
    ...(requestedProvider !== undefined ? { requestedProvider } : {}),
    ...(typeof row.requested_model === "string"
      ? { requestedModel: row.requested_model }
      : typeof metadata?.requestedModel === "string"
        ? { requestedModel: metadata.requestedModel }
        : {}),
    ...(typeof row.requested_prompt_variant === "string"
      ? { requestedPromptVariant: row.requested_prompt_variant }
      : typeof metadata?.requestedPromptVariant === "string"
        ? { requestedPromptVariant: metadata.requestedPromptVariant }
        : {}),
    proposedBy: row.proposed_by as AssemblyChangeProposalRecord["proposedBy"],
    status: row.status as AssemblyChangeProposalRecord["status"],
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    createdAt: String(row.created_at),
    ...(typeof row.resolved_at === "string" ? { resolvedAt: row.resolved_at } : {}),
  };
}

function stripProposalCompatibilityRequestMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) {
    return ;
  }
  const {
    requestedProvider: _requestedProvider,
    requestedModel: _requestedModel,
    requestedPromptVariant: _requestedPromptVariant,
    ...rest
  } = metadata;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function mapAssemblyDecisionRow(row: Record<string, unknown>): AssemblyChangeDecisionRecord {
  return {
    decisionId: String(row.decision_id),
    threadId: String(row.thread_id),
    ...(typeof row.proposal_id === "string" ? { proposalId: row.proposal_id } : {}),
    result: row.result as AssemblyChangeDecisionRecord["result"],
    decidedBy: row.decided_by as AssemblyChangeDecisionRecord["decidedBy"],
    reason: String(row.reason),
    ...(typeof row.resulting_bundle_id === "string" ? { resultingBundleId: row.resulting_bundle_id } : {}),
    ...(isRecord(row.metadata_json) ? { metadata: row.metadata_json } : {}),
    createdAt: String(row.created_at),
  };
}

function mapSpecialistRow(row: Record<string, unknown>): SpecialistDefinitionRecord {
  return {
    specialistId: String(row.specialist_id),
    label: String(row.label),
    ...(typeof row.description === "string" ? { description: row.description } : {}),
    allowedToolAllowlist: Array.isArray(row.allowed_tool_allowlist_json)
      ? row.allowed_tool_allowlist_json as string[]
      : [],
    ...(isRecord(row.metadata_json) ? { metadata: row.metadata_json } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapContextPolicyRow(row: Record<string, unknown>): ContextPolicyDefinitionRecord {
  return {
    contextPolicyId: String(row.context_policy_id),
    label: String(row.label),
    defaultAction: row.default_action as ContextPolicyDefinitionRecord["defaultAction"],
    ...(isRecord(row.metadata_json) ? { metadata: row.metadata_json } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}
