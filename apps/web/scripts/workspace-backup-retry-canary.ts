import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createFlyProviderClient } from "@/lib/environments/fly-connection";
import { requestWorkspaceRetirement } from "@/lib/environments/store";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getStorageAdapter } from "@/lib/storage";
import {
  confirmExact,
  loadProductionEnvironment,
} from "./lib/production-command";
import {
  parseWorkspaceBackupRetryCanaryArgs,
  readProviderVolumeSnapshots,
  recoverWorkerAfterInterruption,
  runWorkspaceBackupRetryCanary,
  sanitizeCanaryEvidence,
  snapshotEvidence,
  stopWorkerWithProviderVerification,
  verifyKwb2Archive,
  type BackupObservation,
  type CanaryEvidence,
  type CanaryTarget,
  type EnvironmentInventory,
  type ProviderMachine,
  type WorkspaceBackupRetryCanaryArgs,
} from "./lib/workspace-backup-retry-canary";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const CONTROL_WORKER_ROLE = "control-worker";
const POLL_INTERVAL_MS = 500;
const WORKER_HEALTH_DEADLINE_MS = 180_000;
const FLY_COMMAND_TIMEOUT_MS = 30_000;

export async function main() {
  const args = parseWorkspaceBackupRetryCanaryArgs(process.argv.slice(2));
  const vercelOperator = await loadProductionEnvironment();
  const flyOperator = await captureText("fly", ["auth", "whoami"]);
  const operator = `vercel:${vercelOperator};fly:${flyOperator}`;
  const evidence = await runWorkspaceBackupRetryCanary({
    args,
    dependencies: productionDependencies(operator),
  });
  process.stdout.write(
    `${JSON.stringify({ ok: true, outcome: evidence.outcome })}\n`,
  );
}

