import { randomUUID } from "node:crypto";

import type { SqlExecutor } from "../store/PostgresSessionStore.js";
import type { RuntimeId } from "../runtimes/contracts.js";

export type LocalRuntimeBindingStatus = "ready" | "degraded" | "released";
export type LocalRuntimeNativeSessionState =
  | "uninitialized"
  | "ready"
  | "degraded"
  | "released";
export type LocalRuntimeRecoveryPolicy =
  | "fork_to_kestrel"
  | "fork_to_same_runtime";

export interface LocalRuntimeBindingV1 {
  version: "local_runtime_binding_v1";
  canonicalThreadId: string;
  runnerSessionId: string;
  bindingId: string;
  participantId: string;
  runtimeId: RuntimeId;
  environmentId: string;
  capabilityDigest: string;
  modelProvider: string;
  modelId: string;
  status: LocalRuntimeBindingStatus;
  nativeSessionState: LocalRuntimeNativeSessionState;
  latestLossCode?: string | undefined;
  sourceBindingId?: string | undefined;
  forkedFromThreadId?: string | undefined;
  recoveryPolicy?: LocalRuntimeRecoveryPolicy | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface AdmitLocalRuntimeBindingInput {
  canonicalThreadId: string;
  runnerSessionId: string;
  runtimeId: RuntimeId;
  capabilityDigest: string;
  modelProvider: string;
  modelId: string;
  environmentId?: string | undefined;
  bindingId?: string | undefined;
  participantId?: string | undefined;
}

export interface ProjectLocalRuntimeBindingInput
  extends AdmitLocalRuntimeBindingInput {
  environmentId: string;
  bindingId: string;
  participantId: string;
  status: LocalRuntimeBindingStatus;
  nativeSessionState: LocalRuntimeNativeSessionState;
}

export interface CorrelateLocalRuntimeBindingInput {
  canonicalThreadId: string;
  bindingId: string;
  participantId: string;
  runtimeId: RuntimeId;
  environmentId: string;
}

export interface ResolveLocalRunStartEnvironmentInput {
  runnerSessionId: string;
  runtimeId: RuntimeId;
  runtimeBindingId?: string | undefined;
  participantId?: string | undefined;
}

export interface CreateLocalRuntimeRecoveryForkInput
  extends CorrelateLocalRuntimeBindingInput {
  targetCanonicalThreadId: string;
  targetRunnerSessionId: string;
  targetBindingId?: string | undefined;
  targetParticipantId?: string | undefined;
  targetRuntimeId: RuntimeId;
  targetEnvironmentId: string;
  targetCapabilityDigest: string;
  targetModelProvider: string;
  targetModelId: string;
  lossCode: "RUNTIME_NATIVE_SESSION_LOST" | "RUNTIME_LIVE_WAIT_LOST";
}

export interface LocalRuntimeBindingReleaseV1 {
  version: "local_runtime_binding_release_v1";
  id: string;
  bindingId: string;
  participantId: string;
  canonicalThreadId: string;
  runtimeId: Exclude<RuntimeId, "kestrel">;
  environmentId: string;
  state: "pending" | "delivering" | "released" | "failed";
  attempts: number;
  acknowledgementEventId?: string | undefined;
  failureCode?: string | undefined;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt?: string | undefined;
}

export interface CompleteLocalRuntimeBindingReleaseInput {
  releaseId: string;
  eventId: string;
  commandId: string;
  bindingId: string;
  participantId: string;
  canonicalThreadId: string;
  runtimeId: Exclude<RuntimeId, "kestrel">;
  environmentId: string;
}

interface RuntimeBindingRow extends Record<string, unknown> {
  canonical_thread_id: string;
  runner_session_id: string;
  binding_id: string;
  participant_id: string;
  runtime_id: string;
  environment_id: string;
  capability_digest: string;
  model_provider: string;
  model_id: string;
  status: string;
  native_session_state: string;
  latest_loss_code: string | null;
  source_binding_id: string | null;
  forked_from_thread_id: string | null;
  recovery_policy: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface RuntimeBindingReleaseRow extends Record<string, unknown> {
  id: string;
  binding_id: string;
  participant_id: string;
  canonical_thread_id: string;
  runtime_id: string;
  environment_id: string;
  state: string;
  attempts: number | string;
  acknowledgement_event_id: string | null;
  failure_code: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  acknowledged_at: string | Date | null;
}

export class LocalCoreRuntimeBindingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalCoreRuntimeBindingError";
  }
}

