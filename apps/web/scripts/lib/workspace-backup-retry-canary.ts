import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWorkspaceBackupDecryptionStream } from "@/lib/environments/backup-crypto";
import {
  productionTag,
  rejectUnknownArguments,
  requiredArgument,
} from "./production-command";

export const WORKSPACE_BACKUP_RETRY_DEADLINE_MS = 15 * 60_000;

export type WorkspaceBackupRetryCanaryArgs = {
  threadId: string;
  controlWorkerMachineId: string;
  tag: string;
};

export type SnapshotEvidence = {
  flySnapshotId: string;
  flySnapshotSourceVolumeId: string;
  flySnapshotState: string;
  flySnapshotRequestedAt: string;
  flySnapshotLastObservedAt: string;
};

export type ProviderMachine = {
  id: string;
  state: string;
  imageTag: string | null;
  imageRepository: string | null;
  imageDigest: string | null;
  workerCheckStatus: string | null;
  workerBuildId: string | null;
};

export type EnvironmentInventory = {
  machines: Array<{
    id: string;
    state: string | null;
    region: string | null;
    workspaceId: string | null;
    replacementId: string | null;
    mountedVolumeIds: string[];
    healthStatus: string | null;
    image: string | null;
    resolvedImageDigest: string | null;
  }>;
  volumes: Array<{
    id: string;
    name: string;
    region: string | null;
    sizeGb: number | null;
    attachedMachineId: string | null;
  }>;
};

export type FlySnapshot = {
  id: string;
  state: string;
};

export type CanaryTarget = {
  operator: string;
  thread: {
    id: string;
    projectId: string | null;
    organizationId: string;
    createdByUserId: string | null;
  };
  actor: { id: string; organizationRole: string };
  binding: {
    threadId: string;
    organizationId: string;
    environmentId: string;
    workspaceId: string;
  };
  environment: {
    id: string;
    provider: string;
    status: string;
    flyAppName: string | null;
  };
  workspace: {
    id: string;
    name: string;
    kind: string;
    sourceType: string;
    status: string;
    projectId: string | null;
    flyMachineId: string | null;
    flyVolumeId: string | null;
  };
  activeLifecycleOperationIds: string[];
  otherBoundThreadIds: string[];
  controlWorker: {
    app: string;
    repository: string;
    selected: ProviderMachine;
    machines: ProviderMachine[];
  };
  baseline: {
    environment: EnvironmentInventory;
    sourceVolumeSnapshots: FlySnapshot[];
  };
  requestedTag: string;
};

export type BackupObservation = {
  backup: {
    id: string;
    status: string;
    objectKey: string | null;
    encryptionKeyId: string | null;
    checksumSha256: string | null;
    sizeBytes: number | null;
    manifest: Record<string, unknown> | null;
  };
  operation: {
    id: string;
    status: string;
    stage: string;
    attempt: number;
  };
  jobs: Array<{
    id: string;
    state: string;
    retryCount: number;
    retryLimit: number;
  }>;
  activeWorkspaceOperationIds: string[];
};

export type ArchiveVerification = {
  objectKey: string;
  encryptionKeyId: string;
  backupFormat: "KWB2";
  header: "KWB2";
  decryptedSha256: string;
  checksumMatches: true;
};

export type CanaryEvidence = {
  ok: boolean;
  outcome: "passed" | "failed" | "inconclusive";
  startedAt: string;
  finishedAt: string;
  target: CanaryTarget;
  backup?: {
    id: string;
    operationId: string;
    first?: BackupObservation;
    final?: BackupObservation;
  };
  snapshots?: { baseline: FlySnapshot[]; final?: FlySnapshot[] };
  archive?: ArchiveVerification;
  cleanup?: {
    retirementOperationId: string;
    workspaceDeleted: boolean;
    sourceMachineDeleted: boolean;
    sourceVolumeDeleted: boolean;
    backupRecordPreserved: boolean;
    archivePreserved: boolean;
  };
  workerAfter?: ProviderMachine;
  diagnostics?: {
    environment?: EnvironmentInventory;
    archiveObjectExists?: boolean;
  };
  error?: { name: string; message: string; code?: string };
};