function productionDependencies(operator: string) {
  return {
    now: () => new Date(),
    preflight: (args: WorkspaceBackupRetryCanaryArgs) =>
      resolveCanaryTarget(args, operator),
    revalidate: async (
      args: WorkspaceBackupRetryCanaryArgs,
      target: CanaryTarget,
    ) => {
      const observed = await resolveCanaryTarget(args, operator);
      process.stdout.write(
        `${JSON.stringify({
          revalidated: true,
          threadId: observed.thread.id,
          workspaceId: observed.workspace.id,
          controlWorkerMachineId: observed.controlWorker.selected.id,
          tag: observed.requestedTag,
          imageDigest: observed.controlWorker.selected.imageDigest,
          baselineSnapshotCount: observed.baseline.sourceVolumeSnapshots.length,
        })}\n`,
      );
      return observed;
    },
    printTarget(target: CanaryTarget) {
      process.stdout.write(
        `${JSON.stringify(
          {
            action: "workspace-backup-forced-retry-canary",
            target,
            confirmation: [
              target.thread.id,
              target.workspace.id,
              target.controlWorker.selected.id,
              target.requestedTag,
            ].join(" "),
          },
          null,
          2,
        )}\n`,
      );
    },
    confirm: confirmExact,
    async queueBackup(target: CanaryTarget) {
      const { queueWorkspaceBackup } =
        await import("@/lib/environments/backups");
      const queued = await queueWorkspaceBackup({
        organizationId: target.thread.organizationId,
        environmentId: target.environment.id,
        workspaceId: target.workspace.id,
        actorUserId: target.actor.id,
        reason: "checkpoint",
        idempotencyKey: `workspace.backup.retry-canary:${target.thread.id}:${Date.now()}`,
      });
      if (!("operationId" in queued)) {
        throw new Error("The canary backup did not create a queued operation.");
      }
      const operationId = queued.operationId;
      if (!operationId) {
        throw new Error("The queued canary backup has no operation ID.");
      }
      process.stdout.write(
        `${JSON.stringify({
          queued: { backupId: queued.backupId, operationId },
        })}\n`,
      );
      return { backupId: queued.backupId, operationId };
    },
    waitForFirstSnapshot(input: {
      backupId: string;
      operationId: string;
      deadlineMs: number;
    }) {
      return waitForBackupObservation(input, (observation) => {
        try {
          snapshotEvidence(observation);
          return true;
        } catch {
          return false;
        }
      });
    },
    observeEnvironment: readEnvironmentInventory,
    listSnapshots: readSourceVolumeSnapshots,
    stopWorker(target: CanaryTarget, onStopRequested: () => void) {
      return stopWorkerWithProviderVerification({
        target,
        onStopRequested,
        stop: (timeoutMs) =>
          runFly(
            [
              "machine",
              "stop",
              target.controlWorker.selected.id,
              "--app",
              target.controlWorker.app,
              "--signal",
              "SIGKILL",
              "--timeout",
              "1",
            ],
            timeoutMs,
          ),
        readMachines: (timeoutMs) =>
          readControlWorkerMachines(target.controlWorker.app, timeoutMs),
      });
    },
    startWorker(target: CanaryTarget, context: { postStopConfirmed: boolean }) {
      return recoverWorkerAfterInterruption({
        target,
        postStopConfirmed: context.postStopConfirmed,
        start: (timeoutMs) =>
          runFly(
            [
              "machine",
              "start",
              target.controlWorker.selected.id,
              "--app",
              target.controlWorker.app,
            ],
            timeoutMs,
          ),
        readMachines: (timeoutMs) =>
          readControlWorkerMachines(target.controlWorker.app, timeoutMs),
      }).then(() => undefined);
    },
    waitForWorker,
    waitForCompletion(input: {
      backupId: string;
      operationId: string;
      deadlineMs: number;
    }) {
      return waitForBackupObservation(
        input,
        (observation) =>
          observation.backup.status === "available" &&
          observation.operation.status === "completed",
      );
    },
    async verifyArchive(observation: BackupObservation) {
      const { objectKey, encryptionKeyId, checksumSha256, manifest } =
        observation.backup;
      if (
        !objectKey ||
        !encryptionKeyId ||
        !checksumSha256 ||
        manifest?.backupFormat !== "KWB2"
      ) {
        throw new Error("The completed backup is missing archive evidence.");
      }
      const key = workspaceBackupKey();
      if (
        encryptionKeyId !==
        requiredEnvironment("KESTREL_WORKSPACE_BACKUP_KEY_ID")
      ) {
        throw new Error(
          "The archive key ID does not match production configuration.",
        );
      }
      return verifyKwb2Archive({
        encrypted: await getStorageAdapter().getObjectStream(objectKey),
        encryptionKey: key,
        objectKey,
        encryptionKeyId,
        expectedChecksumSha256: checksumSha256,
      });
    },
    retireWorkspace,
    writeEvidence,
    async captureFailureEvidence(input: {
      target: CanaryTarget;
      backupId?: string;
      operationId?: string;
    }) {
      const [observation, snapshots, worker, environment] = await Promise.all([
        input.backupId && input.operationId
          ? readBackupObservation(input.backupId, input.operationId).catch(
              () => undefined,
            )
          : undefined,
        readSourceVolumeSnapshots(input.target).catch(() => undefined),
        readSelectedWorker(input.target).catch(() => undefined),
        readEnvironmentInventory(input.target).catch(() => undefined),
      ]);
      const archiveObjectExists = observation?.backup.objectKey
        ? await getStorageAdapter()
            .objectExists(observation.backup.objectKey)
            .catch(() => undefined)
        : undefined;
      return {
        observation,
        snapshots,
        worker,
        environment,
        archiveObjectExists,
      };
    },
  };
}