/**
 * Local Core's durable authority for Desktop Runtime identity. Adapter-local
 * maps are caches only; every run is projected from one record in this store.
 */
export class LocalCoreRuntimeBindingStore {
  constructor(
    private readonly executor: SqlExecutor,
    private readonly transactionScoped = false,
  ) {}

  async transaction<T>(
    action: (
      store: LocalCoreRuntimeBindingStore,
      executor: SqlExecutor,
    ) => Promise<T>,
  ): Promise<T> {
    return await this.inTransaction(async (executor) =>
      await action(
        new LocalCoreRuntimeBindingStore(executor, true),
        executor,
      ));
  }

  async environmentId(): Promise<string> {
    return await this.inTransaction(async (transaction) => {
      const current = await transaction.query<{ environment_id: string }>(
        "SELECT environment_id FROM local_runtime_environment_identity WHERE identity_key = 'local'",
      );
      const existing = current.rows[0]?.environment_id;
      if (existing !== undefined) return existing;
      const generated = randomUUID();
      await transaction.query(
        `INSERT INTO local_runtime_environment_identity (identity_key, environment_id)
         VALUES ('local', $1)
         ON CONFLICT (identity_key) DO NOTHING`,
        [generated],
      );
      const resolved = await transaction.query<{ environment_id: string }>(
        "SELECT environment_id FROM local_runtime_environment_identity WHERE identity_key = 'local'",
      );
      const environmentId = resolved.rows[0]?.environment_id;
      if (environmentId === undefined) {
        throw new Error("Local Core Runtime environment identity was not persisted.");
      }
      return environmentId;
    });
  }

  async get(canonicalThreadId: string): Promise<LocalRuntimeBindingV1 | undefined> {
    const result = await this.executor.query<RuntimeBindingRow>(
      "SELECT * FROM local_runtime_bindings WHERE canonical_thread_id = $1",
      [required(canonicalThreadId, "canonicalThreadId")],
    );
    return result.rows[0] === undefined ? undefined : toBinding(result.rows[0]);
  }

  async getForRunnerSession(
    sessionId: string,
  ): Promise<LocalRuntimeBindingV1 | undefined> {
    const result = await this.executor.query<RuntimeBindingRow>(
      "SELECT * FROM local_runtime_bindings WHERE runner_session_id = $1",
      [required(sessionId, "sessionId")],
    );
    return result.rows[0] === undefined ? undefined : toBinding(result.rows[0]);
  }

  async resolveRunStartEnvironment(
    input: ResolveLocalRunStartEnvironmentInput,
  ): Promise<string> {
    const runnerSessionId = required(input.runnerSessionId, "runnerSessionId");
    const runtimeId = requireRuntimeId(input.runtimeId);
    const binding = await this.getForRunnerSession(runnerSessionId);
    if (binding === undefined) {
      if (
        runtimeId === "kestrel" &&
        input.runtimeBindingId === undefined &&
        input.participantId === undefined
      ) {
        return await this.environmentId();
      }
      throw new LocalCoreRuntimeBindingError(
        "RUNTIME_BINDING_NOT_FOUND",
        "The Runner session has no authoritative Runtime binding.",
      );
    }
    if (
      input.runtimeBindingId === undefined ||
      input.participantId === undefined ||
      binding.bindingId !== input.runtimeBindingId ||
      binding.participantId !== input.participantId ||
      binding.runtimeId !== runtimeId
    ) {
      throw new LocalCoreRuntimeBindingError(
        "RUNTIME_BINDING_CORRELATION_INVALID",
        "The run.start Runtime binding correlation does not match Local Core authority.",
      );
    }
    assertAdmissible(binding);
    return binding.environmentId;
  }