export type CanaryDependencies = {
  now(): Date;
  preflight(args: WorkspaceBackupRetryCanaryArgs): Promise<CanaryTarget>;
  revalidate(
    args: WorkspaceBackupRetryCanaryArgs,
    target: CanaryTarget,
  ): Promise<CanaryTarget>;
  printTarget(target: CanaryTarget): void;
  confirm(expected: string): Promise<void>;
  queueBackup(target: CanaryTarget): Promise<{
    backupId: string;
    operationId: string;
  }>;
  waitForFirstSnapshot(input: {
    backupId: string;
    operationId: string;
    deadlineMs: number;
  }): Promise<BackupObservation>;
  observeEnvironment(target: CanaryTarget): Promise<EnvironmentInventory>;
  listSnapshots(target: CanaryTarget): Promise<FlySnapshot[]>;
  stopWorker(target: CanaryTarget): Promise<void>;
  startWorker(target: CanaryTarget): Promise<void>;
  waitForWorker(target: CanaryTarget): Promise<ProviderMachine>;
  waitForCompletion(input: {
    backupId: string;
    operationId: string;
    deadlineMs: number;
  }): Promise<BackupObservation>;
  verifyArchive(observation: BackupObservation): Promise<ArchiveVerification>;
  retireWorkspace(
    target: CanaryTarget,
    backup: BackupObservation,
  ): Promise<{
    retirementOperationId: string;
    workspaceDeleted: boolean;
    sourceMachineDeleted: boolean;
    sourceVolumeDeleted: boolean;
    backupRecordPreserved: boolean;
    archivePreserved: boolean;
  }>;
  writeEvidence(evidence: CanaryEvidence): Promise<void>;
  captureFailureEvidence?(input: {
    target: CanaryTarget;
    backupId?: string;
    operationId?: string;
  }): Promise<{
    observation?: BackupObservation;
    snapshots?: FlySnapshot[];
    worker?: ProviderMachine;
    environment?: EnvironmentInventory;
    archiveObjectExists?: boolean;
  }>;
};

export class CanaryInconclusiveError extends Error {
  readonly code = "WORKSPACE_BACKUP_RETRY_CANARY_INCONCLUSIVE";

  constructor(message: string) {
    super(message);
    this.name = "CanaryInconclusiveError";
  }
}

export function parseWorkspaceBackupRetryCanaryArgs(
  rawArgs: string[],
): WorkspaceBackupRetryCanaryArgs {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  rejectUnknownArguments(args, [
    "--thread",
    "--control-worker-machine",
    "--tag",
  ]);
  const threadId = requiredArgument(args, "--thread");
  const controlWorkerMachineId = requiredArgument(
    args,
    "--control-worker-machine",
  );
  if (!/^[0-9a-f]+$/u.test(controlWorkerMachineId)) {
    throw new Error(
      "--control-worker-machine must be an exact Fly Machine ID.",
    );
  }
  return {
    threadId,
    controlWorkerMachineId,
    tag: productionTag(requiredArgument(args, "--tag")),
  };
}

export function exactCanaryConfirmation(target: CanaryTarget) {
  return [
    target.thread.id,
    target.workspace.id,
    target.controlWorker.selected.id,
    target.requestedTag,
  ].join(" ");
}

export function assertCanaryTargetUnchanged(
  expected: CanaryTarget,
  observed: CanaryTarget,
) {
  assert(
    stableJson(observed) === stableJson(expected),
    "The canary target changed after preflight; rerun the command with a fresh record.",
  );
}