async function resolveCanaryTarget(
  args: WorkspaceBackupRetryCanaryArgs,
  operator: string,
): Promise<CanaryTarget> {
  const thread = await knowledgeDb.query.threads.findFirst({
    where: eq(schema.threads.id, args.threadId),
    columns: {
      id: true,
      projectId: true,
      organizationId: true,
      createdByUserId: true,
    },
  });
  if (!thread) throw new Error("The canary Thread was not found.");
  const binding = await knowledgeDb.query.threadExecutionBindings.findFirst({
    where: and(
      eq(schema.threadExecutionBindings.threadId, thread.id),
      eq(schema.threadExecutionBindings.organizationId, thread.organizationId),
    ),
  });
  if (!binding)
    throw new Error("The canary Thread has no active execution binding.");
  const [
    environment,
    workspace,
    actorMembership,
    activeOperations,
    workspaceBindings,
  ] = await Promise.all([
    knowledgeDb.query.environments.findFirst({
      where: and(
        eq(schema.environments.id, binding.environmentId),
        eq(schema.environments.organizationId, thread.organizationId),
      ),
    }),
    knowledgeDb.query.environmentWorkspaces.findFirst({
      where: and(
        eq(schema.environmentWorkspaces.id, binding.workspaceId),
        eq(schema.environmentWorkspaces.organizationId, thread.organizationId),
        eq(schema.environmentWorkspaces.environmentId, binding.environmentId),
      ),
    }),
    thread.createdByUserId
      ? knowledgeDb.query.members.findFirst({
          where: and(
            eq(schema.members.organizationId, thread.organizationId),
            eq(schema.members.userId, thread.createdByUserId),
          ),
          columns: { userId: true, role: true },
        })
      : null,
    knowledgeDb.query.environmentOperations.findMany({
      where: and(
        eq(schema.environmentOperations.workspaceId, binding.workspaceId),
        inArray(schema.environmentOperations.status, ["queued", "running"]),
      ),
      columns: { id: true },
    }),
    knowledgeDb.query.threadExecutionBindings.findMany({
      where: eq(
        schema.threadExecutionBindings.workspaceId,
        binding.workspaceId,
      ),
      columns: { threadId: true },
    }),
  ]);
  if (!(environment && workspace && actorMembership)) {
    throw new Error(
      "The Thread target did not resolve an Environment, Workspace, and organization actor.",
    );
  }
  const catalog = await readControlWorkerCatalog();
  const [provider, controlWorkerMachines] = await Promise.all([
    createFlyProviderClient(thread.organizationId),
    readControlWorkerMachines(catalog.app),
  ]);
  const [environmentInventory, sourceVolumeSnapshots] = await Promise.all([
    readProviderEnvironmentInventory({
      provider,
      appName: environment.flyAppName ?? "",
      sourceMachineId: workspace.flyMachineId ?? "",
    }),
    readProviderVolumeSnapshots({
      provider,
      appName: environment.flyAppName ?? "",
      volumeId: workspace.flyVolumeId ?? "",
    }),
  ]);
  const selected = controlWorkerMachines.find(
    (machine) => machine.id === args.controlWorkerMachineId,
  );
  if (!selected) {
    throw new Error(
      `Control-worker Machine ${args.controlWorkerMachineId} was not found.`,
    );
  }
  return {
    operator,
    thread,
    actor: {
      id: actorMembership.userId,
      organizationRole: actorMembership.role,
    },
    binding: {
      threadId: binding.threadId,
      organizationId: binding.organizationId,
      environmentId: binding.environmentId,
      workspaceId: binding.workspaceId,
    },
    environment: {
      id: environment.id,
      provider: environment.provider,
      status: environment.status,
      flyAppName: environment.flyAppName,
    },
    workspace: {
      id: workspace.id,
      name: workspace.name,
      kind: workspace.kind,
      sourceType: workspace.sourceType,
      status: workspace.status,
      projectId: workspace.projectId,
      flyMachineId: workspace.flyMachineId,
      flyVolumeId: workspace.flyVolumeId,
    },
    activeLifecycleOperationIds: activeOperations.map(
      (operation) => operation.id,
    ),
    otherBoundThreadIds: workspaceBindings
      .map((candidate) => candidate.threadId)
      .filter((threadId) => threadId !== thread.id),
    controlWorker: {
      app: catalog.app,
      repository: catalog.repository,
      selected,
      machines: controlWorkerMachines,
    },
    baseline: {
      environment: environmentInventory,
      sourceVolumeSnapshots,
    },
    requestedTag: args.tag,
  };
}

async function waitForBackupObservation(
  input: { backupId: string; operationId: string; deadlineMs: number },
  complete: (observation: BackupObservation) => boolean,
) {
  const deadline = Date.now() + input.deadlineMs;
  while (true) {
    const observation = await readBackupObservation(
      input.backupId,
      input.operationId,
    );
    if (complete(observation)) return observation;
    if (
      observation.backup.status === "failed" ||
      observation.operation.status === "failed" ||
      Date.now() >= deadline
    ) {
      throw Object.assign(
        new Error(
          Date.now() >= deadline
            ? "The backup canary observation deadline expired."
            : "The Workspace backup reached a failed terminal state.",
        ),
        { code: "WORKSPACE_BACKUP_RETRY_CANARY_OBSERVATION_FAILED" },
      );
    }
    await delay(POLL_INTERVAL_MS);
  }
}