  async admit(input: AdmitLocalRuntimeBindingInput): Promise<LocalRuntimeBindingV1> {
    const environmentId = input.environmentId ?? await this.environmentId();
    const canonicalThreadId = required(input.canonicalThreadId, "canonicalThreadId");
    const runnerSessionId = required(input.runnerSessionId, "runnerSessionId");
    const runtimeId = requireRuntimeId(input.runtimeId);
    const bindingId = input.bindingId ?? randomUUID();
    const participantId = input.participantId ?? `runtime:${runtimeId}:${randomUUID()}`;
    const initialNativeState = runtimeId === "kestrel" ? "ready" : "uninitialized";
    return await this.inTransaction(async (transaction) => {
      await transaction.query(
         `INSERT INTO local_runtime_bindings (
           canonical_thread_id, runner_session_id, binding_id, participant_id, runtime_id,
           environment_id, capability_digest, model_provider, model_id,
           status, native_session_state, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10,NOW(),NOW())
         ON CONFLICT (canonical_thread_id) DO NOTHING`,
        [
          canonicalThreadId,
          runnerSessionId,
          required(bindingId, "bindingId"),
          required(participantId, "participantId"),
          runtimeId,
          required(environmentId, "environmentId"),
          required(input.capabilityDigest, "capabilityDigest"),
          required(input.modelProvider, "modelProvider"),
          required(input.modelId, "modelId"),
          initialNativeState,
        ],
      );
      const existing = await selectRequired(transaction, canonicalThreadId);
      assertImmutableBinding(existing, {
        canonicalThreadId,
        runnerSessionId,
        bindingId: input.bindingId ?? existing.bindingId,
        participantId: input.participantId ?? existing.participantId,
        runtimeId,
        environmentId,
        capabilityDigest: input.capabilityDigest,
        modelProvider: input.modelProvider,
        modelId: input.modelId,
      });
      assertAdmissible(existing);
      return existing;
    });
  }

  async project(input: ProjectLocalRuntimeBindingInput): Promise<LocalRuntimeBindingV1> {
    const admitted = await this.admit(input);
    if (
      admitted.status !== input.status ||
      admitted.nativeSessionState !== input.nativeSessionState
    ) {
      throw new LocalCoreRuntimeBindingError(
        "RUNTIME_BINDING_CORRELATION_INVALID",
        "The authoritative Runtime lifecycle does not match the local projection.",
      );
    }
    return admitted;
  }

  async establish(input: CorrelateLocalRuntimeBindingInput): Promise<LocalRuntimeBindingV1> {
    return await this.transition(input, "ready", "ready");
  }

  async degrade(
    input: CorrelateLocalRuntimeBindingInput & { lossCode: string },
  ): Promise<LocalRuntimeBindingV1> {
    return await this.transition(input, "degraded", "degraded", input.lossCode);
  }

  async release(
    input: CorrelateLocalRuntimeBindingInput & { acknowledgementEventId?: string | undefined },
  ): Promise<LocalRuntimeBindingV1> {
    return await this.inTransaction(async (transaction) => {
      const binding = await selectRequired(transaction, input.canonicalThreadId);
      assertCorrelation(binding, input);
      assertTransition(binding, "released", "released");
      const existingRelease = binding.runtimeId === "kestrel"
        ? undefined
        : await selectRelease(transaction, binding.bindingId);
      if (
        existingRelease?.acknowledgementEventId !== null &&
        existingRelease?.acknowledgementEventId !== undefined &&
        existingRelease.acknowledgementEventId !== input.acknowledgementEventId
      ) {
        throw new LocalCoreRuntimeBindingError(
          "RUNTIME_RELEASE_ACKNOWLEDGEMENT_CONFLICT",
          "The Runtime binding was already released by a different durable event.",
        );
      }
      const result = await transaction.query<RuntimeBindingRow>(
        `UPDATE local_runtime_bindings
            SET status = 'released', native_session_state = 'released', updated_at = NOW()
          WHERE canonical_thread_id = $1
          RETURNING *`,
        [binding.canonicalThreadId],
      );
      if (binding.runtimeId !== "kestrel") {
        await transaction.query(
          `INSERT INTO local_runtime_binding_release_outbox (
             id, binding_id, participant_id, canonical_thread_id, runtime_id,
             environment_id, state, attempts, acknowledgement_event_id,
             acknowledged_at, created_at, updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,
             CASE WHEN $8::text IS NULL THEN 0 ELSE 1 END,
             $8::text,$9::timestamptz,NOW(),NOW()
           )
           ON CONFLICT (binding_id) DO UPDATE SET
             state = EXCLUDED.state,
             acknowledgement_event_id = COALESCE(
               local_runtime_binding_release_outbox.acknowledgement_event_id,
               EXCLUDED.acknowledgement_event_id
             ),
             acknowledged_at = COALESCE(
               local_runtime_binding_release_outbox.acknowledged_at,
               EXCLUDED.acknowledged_at
             ),
             updated_at = NOW()`,
          [
            randomUUID(),
            binding.bindingId,
            binding.participantId,
            binding.canonicalThreadId,
            binding.runtimeId,
            binding.environmentId,
            input.acknowledgementEventId === undefined ? "pending" : "released",
            input.acknowledgementEventId ?? null,
            input.acknowledgementEventId === undefined ? null : new Date(),
          ],
        );
      }
      return toBinding(result.rows[0]!);
    });
  }