export function assertCanaryPreflight(target: CanaryTarget) {
  const { thread, actor, binding, environment, workspace, controlWorker } =
    target;
  assert(thread.projectId === null, "The canary Thread must have no Project.");
  assert(
    Boolean(thread.createdByUserId) && actor.id === thread.createdByUserId,
    "The canary actor must be the Thread creator.",
  );
  assert(
    actor.organizationRole === "owner" || actor.organizationRole === "admin",
    "The canary Thread creator must be an organization administrator.",
  );
  assert(
    binding.threadId === thread.id &&
      binding.organizationId === thread.organizationId,
    "The active execution binding does not belong to the canary Thread.",
  );
  assert(
    environment.id === binding.environmentId &&
      workspace.id === binding.workspaceId,
    "The binding does not resolve the selected Environment and Workspace.",
  );
  assert(
    environment.provider === "fly" &&
      environment.status === "ready" &&
      Boolean(environment.flyAppName),
    "The canary requires a ready Fly Environment.",
  );
  assert(
    workspace.projectId === null && workspace.kind === "scratch",
    "The canary requires a scratch Workspace with no Project.",
  );
  assert(
    workspace.sourceType !== "desktop",
    "Desktop Workspaces cannot be used for this canary.",
  );
  assert(
    workspace.status === "ready" &&
      Boolean(workspace.flyMachineId) &&
      Boolean(workspace.flyVolumeId),
    "The canary Workspace must be ready with a source Machine and volume.",
  );
  assert(
    target.activeLifecycleOperationIds.length === 0,
    "The canary Workspace has a queued or running lifecycle operation.",
  );
  assert(
    target.otherBoundThreadIds.length === 0,
    "The scratch Workspace is also bound to another Thread and cannot be safely retired.",
  );
  const started = controlWorker.machines.filter(
    (machine) => machine.state === "started",
  );
  assert(
    started.length === 1 && started[0]?.id === controlWorker.selected.id,
    "The selected Machine must be the only started control-worker Machine.",
  );
  assert(
    controlWorker.selected.imageTag === target.requestedTag,
    "The selected control-worker Machine is not running the requested tag.",
  );
  assert(
    controlWorker.selected.imageRepository === controlWorker.repository,
    "The selected Machine image does not match the control-worker catalog target.",
  );
  assert(
    Boolean(controlWorker.selected.imageDigest),
    "The selected control-worker Machine has no resolved image digest.",
  );
  assert(
    controlWorker.selected.workerCheckStatus === "passing" &&
      controlWorker.selected.workerBuildId === target.requestedTag,
    "The selected control-worker health response does not match the candidate tag.",
  );
  const sourceMachine = target.baseline.environment.machines.find(
    (machine) => machine.id === workspace.flyMachineId,
  );
  const sourceVolume = target.baseline.environment.volumes.find(
    (volume) => volume.id === workspace.flyVolumeId,
  );
  assert(
    sourceMachine?.state === "started" &&
      sourceMachine.workspaceId === workspace.id &&
      sourceMachine.mountedVolumeIds.includes(workspace.flyVolumeId!) &&
      sourceMachine.healthStatus === "passing",
    "The Fly source Machine does not match the ready Workspace record.",
  );
  assert(
    sourceVolume?.attachedMachineId === workspace.flyMachineId,
    "The Fly source volume is not attached to the Workspace source Machine.",
  );
}

export function snapshotEvidence(
  observation: BackupObservation,
): SnapshotEvidence {
  const manifest = observation.backup.manifest ?? {};
  return {
    flySnapshotId: requiredManifestString(manifest, "flySnapshotId"),
    flySnapshotSourceVolumeId: requiredManifestString(
      manifest,
      "flySnapshotSourceVolumeId",
    ),
    flySnapshotState: requiredManifestString(manifest, "flySnapshotState"),
    flySnapshotRequestedAt: requiredManifestDate(
      manifest,
      "flySnapshotRequestedAt",
    ),
    flySnapshotLastObservedAt: requiredManifestDate(
      manifest,
      "flySnapshotLastObservedAt",
    ),
  };
}