async function readBackupObservation(
  backupId: string,
  operationId: string,
): Promise<BackupObservation> {
  const [backup, operation, jobs] = await Promise.all([
    knowledgeDb.query.workspaceBackups.findFirst({
      where: eq(schema.workspaceBackups.id, backupId),
    }),
    knowledgeDb.query.environmentOperations.findFirst({
      where: eq(schema.environmentOperations.id, operationId),
    }),
    knowledgeDb.execute(sql`
      SELECT id::text, state, retry_count AS "retryCount",
        retry_limit AS "retryLimit"
      FROM pgboss.job
      WHERE name = 'environment.operation.controller-v1'
        AND data->>'operationId' = ${operationId}
      ORDER BY created_on, id
    `),
  ]);
  if (!(backup && operation)) {
    throw new Error("The queued backup operation or record disappeared.");
  }
  const activeWorkspaceOperations =
    await knowledgeDb.query.environmentOperations.findMany({
      where: and(
        eq(schema.environmentOperations.workspaceId, backup.workspaceId),
        inArray(schema.environmentOperations.status, ["queued", "running"]),
      ),
      columns: { id: true },
    });
  return {
    backup: {
      id: backup.id,
      status: backup.status,
      objectKey: backup.objectKey,
      encryptionKeyId: backup.encryptionKeyId,
      checksumSha256: backup.checksumSha256,
      sizeBytes: backup.sizeBytes,
      manifest: backup.manifest,
    },
    operation: {
      id: operation.id,
      status: operation.status,
      stage: operation.stage,
      attempt: operation.attempt,
    },
    jobs: Array.from(jobs as unknown as Array<Record<string, unknown>>).map(
      (job) => ({
        id: String(job.id),
        state: String(job.state),
        retryCount: Number(job.retryCount),
        retryLimit: Number(job.retryLimit),
      }),
    ),
    activeWorkspaceOperationIds: activeWorkspaceOperations.map(
      (candidate) => candidate.id,
    ),
  };
}

async function readEnvironmentInventory(target: CanaryTarget) {
  const provider = await createFlyProviderClient(target.thread.organizationId);
  return readProviderEnvironmentInventory({
    provider,
    appName: target.environment.flyAppName ?? "",
    sourceMachineId: target.workspace.flyMachineId ?? "",
  });
}

async function readProviderEnvironmentInventory(input: {
  provider: Awaited<ReturnType<typeof createFlyProviderClient>>;
  appName: string;
  sourceMachineId: string;
}) {
  const [inventory, sourceMachine] = await Promise.all([
    input.provider.listEnvironmentResources({ appName: input.appName }),
    input.sourceMachineId
      ? input.provider.getMachine({
          appName: input.appName,
          machineId: input.sourceMachineId,
        })
      : null,
  ]);
  return normalizeInventory({
    machines: inventory.machines.map((machine) =>
      machine.id === sourceMachine?.id
        ? {
            ...machine,
            healthStatus:
              sourceMachine.checks?.find((check) => check.name === "workspace")
                ?.status ?? null,
            image: sourceMachine.image ?? null,
            resolvedImageDigest: sourceMachine.resolvedImageDigest ?? null,
          }
        : machine,
    ),
    volumes: inventory.volumes,
  });
}

function normalizeInventory(inventory: {
  machines: Array<{
    id: string;
    state?: string;
    region?: string;
    workspaceId: string | null;
    replacementId: string | null;
    mountedVolumeIds?: string[];
    healthStatus?: string | null;
    image?: string | null;
    resolvedImageDigest?: string | null;
  }>;
  volumes: Array<{
    id: string;
    name: string;
    region?: string;
    sizeGb?: number;
    attachedMachineId?: string | null;
  }>;
}): EnvironmentInventory {
  return {
    machines: inventory.machines.map((machine) => ({
      id: machine.id,
      state: machine.state ?? null,
      region: machine.region ?? null,
      workspaceId: machine.workspaceId,
      replacementId: machine.replacementId,
      mountedVolumeIds: machine.mountedVolumeIds ?? [],
      healthStatus: machine.healthStatus ?? null,
      image: machine.image ?? null,
      resolvedImageDigest: machine.resolvedImageDigest ?? null,
    })),
    volumes: inventory.volumes.map((volume) => ({
      id: volume.id,
      name: volume.name,
      region: volume.region ?? null,
      sizeGb: volume.sizeGb ?? null,
      attachedMachineId: volume.attachedMachineId ?? null,
    })),
  };
}