  /**
   * Claims one durable native cleanup job. Local Core has one execution
   * authority, while the row lock keeps explicit wake-ups and timer polling
   * from ever delivering the same release concurrently.
   */
  async claimRuntimeBindingRelease(input: {
    retryBefore: Date;
  }): Promise<LocalRuntimeBindingReleaseV1 | undefined> {
    return await this.inTransaction(async (transaction) => {
      const candidate = await transaction.query<RuntimeBindingReleaseRow>(
        `SELECT *
           FROM local_runtime_binding_release_outbox
          WHERE state = 'pending'
             OR (state IN ('failed', 'delivering') AND updated_at <= $1)
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [input.retryBefore],
      );
      const row = candidate.rows[0];
      if (row === undefined) return undefined;
      const claimed = await transaction.query<RuntimeBindingReleaseRow>(
        `UPDATE local_runtime_binding_release_outbox
            SET state = 'delivering', attempts = attempts + 1,
                failure_code = NULL, updated_at = NOW()
          WHERE id = $1 AND state = $2
          RETURNING *`,
        [row.id, row.state],
      );
      const claimedRow = claimed.rows[0];
      return claimedRow === undefined ? undefined : toRelease(claimedRow);
    });
  }

  async completeRuntimeBindingRelease(
    input: CompleteLocalRuntimeBindingReleaseInput,
  ): Promise<LocalRuntimeBindingReleaseV1> {
    return await this.inTransaction(async (transaction) => {
      const release = await selectReleaseById(transaction, input.releaseId, true);
      assertReleaseCorrelation(release, input);
      if (release.state === "released") {
        if (release.acknowledgementEventId !== input.eventId) {
          throw new LocalCoreRuntimeBindingError(
            "RUNTIME_RELEASE_ACKNOWLEDGEMENT_CONFLICT",
            "The Runtime release was already acknowledged by a different durable event.",
          );
        }
        return release;
      }
      if (release.state !== "delivering") {
        throw new LocalCoreRuntimeBindingError(
          "RUNTIME_RELEASE_STATE_CONFLICT",
          "The Runtime release acknowledgement does not match an active delivery.",
        );
      }
      const result = await transaction.query<RuntimeBindingReleaseRow>(
        `UPDATE local_runtime_binding_release_outbox
            SET state = 'released', acknowledgement_event_id = $2,
                failure_code = NULL, acknowledged_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND state = 'delivering'
          RETURNING *`,
        [release.id, input.eventId],
      );
      const completed = result.rows[0];
      if (completed === undefined) {
        throw new LocalCoreRuntimeBindingError(
          "RUNTIME_RELEASE_STATE_CONFLICT",
          "The Runtime release delivery changed before acknowledgement was persisted.",
        );
      }
      return toRelease(completed);
    });
  }

  async failRuntimeBindingRelease(
    releaseId: string,
    failureCode: string,
  ): Promise<LocalRuntimeBindingReleaseV1> {
    return await this.inTransaction(async (transaction) => {
      const release = await selectReleaseById(transaction, releaseId, true);
      if (release.state === "released") return release;
      if (release.state !== "delivering") {
        throw new LocalCoreRuntimeBindingError(
          "RUNTIME_RELEASE_STATE_CONFLICT",
          "The Runtime release failure does not match an active delivery.",
        );
      }
      const result = await transaction.query<RuntimeBindingReleaseRow>(
        `UPDATE local_runtime_binding_release_outbox
            SET state = 'failed', failure_code = $2, updated_at = NOW()
          WHERE id = $1 AND state = 'delivering'
          RETURNING *`,
        [release.id, sanitizeReleaseFailureCode(failureCode)],
      );
      const failed = result.rows[0];
      if (failed === undefined) {
        throw new LocalCoreRuntimeBindingError(
          "RUNTIME_RELEASE_STATE_CONFLICT",
          "The Runtime release delivery changed before failure was persisted.",
        );
      }
      return toRelease(failed);
    });
  }

  async createRecoveryFork(
    input: CreateLocalRuntimeRecoveryForkInput,
  ): Promise<{ source: LocalRuntimeBindingV1; fork: LocalRuntimeBindingV1 }> {
    const expectedTarget = input.lossCode === "RUNTIME_NATIVE_SESSION_LOST"
      ? "kestrel"
      : input.runtimeId;
    if (input.targetRuntimeId !== expectedTarget) {
      throw new LocalCoreRuntimeBindingError(
        "RUNTIME_RECOVERY_POLICY_INVALID",
        "The requested Runtime recovery target does not match the terminal loss policy.",
      );
    }
    return await this.inTransaction(async (transaction) => {
      const source = await selectRequired(transaction, input.canonicalThreadId);
      assertCorrelation(source, input);
      if (
        source.status !== "degraded" ||
        source.nativeSessionState !== "degraded" ||
        source.latestLossCode !== input.lossCode
      ) {
        throw new LocalCoreRuntimeBindingError(
          "RUNTIME_BINDING_DEGRADED",
          "Runtime recovery requires a matching durable terminal loss on the source binding.",
        );
      }
      const policy: LocalRuntimeRecoveryPolicy =
        input.lossCode === "RUNTIME_NATIVE_SESSION_LOST"
          ? "fork_to_kestrel"
          : "fork_to_same_runtime";
      const existingRecovery = await selectRecoveryFork(
        transaction,
        source.bindingId,
      );
      if (existingRecovery !== undefined) {
        assertRecoveryFork(existingRecovery, source, input, policy);
        return { source, fork: existingRecovery };
      }
      if (source.runtimeId !== "kestrel") {
        await enqueueRelease(transaction, source);
      }
      await transaction.query(
         `INSERT INTO local_runtime_bindings (
           canonical_thread_id, runner_session_id, binding_id, participant_id, runtime_id,
           environment_id, capability_digest, model_provider, model_id,
           status, native_session_state, source_binding_id,
           forked_from_thread_id, recovery_policy, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10,$11,$12,$13,NOW(),NOW())
         ON CONFLICT DO NOTHING`,
        [
          required(input.targetCanonicalThreadId, "targetCanonicalThreadId"),
          required(input.targetRunnerSessionId, "targetRunnerSessionId"),
          input.targetBindingId ?? randomUUID(),
          input.targetParticipantId ?? `runtime:${input.targetRuntimeId}:${randomUUID()}`,
          input.targetRuntimeId,
          required(input.targetEnvironmentId, "targetEnvironmentId"),
          required(input.targetCapabilityDigest, "targetCapabilityDigest"),
          required(input.targetModelProvider, "targetModelProvider"),
          required(input.targetModelId, "targetModelId"),
          input.targetRuntimeId === "kestrel" ? "ready" : "uninitialized",
          source.bindingId,
          source.canonicalThreadId,
          policy,
        ],
      );
      const fork = await selectRecoveryFork(transaction, source.bindingId);
      if (fork === undefined) {
        throw new LocalCoreRuntimeBindingError(
          "RUNTIME_RECOVERY_FORK_CONFLICT",
          "The recovery Thread conflicts with an existing Runtime binding.",
        );
      }
      assertRecoveryFork(fork, source, input, policy);
      return {
        source,
        fork,
      };
    });
  }

  private async transition(
    input: CorrelateLocalRuntimeBindingInput,
    status: LocalRuntimeBindingStatus,
    nativeState: LocalRuntimeNativeSessionState,
    latestLossCode?: string,
  ): Promise<LocalRuntimeBindingV1> {
    return await this.inTransaction(async (transaction) => {
      const binding = await selectRequired(transaction, input.canonicalThreadId);
      assertCorrelation(binding, input);
      assertTransition(binding, status, nativeState);
      if (
        status === "degraded" &&
        binding.status === "degraded" &&
        binding.latestLossCode !== latestLossCode
      ) {
        throw new LocalCoreRuntimeBindingError(
          "RUNTIME_BINDING_TRANSITION_INVALID",
          "A degraded Runtime binding cannot change its proven terminal loss.",
        );
      }
      const result = await transaction.query<RuntimeBindingRow>(
        `UPDATE local_runtime_bindings
            SET status = $2, native_session_state = $3,
                latest_loss_code = COALESCE($4, latest_loss_code), updated_at = NOW()
          WHERE canonical_thread_id = $1
          RETURNING *`,
        [binding.canonicalThreadId, status, nativeState, latestLossCode ?? null],
      );
      return toBinding(result.rows[0]!);
    });
  }

  private async inTransaction<T>(
    action: (executor: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    if (this.transactionScoped) return await action(this.executor);
    return await withTransaction(this.executor, action);
  }
}

async function selectRelease(
  executor: SqlExecutor,
  bindingId: string,
): Promise<{ acknowledgementEventId: string | null } | undefined> {
  const result = await executor.query<{ acknowledgement_event_id: string | null }>(
    `SELECT acknowledgement_event_id
       FROM local_runtime_binding_release_outbox
      WHERE binding_id = $1`,
    [required(bindingId, "bindingId")],
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : { acknowledgementEventId: row.acknowledgement_event_id };
}

async function selectReleaseById(
  executor: SqlExecutor,
  releaseId: string,
  lock: boolean,
): Promise<LocalRuntimeBindingReleaseV1> {
  const result = await executor.query<RuntimeBindingReleaseRow>(
    `SELECT *
       FROM local_runtime_binding_release_outbox
      WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [required(releaseId, "releaseId")],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new LocalCoreRuntimeBindingError(
      "RUNTIME_RELEASE_NOT_FOUND",
      "The durable Runtime release job does not exist.",
    );
  }
  return toRelease(row);
}

async function selectRecoveryFork(
  executor: SqlExecutor,
  sourceBindingId: string,
): Promise<LocalRuntimeBindingV1 | undefined> {
  const result = await executor.query<RuntimeBindingRow>(
    "SELECT * FROM local_runtime_bindings WHERE source_binding_id = $1",
    [required(sourceBindingId, "sourceBindingId")],
  );
  return result.rows[0] === undefined ? undefined : toBinding(result.rows[0]);
}

function assertRecoveryFork(
  fork: LocalRuntimeBindingV1,
  source: LocalRuntimeBindingV1,
  input: CreateLocalRuntimeRecoveryForkInput,
  policy: LocalRuntimeRecoveryPolicy,
): void {
  if (
    fork.sourceBindingId !== source.bindingId ||
    fork.forkedFromThreadId !== source.canonicalThreadId ||
    fork.recoveryPolicy !== policy ||
    fork.runtimeId !== input.targetRuntimeId ||
    fork.environmentId !== input.targetEnvironmentId ||
    fork.capabilityDigest !== input.targetCapabilityDigest ||
    fork.modelProvider !== input.targetModelProvider ||
    fork.modelId !== input.targetModelId
  ) {
    throw new LocalCoreRuntimeBindingError(
      "RUNTIME_RECOVERY_FORK_CONFLICT",
      "The source Runtime binding already has a differently correlated recovery fork.",
    );
  }
}

function assertReleaseCorrelation(
  release: LocalRuntimeBindingReleaseV1,
  input: CompleteLocalRuntimeBindingReleaseInput,
): void {
  if (
    input.commandId !== release.id ||
    input.bindingId !== release.bindingId ||
    input.participantId !== release.participantId ||
    input.canonicalThreadId !== release.canonicalThreadId ||
    input.runtimeId !== release.runtimeId ||
    input.environmentId !== release.environmentId
  ) {
    throw new LocalCoreRuntimeBindingError(
      "RUNTIME_RELEASE_CORRELATION_INVALID",
      "The Runtime release event does not match the durable cleanup job.",
    );
  }
}

async function selectRequired(
  executor: SqlExecutor,
  canonicalThreadId: string,
): Promise<LocalRuntimeBindingV1> {
  const result = await executor.query<RuntimeBindingRow>(
    "SELECT * FROM local_runtime_bindings WHERE canonical_thread_id = $1",
    [required(canonicalThreadId, "canonicalThreadId")],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new LocalCoreRuntimeBindingError(
      "RUNTIME_BINDING_NOT_FOUND",
      "The canonical Desktop Thread has no Runtime binding.",
    );
  }
  return toBinding(row);
}

async function enqueueRelease(
  executor: SqlExecutor,
  binding: LocalRuntimeBindingV1,
): Promise<void> {
  await executor.query(
    `INSERT INTO local_runtime_binding_release_outbox (
       id, binding_id, participant_id, canonical_thread_id, runtime_id,
       environment_id, state, attempts, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'pending',0,NOW(),NOW())
     ON CONFLICT (binding_id) DO NOTHING`,
    [
      randomUUID(),
      binding.bindingId,
      binding.participantId,
      binding.canonicalThreadId,
      binding.runtimeId,
      binding.environmentId,
    ],
  );
}

function assertImmutableBinding(
  binding: LocalRuntimeBindingV1,
  expected: Omit<AdmitLocalRuntimeBindingInput, "environmentId"> & {
    bindingId: string;
    participantId: string;
    environmentId: string;
  },
): void {
  if (
    binding.runnerSessionId !== expected.runnerSessionId ||
    binding.bindingId !== expected.bindingId ||
    binding.participantId !== expected.participantId ||
    binding.runtimeId !== expected.runtimeId ||
    binding.environmentId !== expected.environmentId ||
    binding.capabilityDigest !== expected.capabilityDigest ||
    binding.modelProvider !== expected.modelProvider ||
    binding.modelId !== expected.modelId
  ) {
    throw new LocalCoreRuntimeBindingError(
      "RUNTIME_BINDING_IMMUTABLE",
      "The Runtime, model route, or binding identity for this Thread cannot change.",
    );
  }
}

function assertCorrelation(
  binding: LocalRuntimeBindingV1,
  expected: CorrelateLocalRuntimeBindingInput,
): void {
  if (
    binding.bindingId !== expected.bindingId ||
    binding.participantId !== expected.participantId ||
    binding.runtimeId !== expected.runtimeId ||
    binding.environmentId !== expected.environmentId
  ) {
    throw new LocalCoreRuntimeBindingError(
      "RUNTIME_BINDING_CORRELATION_INVALID",
      "Runtime binding correlation does not match Local Core authority.",
    );
  }
}

function assertAdmissible(binding: LocalRuntimeBindingV1): void {
  if (
    binding.status === "degraded" ||
    binding.status === "released" ||
    binding.nativeSessionState === "degraded" ||
    binding.nativeSessionState === "released"
  ) {
    throw new LocalCoreRuntimeBindingError(
      "RUNTIME_BINDING_DEGRADED",
      "This Runtime binding is read-only and must be recovered into a new Thread.",
    );
  }
}

function assertTransition(
  binding: LocalRuntimeBindingV1,
  nextStatus: LocalRuntimeBindingStatus,
  nextNativeState: LocalRuntimeNativeSessionState,
): void {
  if (binding.status === nextStatus && binding.nativeSessionState === nextNativeState) return;
  const allowed =
    (binding.status === "ready" &&
      (nextStatus === "degraded" || nextStatus === "released")) ||
    (binding.status === "degraded" && nextStatus === "released") ||
    (binding.status === "ready" &&
      binding.nativeSessionState === "uninitialized" &&
      nextStatus === "ready" &&
      nextNativeState === "ready");
  if (!allowed) {
    throw new LocalCoreRuntimeBindingError(
      "RUNTIME_BINDING_TRANSITION_INVALID",
      `Runtime binding cannot transition from ${binding.status}/${binding.nativeSessionState} to ${nextStatus}/${nextNativeState}.`,
    );
  }
}

function toBinding(row: RuntimeBindingRow): LocalRuntimeBindingV1 {
  return {
    version: "local_runtime_binding_v1",
    canonicalThreadId: row.canonical_thread_id,
    runnerSessionId: row.runner_session_id,
    bindingId: row.binding_id,
    participantId: row.participant_id,
    runtimeId: requireRuntimeId(row.runtime_id),
    environmentId: row.environment_id,
    capabilityDigest: row.capability_digest,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    status: requireStatus(row.status),
    nativeSessionState: requireNativeState(row.native_session_state),
    ...(row.latest_loss_code !== null ? { latestLossCode: row.latest_loss_code } : {}),
    ...(row.source_binding_id !== null ? { sourceBindingId: row.source_binding_id } : {}),
    ...(row.forked_from_thread_id !== null ? { forkedFromThreadId: row.forked_from_thread_id } : {}),
    ...(row.recovery_policy !== null
      ? { recoveryPolicy: row.recovery_policy as LocalRuntimeRecoveryPolicy }
      : {}),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function toRelease(row: RuntimeBindingReleaseRow): LocalRuntimeBindingReleaseV1 {
  const runtimeId = requireRuntimeId(row.runtime_id);
  if (runtimeId === "kestrel") {
    throw new Error("Local Runtime release outbox cannot contain Kestrel cleanup.");
  }
  if (
    row.state !== "pending" &&
    row.state !== "delivering" &&
    row.state !== "released" &&
    row.state !== "failed"
  ) {
    throw new Error("Local Runtime release outbox has an invalid state.");
  }
  const attempts = Number(row.attempts);
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new Error("Local Runtime release outbox has an invalid attempt count.");
  }
  return {
    version: "local_runtime_binding_release_v1",
    id: required(row.id, "release.id"),
    bindingId: required(row.binding_id, "release.bindingId"),
    participantId: required(row.participant_id, "release.participantId"),
    canonicalThreadId: required(row.canonical_thread_id, "release.canonicalThreadId"),
    runtimeId,
    environmentId: required(row.environment_id, "release.environmentId"),
    state: row.state,
    attempts,
    ...(row.acknowledgement_event_id !== null
      ? { acknowledgementEventId: row.acknowledgement_event_id }
      : {}),
    ...(row.failure_code !== null ? { failureCode: row.failure_code } : {}),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    ...(row.acknowledged_at !== null
      ? { acknowledgedAt: timestamp(row.acknowledged_at) }
      : {}),
  };
}

function sanitizeReleaseFailureCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(normalized)
    ? normalized
    : "RUNTIME_RELEASE_DELIVERY_FAILED";
}

function requireRuntimeId(value: unknown): RuntimeId {
  if (value !== "kestrel" && value !== "codex" && value !== "claude") {
    throw new Error("Local Runtime binding has an invalid Runtime ID.");
  }
  return value;
}

function requireStatus(value: unknown): LocalRuntimeBindingStatus {
  if (value !== "ready" && value !== "degraded" && value !== "released") {
    throw new Error("Local Runtime binding has an invalid status.");
  }
  return value;
}

function requireNativeState(value: unknown): LocalRuntimeNativeSessionState {
  if (
    value !== "uninitialized" &&
    value !== "ready" &&
    value !== "degraded" &&
    value !== "released"
  ) {
    throw new Error("Local Runtime binding has an invalid native-session state.");
  }
  return value;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must be non-empty.`);
  return normalized;
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function withTransaction<T>(
  executor: SqlExecutor,
  action: (executor: SqlExecutor) => Promise<T>,
): Promise<T> {
  if (executor.transaction !== undefined) return await executor.transaction(action);
  await executor.query("BEGIN");
  try {
    const result = await action(executor);
    await executor.query("COMMIT");
    return result;
  } catch (error) {
    await executor.query("ROLLBACK");
    throw error;
  }
}