export function newSnapshots(baseline: FlySnapshot[], observed: FlySnapshot[]) {
  const existing = new Set(baseline.map((snapshot) => snapshot.id));
  return observed.filter((snapshot) => !existing.has(snapshot.id));
}

export function assertFirstAttempt(input: {
  target: CanaryTarget;
  observation: BackupObservation;
  snapshots: FlySnapshot[];
  environment: EnvironmentInventory;
}) {
  const evidence = snapshotEvidence(input.observation);
  assert(
    input.observation.operation.attempt === 1 &&
      input.observation.operation.status === "running" &&
      input.observation.backup.status === "creating",
    "The first worker is not actively waiting in operation attempt 1.",
  );
  assert(
    input.observation.activeWorkspaceOperationIds.length === 1 &&
      input.observation.activeWorkspaceOperationIds[0] ===
        input.observation.operation.id,
    "Another Workspace lifecycle operation is concurrent with the first canary attempt.",
  );
  assert(
    input.observation.jobs.some(
      (job) => job.state === "active" && job.retryCount === 0,
    ),
    "pg-boss does not show an active first delivery for the canary operation.",
  );
  assert(
    evidence.flySnapshotSourceVolumeId === input.target.workspace.flyVolumeId,
    "The persisted snapshot names the wrong source volume.",
  );
  assert(
    Date.parse(evidence.flySnapshotLastObservedAt) >=
      Date.parse(evidence.flySnapshotRequestedAt),
    "The first snapshot observation timestamp is earlier than requestedAt.",
  );
  if (evidence.flySnapshotState === "created") {
    throw new CanaryInconclusiveError(
      "The first snapshot was already created before the worker could be interrupted.",
    );
  }
  const created = newSnapshots(
    input.target.baseline.sourceVolumeSnapshots,
    input.snapshots,
  );
  assert(
    created.length === 1,
    `The source volume gained ${created.length} snapshots before interruption; expected exactly one.`,
  );
  assert(
    created[0]?.id === evidence.flySnapshotId,
    "The new Fly snapshot does not match the persisted manifest ID.",
  );
  assertNoTemporaryResources(input.target, input.environment);
  return evidence;
}