async function readSourceVolumeSnapshots(target: CanaryTarget) {
  const provider = await createFlyProviderClient(target.thread.organizationId);
  return readProviderVolumeSnapshots({
    provider,
    appName: target.environment.flyAppName ?? "",
    volumeId: target.workspace.flyVolumeId ?? "",
  });
}

async function readControlWorkerMachines(
  app: string,
  timeoutMs = FLY_COMMAND_TIMEOUT_MS,
) {
  const value = await captureJson(
    "fly",
    ["machine", "list", "--app", app, "--json"],
    timeoutMs,
  );
  if (!Array.isArray(value)) throw new Error("Fly returned invalid Machines.");
  return value.map(parseProviderMachine);
}

function parseProviderMachine(value: unknown): ProviderMachine {
  const machine = record(value);
  const image = record(machine?.image_ref);
  const checks = Array.isArray(machine?.checks) ? machine.checks : [];
  const workerCheck = checks
    .map(record)
    .find((check) => check?.name === "worker");
  let workerBuildId: string | null = null;
  try {
    workerBuildId = stringValue(
      record(JSON.parse(stringValue(workerCheck?.output) ?? "{}"))?.buildId,
    );
  } catch {
    workerBuildId = null;
  }
  const id = stringValue(machine?.id);
  const state = stringValue(machine?.state);
  if (!(id && state))
    throw new Error("Fly returned an invalid Machine record.");
  return {
    id,
    state,
    imageTag: stringValue(image?.tag),
    imageRepository:
      stringValue(image?.registry) && stringValue(image?.repository)
        ? `${stringValue(image?.registry)}/${stringValue(image?.repository)}`
        : null,
    imageDigest: stringValue(image?.digest),
    workerCheckStatus: stringValue(workerCheck?.status),
    workerBuildId,
  };
}

async function readSelectedWorker(target: CanaryTarget) {
  const machines = await readControlWorkerMachines(target.controlWorker.app);
  const selected = machines.find(
    (machine) => machine.id === target.controlWorker.selected.id,
  );
  if (!selected)
    throw new Error("The selected control-worker Machine disappeared.");
  return selected;
}

async function waitForWorker(target: CanaryTarget) {
  const deadline = Date.now() + WORKER_HEALTH_DEADLINE_MS;
  while (true) {
    const machines = await readControlWorkerMachines(target.controlWorker.app);
    const selected = machines.find(
      (machine) => machine.id === target.controlWorker.selected.id,
    );
    if (
      selected?.state === "started" &&
      selected.imageTag === target.requestedTag &&
      selected.imageDigest === target.controlWorker.selected.imageDigest &&
      selected.workerCheckStatus === "passing" &&
      selected.workerBuildId === target.requestedTag &&
      machines.filter((machine) => machine.state === "started").length === 1
    ) {
      return selected;
    }
    if (Date.now() >= deadline) {
      throw new Error("The candidate control-worker did not return healthy.");
    }
    await delay(1_000);
  }
}

async function retireWorkspace(
  target: CanaryTarget,
  backup: BackupObservation,
) {
  const { enqueueEnvironmentOperation } = await import("@/lib/knowledge/queue");
  const operation = await requestWorkspaceRetirement({
    organizationId: target.thread.organizationId,
    environmentId: target.environment.id,
    workspaceId: target.workspace.id,
    confirmationName: target.workspace.name,
    userId: target.actor.id,
  });
  await enqueueEnvironmentOperation(operation.id);
  const deadline = Date.now() + 15 * 60_000;
  while (true) {
    const current = await knowledgeDb.query.environmentOperations.findFirst({
      where: eq(schema.environmentOperations.id, operation.id),
    });
    if (
      current?.status === "completed" &&
      current.stage === "workspace.deleted"
    ) {
      break;
    }
    if (!current || current.status === "failed" || Date.now() >= deadline) {
      throw new Error("The scratch Workspace retirement did not complete.");
    }
    await delay(1_000);
  }
  const provider = await createFlyProviderClient(target.thread.organizationId);
  const inventory = await readProviderEnvironmentInventory({
    provider,
    appName: target.environment.flyAppName ?? "",
    sourceMachineId: target.workspace.flyMachineId ?? "",
  });
  const preservedBackup = await knowledgeDb.query.workspaceBackups.findFirst({
    where: eq(schema.workspaceBackups.id, backup.backup.id),
    columns: { id: true, objectKey: true },
  });
  const archivePreserved = preservedBackup?.objectKey
    ? await getStorageAdapter().objectExists(preservedBackup.objectKey)
    : false;
  return {
    retirementOperationId: operation.id,
    workspaceDeleted: true,
    sourceMachineDeleted: !inventory.machines.some(
      (machine) => machine.id === target.workspace.flyMachineId,
    ),
    sourceVolumeDeleted: !inventory.volumes.some(
      (volume) => volume.id === target.workspace.flyVolumeId,
    ),
    backupRecordPreserved: preservedBackup?.id === backup.backup.id,
    archivePreserved,
  };
}

async function writeEvidence(evidence: CanaryEvidence) {
  const directory = resolve(repositoryRoot, "test-results/canaries");
  await mkdir(directory, { recursive: true });
  const timestamp = evidence.startedAt.replace(/[:.]/gu, "-");
  const filename = `workspace-backup-retry-${timestamp}-${evidence.target.thread.id}.json`;
  const secrets = [
    process.env.FLY_API_TOKEN ?? "",
    process.env.DATABASE_URL ?? "",
    process.env.STORAGE_ACCESS_KEY_ID ?? "",
    process.env.STORAGE_SECRET_ACCESS_KEY ?? "",
    process.env.KESTREL_WORKSPACE_BACKUP_KEY ?? "",
  ];
  const sanitized = sanitizeCanaryEvidence(evidence, secrets);
  await writeFile(
    resolve(directory, filename),
    `${JSON.stringify(sanitized, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(
    `${JSON.stringify({ evidenceFile: `test-results/canaries/${filename}` })}\n`,
  );
}

async function readControlWorkerCatalog() {
  const catalog = JSON.parse(
    await readFile(
      resolve(repositoryRoot, "deploy/fly/image-catalog.json"),
      "utf8",
    ),
  ) as { images?: Array<Record<string, unknown>> };
  const entry = catalog.images?.find(
    (candidate) => candidate.role === CONTROL_WORKER_ROLE,
  );
  const app = stringValue(entry?.app);
  const repository = stringValue(entry?.repository);
  if (!(app && repository)) {
    throw new Error("The image catalog has no control-worker target.");
  }
  return { app, repository };
}

function workspaceBackupKey() {
  const key = Buffer.from(
    requiredEnvironment("KESTREL_WORKSPACE_BACKUP_KEY"),
    "base64",
  );
  if (key.length !== 32) {
    throw new Error(
      "KESTREL_WORKSPACE_BACKUP_KEY must be a base64-encoded 32-byte key.",
    );
  }
  return key;
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

async function captureJson(
  command: string,
  args: string[],
  timeoutMs = FLY_COMMAND_TIMEOUT_MS,
) {
  const value = await captureText(command, args, timeoutMs);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${command} returned invalid JSON.`);
  }
}

async function captureText(
  command: string,
  args: string[],
  timeoutMs = FLY_COMMAND_TIMEOUT_MS,
) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
    });
    const value = stdout.trim();
    if (!value) throw new Error(`${command} returned no output.`);
    return value;
  } catch (error) {
    throw new Error(`${command} ${args[0] ?? ""} failed.`, { cause: error });
  }
}

async function runFly(args: string[], timeoutMs = FLY_COMMAND_TIMEOUT_MS) {
  try {
    await execFileAsync("fly", args, {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
    });
  } catch (error) {
    throw new Error(`fly ${args[0] ?? ""} failed.`, { cause: error });
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Workspace backup retry canary failed."}\n`,
    );
    process.exitCode = 1;
  });
}