export function assertFinalAttempt(input: {
  target: CanaryTarget;
  first: BackupObservation;
  final: BackupObservation;
  snapshots: FlySnapshot[];
  environment: EnvironmentInventory;
  worker: ProviderMachine;
}) {
  const firstEvidence = snapshotEvidence(input.first);
  const finalEvidence = snapshotEvidence(input.final);
  const created = newSnapshots(
    input.target.baseline.sourceVolumeSnapshots,
    input.snapshots,
  );
  assert(created.length === 1, "The retry must not create a second snapshot.");
  assert(
    created[0]?.id === firstEvidence.flySnapshotId &&
      finalEvidence.flySnapshotId === firstEvidence.flySnapshotId,
    "The retry did not preserve the original persisted snapshot ID.",
  );
  assert(
    finalEvidence.flySnapshotSourceVolumeId ===
      firstEvidence.flySnapshotSourceVolumeId &&
      finalEvidence.flySnapshotSourceVolumeId ===
        input.target.workspace.flyVolumeId,
    "The retry changed the persisted snapshot source volume.",
  );
  assert(
    finalEvidence.flySnapshotRequestedAt ===
      firstEvidence.flySnapshotRequestedAt,
    "The retry changed the snapshot requested timestamp.",
  );
  assert(
    Date.parse(finalEvidence.flySnapshotLastObservedAt) >=
      Date.parse(finalEvidence.flySnapshotRequestedAt) &&
      Date.parse(finalEvidence.flySnapshotLastObservedAt) >=
        Date.parse(firstEvidence.flySnapshotLastObservedAt),
    "The final snapshot observation timestamp is invalid or moved backward.",
  );
  assert(
    finalEvidence.flySnapshotState === "created",
    "The final observed snapshot state is not created.",
  );
  assert(
    input.final.operation.attempt === 2,
    "The Environment operation did not reach attempt 2.",
  );
  assert(
    input.final.activeWorkspaceOperationIds.length === 0,
    "Another Workspace lifecycle operation started before final canary verification.",
  );
  assert(
    input.final.jobs.some((job) => job.retryCount >= 1),
    "pg-boss did not record a retry for the backup operation.",
  );
  assert(
    input.final.backup.status === "available" &&
      input.final.operation.status === "completed" &&
      input.final.operation.stage === "workspace.backup.available",
    "The backup and Environment operation did not reach their successful terminal states.",
  );
  const manifest = input.final.backup.manifest ?? {};
  for (const [key, value] of Object.entries(
    input.first.backup.manifest ?? {},
  )) {
    if (key === "flySnapshotState" || key === "flySnapshotLastObservedAt") {
      continue;
    }
    assert(
      stableJson(manifest[key]) === stableJson(value),
      `The final manifest overwrote first-attempt evidence at ${key}.`,
    );
  }
  assert(
    manifest.backupFormat === "KWB2" &&
      Boolean(input.final.backup.objectKey) &&
      Boolean(input.final.backup.encryptionKeyId) &&
      Boolean(input.final.backup.sizeBytes) &&
      Boolean(input.final.backup.checksumSha256),
    "The available backup is missing its KWB2 archive evidence.",
  );
  assertNoTemporaryResources(input.target, input.environment);
  assertSourceWorkspaceUnchanged(input.target, input.environment);
  assertHealthyCandidateWorker(input.target, input.worker);
  return finalEvidence;
}

export function assertNoTemporaryResources(
  target: CanaryTarget,
  observed: EnvironmentInventory,
) {
  const baselineMachineIds = new Set(
    target.baseline.environment.machines.map((machine) => machine.id),
  );
  const baselineVolumeIds = new Set(
    target.baseline.environment.volumes.map((volume) => volume.id),
  );
  const newMachineIds = observed.machines
    .map((machine) => machine.id)
    .filter((id) => !baselineMachineIds.has(id));
  const newVolumeIds = observed.volumes
    .map((volume) => volume.id)
    .filter((id) => !baselineVolumeIds.has(id));
  assert(
    newMachineIds.length === 0 && newVolumeIds.length === 0,
    `Temporary export resources remain (machines: ${newMachineIds.join(", ") || "none"}; volumes: ${newVolumeIds.join(", ") || "none"}).`,
  );
}

export function assertSourceWorkspaceUnchanged(
  target: CanaryTarget,
  observed: EnvironmentInventory,
) {
  const machine = observed.machines.find(
    (candidate) => candidate.id === target.workspace.flyMachineId,
  );
  const volume = observed.volumes.find(
    (candidate) => candidate.id === target.workspace.flyVolumeId,
  );
  assert(
    machine?.state === "started" &&
      machine.workspaceId === target.workspace.id &&
      machine.mountedVolumeIds.includes(target.workspace.flyVolumeId!) &&
      machine.healthStatus === "passing" &&
      machine.image ===
        target.baseline.environment.machines.find(
          (candidate) => candidate.id === target.workspace.flyMachineId,
        )?.image &&
      machine.resolvedImageDigest ===
        target.baseline.environment.machines.find(
          (candidate) => candidate.id === target.workspace.flyMachineId,
        )?.resolvedImageDigest,
    "The source Workspace Machine changed during the canary.",
  );
  assert(
    volume?.attachedMachineId === target.workspace.flyMachineId,
    "The source Workspace volume changed during the canary.",
  );
}

export function assertHealthyCandidateWorker(
  target: CanaryTarget,
  worker: ProviderMachine,
) {
  assert(
    worker.id === target.controlWorker.selected.id &&
      worker.state === "started" &&
      worker.imageTag === target.requestedTag &&
      worker.imageRepository === target.controlWorker.repository &&
      worker.imageDigest === target.controlWorker.selected.imageDigest &&
      worker.workerCheckStatus === "passing" &&
      worker.workerBuildId === target.requestedTag,
    "The control-worker Machine is not healthy on the original candidate image.",
  );
}

export async function verifyKwb2Archive(input: {
  encrypted: NodeJS.ReadableStream;
  encryptionKey: Buffer;
  objectKey: string;
  encryptionKeyId: string;
  expectedChecksumSha256: string;
}) {
  if (input.encryptionKey.length !== 32) {
    throw new Error("The Workspace backup encryption key must be 32 bytes.");
  }
  let header = Buffer.alloc(0);
  const encrypted = Readable.from(input.encrypted).map((chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (header.length < 4) {
      header = Buffer.concat([header, bytes]).subarray(0, 4);
    }
    return bytes;
  });
  const hash = createHash("sha256");
  await pipeline(
    encrypted,
    createWorkspaceBackupDecryptionStream(input.encryptionKey),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
  );
  const decryptedSha256 = hash.digest("hex");
  assert(header.toString("utf8") === "KWB2", "The stored object is not KWB2.");
  assert(
    decryptedSha256 === input.expectedChecksumSha256,
    "The decrypted archive checksum does not match workspace_backups.",
  );
  return {
    objectKey: input.objectKey,
    encryptionKeyId: input.encryptionKeyId,
    backupFormat: "KWB2" as const,
    header: "KWB2" as const,
    decryptedSha256,
    checksumMatches: true as const,
  };
}

export function sanitizeCanaryEvidence(
  value: unknown,
  secretValues: string[] = [],
): unknown {
  if (typeof value === "string") {
    return secretValues.reduce(
      (result, secret) =>
        secret ? result.replaceAll(secret, "[REDACTED]") : result,
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeCanaryEvidence(entry, secretValues));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /authorization|cookie|password|secret|token|accessKey/iu.test(key)
        ? "[REDACTED]"
        : sanitizeCanaryEvidence(entry, secretValues),
    ]),
  );
}

export async function runWorkspaceBackupRetryCanary(input: {
  args: WorkspaceBackupRetryCanaryArgs;
  dependencies: CanaryDependencies;
}) {
  const { args, dependencies } = input;
  const startedAt = dependencies.now().toISOString();
  const target = await dependencies.preflight(args);
  assertCanaryPreflight(target);
  dependencies.printTarget(target);
  await dependencies.confirm(exactCanaryConfirmation(target));
  const revalidated = await dependencies.revalidate(args, target);
  assertCanaryPreflight(revalidated);
  assertCanaryTargetUnchanged(target, revalidated);

  let evidence: CanaryEvidence = {
    ok: false,
    outcome: "failed",
    startedAt,
    finishedAt: startedAt,
    target,
    snapshots: { baseline: target.baseline.sourceVolumeSnapshots },
  };
  let workerStopRequested = false;
  try {
    const queued = await dependencies.queueBackup(target);
    evidence.backup = {
      id: queued.backupId,
      operationId: queued.operationId,
    };
    const first = await dependencies.waitForFirstSnapshot({
      ...queued,
      deadlineMs: WORKSPACE_BACKUP_RETRY_DEADLINE_MS,
    });
    evidence.backup.first = first;
    const [firstSnapshots, firstInventory] = await Promise.all([
      dependencies.listSnapshots(target),
      dependencies.observeEnvironment(target),
    ]);
    evidence.snapshots!.final = firstSnapshots;
    assertFirstAttempt({
      target,
      observation: first,
      snapshots: firstSnapshots,
      environment: firstInventory,
    });

    workerStopRequested = true;
    await dependencies.stopWorker(target);
    await dependencies.startWorker(target);
    await dependencies.waitForWorker(target);

    const final = await dependencies.waitForCompletion({
      ...queued,
      deadlineMs: WORKSPACE_BACKUP_RETRY_DEADLINE_MS,
    });
    evidence.backup.final = final;
    const [finalSnapshots, finalInventory, workerAfter] = await Promise.all([
      dependencies.listSnapshots(target),
      dependencies.observeEnvironment(target),
      dependencies.waitForWorker(target),
    ]);
    evidence.snapshots!.final = finalSnapshots;
    evidence.workerAfter = workerAfter;
    assertFinalAttempt({
      target,
      first,
      final,
      snapshots: finalSnapshots,
      environment: finalInventory,
      worker: workerAfter,
    });
    evidence.archive = await dependencies.verifyArchive(final);
    evidence.cleanup = await dependencies.retireWorkspace(target, final);
    assert(
      evidence.cleanup.workspaceDeleted &&
        evidence.cleanup.sourceMachineDeleted &&
        evidence.cleanup.sourceVolumeDeleted &&
        evidence.cleanup.backupRecordPreserved &&
        evidence.cleanup.archivePreserved,
      "Workspace retirement cleanup or retained backup evidence is incomplete.",
    );
    evidence.workerAfter = await dependencies.waitForWorker(target);
    assertHealthyCandidateWorker(target, evidence.workerAfter);
    evidence.ok = true;
    evidence.outcome = "passed";
    evidence.finishedAt = dependencies.now().toISOString();
    await dependencies.writeEvidence(evidence);
    return evidence;
  } catch (error) {
    evidence.outcome =
      error instanceof CanaryInconclusiveError ? "inconclusive" : "failed";
    evidence.finishedAt = dependencies.now().toISOString();
    evidence.error = errorRecord(error);
    if (workerStopRequested) {
      await dependencies
        .startWorker(target)
        .then(() => dependencies.waitForWorker(target))
        .catch(() => undefined);
    }
    if (dependencies.captureFailureEvidence) {
      const captured = await dependencies
        .captureFailureEvidence({
          target,
          backupId: evidence.backup?.id,
          operationId: evidence.backup?.operationId,
        })
        .catch(() => null);
      if (captured?.observation && evidence.backup) {
        evidence.backup.final = captured.observation;
      }
      if (captured?.snapshots) evidence.snapshots!.final = captured.snapshots;
      if (captured?.worker) evidence.workerAfter = captured.worker;
      if (
        captured?.environment ||
        captured?.archiveObjectExists !== undefined
      ) {
        evidence.diagnostics = {
          ...(captured.environment
            ? { environment: captured.environment }
            : {}),
          ...(captured.archiveObjectExists !== undefined
            ? { archiveObjectExists: captured.archiveObjectExists }
            : {}),
        };
      }
    }
    await dependencies.writeEvidence(evidence).catch(() => undefined);
    throw error;
  } finally {
    if (workerStopRequested) {
      await dependencies.startWorker(target);
      await dependencies.waitForWorker(target);
    }
  }
}

function requiredManifestString(
  manifest: Record<string, unknown>,
  key: string,
) {
  const value = manifest[key];
  assert(
    typeof value === "string" && value.length > 0,
    `The backup manifest is missing ${key}.`,
  );
  return value;
}

function requiredManifestDate(manifest: Record<string, unknown>, key: string) {
  const value = requiredManifestString(manifest, key);
  assert(
    Number.isFinite(Date.parse(value)),
    `The backup manifest has invalid ${key}.`,
  );
  return value;
}

function errorRecord(error: unknown) {
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
  };
  return {
    name: typeof candidate?.name === "string" ? candidate.name : "Error",
    message:
      typeof candidate?.message === "string"
        ? candidate.message
        : "Workspace backup retry canary failed.",
    ...(typeof candidate?.code === "string" ? { code: candidate.code } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).sort().join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
