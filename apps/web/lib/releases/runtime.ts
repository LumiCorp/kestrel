import { and, eq, inArray, sql } from "drizzle-orm";
import { FlyMachinesClient } from "@/lib/environments/providers/fly-machines";
import { EnvironmentProviderError } from "@/lib/environments/providers/contracts";
import type { EnvironmentProviderMachine } from "@/lib/environments/providers/contracts";
import { releaseRetryNextAttemptAt } from "@/lib/environments/provisioner";
import { environmentLifecycleLockKey } from "@/lib/environments/lifecycle-lock";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";
import {
  classifyFlyImageReleaseEnvironment,
  isFlyImageReleaseMachineVerified,
  type FlyImageRole,
} from "./contracts";
import {
  completeFlyImageReleaseIfReady,
  getFlyImageReleaseExecutionAdmission,
} from "./store";
import { PROCESS_CONFIGURATION_CONTRACT_REVISION } from "@/lib/runtime/process-contracts";

const RELEASE_DRAIN_TIMEOUT_MS = 30 * 60 * 1000;
const TURN_WORKER_READINESS_TIMEOUT_MS = 120_000;
const GLOBAL_APP_BY_ROLE = {
  "preview-edge": "kestrel-preview-edge",
  "turn-worker": "kestrel-one-turn-worker",
  "runpod-worker": "kestrel-one-runpod-worker",
} as const;

export async function processFlyImageRelease(
  releaseId: string,
): Promise<"completed" | "deferred" | "not_claimed"> {
  const release = await knowledgeDb.query.flyImageReleases.findFirst({
    where: eq(schema.flyImageReleases.id, releaseId),
  });
  if (!(release && ["approved", "deploying"].includes(release.status))) {
    return "not_claimed";
  }
  const settings = await knowledgeDb.query.flyImageReleaseSettings.findFirst({
    where: eq(schema.flyImageReleaseSettings.id, "platform"),
  });
  if (settings?.activeReleaseId !== release.id) return "not_claimed";
  const admission = await getFlyImageReleaseExecutionAdmission(release.id);
  if (!admission.ok) {
    await pauseRelease(release.id, admission.code, admission.message);
    return "not_claimed";
  }
  if (release.status === "approved") {
    await knowledgeDb
      .update(schema.flyImageReleases)
      .set({
        status: "deploying",
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.flyImageReleases.id, release.id),
          eq(schema.flyImageReleases.status, "approved"),
        ),
      );
  }

  const targets = await knowledgeDb
    .select()
    .from(schema.flyImageReleaseTargets)
    .where(eq(schema.flyImageReleaseTargets.releaseId, release.id));
  const target = orderFlyImageReleaseTargets(
    targets,
    settings.canaryEnvironmentId,
  ).find(
    (candidate) =>
      !["completed", "configured_unverified"].includes(candidate.status),
  );
  if (!target) {
    return (await completeFlyImageReleaseIfReady(release.id))
      ? "completed"
      : "deferred";
  }
  if (target.status === "failed") {
    await pauseRelease(
      release.id,
      target.failureCode ?? "RELEASE_TARGET_FAILED",
      target.failureMessage ?? "A release target failed.",
    );
    return "not_claimed";
  }
  const nextAttemptAt = readResultString(target.result, "nextAttemptAt");
  if (nextAttemptAt && Date.parse(nextAttemptAt) > Date.now())
    return "deferred";

  if (target.targetKind === "environment" && !target.environmentId) {
    await knowledgeDb
      .update(schema.flyImageReleaseTargets)
      .set({
        status: "completed",
        stage: "environment.removed_before_deploy",
        result: {
          ...(target.result ?? {}),
          skippedReason: "environment_removed",
        },
        failureCode: null,
        failureMessage: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.flyImageReleaseTargets.id, target.id));
    return "deferred";
  }

  try {
    if (target.targetKind === "global_app" && target.componentRole) {
      await applyGlobalAppTarget(target);
      return "deferred";
    }
    if (target.targetKind === "environment" && target.environmentId) {
      return await applyEnvironmentTarget({
        release,
        target,
        isCanary: target.environmentId === settings.canaryEnvironmentId,
      });
    }
    throw new Error("Fly image release target is malformed.");
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown release target failure.";
    const retryable = isRetryableReleaseProviderFailure(error);
    const firstFailureAt =
      readResultString(target.result, "firstFailureAt") ??
      new Date().toISOString();
    const retryAttempt =
      (readResultNumber(target.result, "retryAttempt") ?? 0) + 1;
    const nextAttemptAt = releaseRetryNextAttemptAt(
      firstFailureAt,
      retryAttempt,
    );
    if (retryable && nextAttemptAt) {
      await knowledgeDb
        .update(schema.flyImageReleaseTargets)
        .set({
          status: "applying",
          stage: "environment.provider.retrying",
          failureCode: null,
          failureMessage: null,
          result: {
            ...(target.result ?? {}),
            retryAttempt,
            firstFailureAt,
            nextAttemptAt,
            lastProviderResponse: {
              code:
                error instanceof EnvironmentProviderError
                  ? error.code
                  : "FLY_PROVIDER_UNAVAILABLE",
              status:
                error instanceof EnvironmentProviderError
                  ? error.status
                  : undefined,
              message,
            },
            authoritativeState:
              error &&
              typeof error === "object" &&
              "authoritativeState" in error
                ? error.authoritativeState
                : undefined,
          },
          updatedAt: new Date(),
        })
        .where(eq(schema.flyImageReleaseTargets.id, target.id));
      return "deferred";
    }
    const failureCode =
      error instanceof TurnWorkerReadinessTimeoutError
        ? "TURN_WORKER_READINESS_TIMEOUT"
        : retryable
          ? "RELEASE_RETRY_BUDGET_EXHAUSTED"
          : "RELEASE_TARGET_FAILED";
    await knowledgeDb
      .update(schema.flyImageReleaseTargets)
      .set({
        status: "failed",
        failureCode,
        failureMessage: message,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.flyImageReleaseTargets.id, target.id));
    await pauseRelease(release.id, failureCode, message);
    return "not_claimed";
  }
}

export async function nextFlyImageReleaseDelaySeconds(releaseId: string) {
  const targets = await knowledgeDb.query.flyImageReleaseTargets.findMany({
    where: (table, { eq }) => eq(table.releaseId, releaseId),
    columns: { status: true, result: true },
  });
  const future = targets
    .filter((target) => target.status === "applying")
    .map((target) => readResultString(target.result, "nextAttemptAt"))
    .flatMap((value) => (value ? [Date.parse(value)] : []))
    .filter((value) => Number.isFinite(value) && value > Date.now());
  if (!future.length) return 15;
  return Math.max(1, Math.ceil((Math.min(...future) - Date.now()) / 1000));
}

function isRetryableReleaseProviderFailure(error: unknown) {
  if (!(error instanceof EnvironmentProviderError)) return false;
  if (
    error.code === "FLY_PROVIDER_UNAVAILABLE" ||
    error.status === 408 ||
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return true;
  }
  return (
    [409, 412].includes(error.status ?? 0) && "authoritativeState" in error
  );
}

async function applyGlobalAppTarget(
  target: typeof schema.flyImageReleaseTargets.$inferSelect,
) {
  const role = target.componentRole;
  if (!(role && role in GLOBAL_APP_BY_ROLE && target.desiredImage)) {
    throw new Error("Global Fly image release target is incomplete.");
  }
  const appName = GLOBAL_APP_BY_ROLE[role as keyof typeof GLOBAL_APP_BY_ROLE];
  const client = createPlatformFlyClient();
  const before = await client.listAppMachines({ appName });
  if (!before.length) throw new Error(`Fly App '${appName}' has no Machines.`);
  validateGlobalAppMachineTopology(before);
  const release = await knowledgeDb.query.flyImageReleases.findFirst({
    where: eq(schema.flyImageReleases.id, target.releaseId),
    columns: { bundleRevision: true },
  });
  if (!release) throw new Error("Global Fly image release disappeared.");
  const updateStartedAt = new Date();
  await knowledgeDb
    .update(schema.flyImageReleaseTargets)
    .set({
      status: "applying",
      stage: "global_app.updating",
      priorImage: before[0]?.image ?? null,
      startedAt: target.startedAt ?? updateStartedAt,
      result: buildGlobalAppApplyingResult(target.result, before),
      updatedAt: new Date(),
    })
    .where(eq(schema.flyImageReleaseTargets.id, target.id));
  await updateGlobalAppMachines({
    appName,
    client,
    desiredImage: target.desiredImage,
    machines: before,
    role,
    sourceRevision: release.bundleRevision,
    waitForWorkerReadiness,
  });
  if (role === "turn-worker") {
    const component =
      await knowledgeDb.query.flyImageReleaseComponents.findFirst({
        where: and(
          eq(schema.flyImageReleaseComponents.releaseId, target.releaseId),
          eq(schema.flyImageReleaseComponents.role, "turn-worker"),
        ),
      });
    if (
      !(component?.sourceRevision && component.configurationContractFingerprint)
    ) {
      throw new Error("Turn-worker release readiness contract is incomplete.");
    }
    await knowledgeDb
      .update(schema.flyImageReleaseTargets)
      .set({
        status: "verifying",
        stage: "global_app.awaiting_worker_heartbeat",
        updatedAt: new Date(),
      })
      .where(eq(schema.flyImageReleaseTargets.id, target.id));
    await waitForTurnWorkerHeartbeat({
      machineIds: before.map((machine) => machine.id),
      sourceRevision: component.sourceRevision,
      configurationFingerprint: component.configurationContractFingerprint,
      notBefore: updateStartedAt,
      timeoutMs: TURN_WORKER_READINESS_TIMEOUT_MS,
    });
  }
  await knowledgeDb
    .update(schema.flyImageReleaseTargets)
    .set({
      status: "completed",
      stage: "global_app.verified",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.flyImageReleaseTargets.id, target.id));
}

type GlobalAppMachineClient = Pick<
  FlyMachinesClient,
  | "getMachine"
  | "updateMachineImage"
  | "waitForMachine"
  | "waitForMachineHealth"
>;

export function buildGlobalAppApplyingResult(
  existing: Record<string, unknown> | null,
  machines: EnvironmentProviderMachine[],
) {
  return {
    ...(existing ?? {}),
    machineIds: machines.map((machine) => machine.id),
  };
}

export function validateGlobalAppMachineTopology(
  machines: EnvironmentProviderMachine[],
) {
  const byId = new Map(
    machines.map((machine) => [machine.id, machine] as const),
  );
  if (byId.size !== machines.length) {
    throw new Error("Fly App Machine inventory contains duplicate identities.");
  }
  const referencedBy = new Map<string, EnvironmentProviderMachine[]>();
  for (const machine of machines) {
    if (!Array.isArray(machine.standbyForMachineIds)) {
      throw new Error(
        `Fly Machine '${machine.id}' is missing standby relationship metadata.`,
      );
    }
    if (machine.standbyForMachineIds.length > 1) {
      throw new Error(
        `Fly Machine '${machine.id}' has an ambiguous standby relationship.`,
      );
    }
    const primaryId = machine.standbyForMachineIds[0];
    if (!primaryId) continue;
    if (primaryId === machine.id || !byId.has(primaryId)) {
      throw new Error(
        `Fly Machine '${machine.id}' has a malformed standby relationship.`,
      );
    }
    const standbys = referencedBy.get(primaryId) ?? [];
    standbys.push(machine);
    referencedBy.set(primaryId, standbys);
  }

  const paired = new Set<string>();
  for (const [primaryId, standbys] of referencedBy) {
    const primary = byId.get(primaryId)!;
    if (
      standbys.length !== 1 ||
      !Array.isArray(primary.standbyForMachineIds) ||
      primary.standbyForMachineIds.length > 0
    ) {
      throw new Error(
        `Fly Machine '${primaryId}' has an ambiguous standby relationship.`,
      );
    }
    const standby = standbys[0]!;
    const states = [primary.state, standby.state].sort();
    if (states[0] !== "started" || states[1] !== "stopped") {
      throw new Error(
        `Fly Machine pair '${primary.id}'/'${standby.id}' must contain exactly one started Machine and one stopped standby.`,
      );
    }
    paired.add(primary.id);
    paired.add(standby.id);
  }

  for (const machine of machines) {
    if (!paired.has(machine.id) && machine.state !== "started") {
      throw new Error(
        `Fly App inventory contains unrelated non-running Machine '${machine.id}'.`,
      );
    }
  }
  return machines.map((machine) => ({
    machine,
    expectedState: machine.state as "started" | "stopped",
  }));
}

export async function updateGlobalAppMachines(input: {
  appName: string;
  client: GlobalAppMachineClient;
  desiredImage: string;
  machines: EnvironmentProviderMachine[];
  role: FlyImageRole;
  sourceRevision: string;
  waitForWorkerReadiness: typeof waitForWorkerReadiness;
}) {
  const plan = validateGlobalAppMachineTopology(input.machines).sort(
    (left, right) =>
      (left.expectedState === "stopped" ? 0 : 1) -
        (right.expectedState === "stopped" ? 0 : 1) ||
      left.machine.id.localeCompare(right.machine.id),
  );
  const verifiedMachines: EnvironmentProviderMachine[] = [];
  for (const { machine, expectedState } of plan) {
    const updateStartedAt = new Date();
    const updated = await input.client.updateMachineImage({
      appName: input.appName,
      machineId: machine.id,
      runtimeImage: input.desiredImage,
      envPatch:
        input.role === "runpod-worker"
          ? { KESTREL_RELEASE_IMAGE: input.desiredImage }
          : undefined,
    });
    if (updated.state !== expectedState) {
      await input.client.waitForMachine({
        appName: input.appName,
        machineId: machine.id,
        state: expectedState,
        timeoutSeconds: 120,
      });
    }
    if (input.role === "preview-edge" && expectedState === "started") {
      await input.client.waitForMachineHealth({
        appName: input.appName,
        machineId: machine.id,
        checkName: "preview_edge",
        timeoutSeconds: 120,
      });
    }
    const verified = await input.client.getMachine({
      appName: input.appName,
      machineId: machine.id,
    });
    if (
      !isFlyImageReleaseMachineVerified(
        verified,
        input.desiredImage,
        expectedState,
      )
    ) {
      throw new Error(
        `Fly Machine '${machine.id}' did not remain ${expectedState} on the release digest.`,
      );
    }
    if (expectedState === "started" && input.role === "runpod-worker") {
      await input.waitForWorkerReadiness({
        role: input.role,
        machineId: machine.id,
        sourceRevision: input.sourceRevision,
        image: input.desiredImage,
        notBefore: updateStartedAt,
      });
    }
    verifiedMachines.push(verified!);
  }
  validateGlobalAppMachineTopology(verifiedMachines);
}

export async function waitForWorkerReadiness(input: {
  role: "turn-worker" | "runpod-worker";
  machineId: string;
  sourceRevision: string;
  image: string;
  notBefore: Date;
}) {
  const deadline = Date.now() + 120_000;
  const expectedDigest = input.image.match(/sha256:[a-f0-9]{64}$/u)?.[0];
  while (Date.now() < deadline) {
    const heartbeat = await knowledgeDb.query.releaseWorkerHeartbeats.findFirst(
      {
        where: and(
          eq(schema.releaseWorkerHeartbeats.role, input.role),
          eq(schema.releaseWorkerHeartbeats.machineId, input.machineId),
        ),
      },
    );
    if (
      isReleaseWorkerHeartbeatReady({
        heartbeat,
        sourceRevision: input.sourceRevision,
        expectedDigest,
        notBefore: input.notBefore,
      })
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `${input.role} did not publish an authoritative startup heartbeat for ${input.machineId}.`,
  );
}

export function isReleaseWorkerHeartbeatReady(input: {
  heartbeat:
    | {
        sourceRevision: string;
        image: string;
        startedAt: Date;
        heartbeatAt: Date;
      }
    | null
    | undefined;
  sourceRevision: string;
  expectedDigest: string | undefined;
  notBefore: Date;
  now?: Date;
}) {
  const heartbeatDigest =
    input.heartbeat?.image.match(/sha256:[a-f0-9]{64}$/u)?.[0];
  return Boolean(
    input.heartbeat?.sourceRevision === input.sourceRevision &&
    heartbeatDigest === input.expectedDigest &&
    input.heartbeat.startedAt >= input.notBefore &&
    (input.now ?? new Date()).getTime() -
      input.heartbeat.heartbeatAt.getTime() <=
      90_000,
  );
}

export function isMatchingTurnWorkerHeartbeat(
  heartbeat: {
    machineId: string;
    sourceRevision: string;
    configurationFingerprint: string;
    contractRevision: number;
    processStartedAt: Date;
    heartbeatAt: Date;
  },
  expected: {
    machineIds: string[];
    sourceRevision: string;
    configurationFingerprint: string;
    notBefore: Date;
    now: Date;
  },
) {
  return (
    expected.machineIds.includes(heartbeat.machineId) &&
    heartbeat.sourceRevision === expected.sourceRevision &&
    heartbeat.configurationFingerprint === expected.configurationFingerprint &&
    heartbeat.contractRevision === PROCESS_CONFIGURATION_CONTRACT_REVISION &&
    heartbeat.processStartedAt >= expected.notBefore &&
    heartbeat.heartbeatAt >= expected.notBefore &&
    expected.now.getTime() - heartbeat.heartbeatAt.getTime() < 60_000
  );
}

class TurnWorkerReadinessTimeoutError extends Error {
  constructor() {
    super(
      "The updated turn-worker Machines did not report the expected revision and configuration heartbeat within 120 seconds.",
    );
    this.name = "TurnWorkerReadinessTimeoutError";
  }
}

async function waitForTurnWorkerHeartbeat(input: {
  machineIds: string[];
  sourceRevision: string;
  configurationFingerprint: string;
  notBefore: Date;
  timeoutMs: number;
}) {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const heartbeats = await knowledgeDb
      .select()
      .from(schema.platformWorkerHeartbeats)
      .where(
        and(
          eq(schema.platformWorkerHeartbeats.workerRole, "turn-worker"),
          inArray(schema.platformWorkerHeartbeats.machineId, input.machineIds),
        ),
      );
    const now = new Date();
    if (
      heartbeats.some((heartbeat) =>
        isMatchingTurnWorkerHeartbeat(heartbeat, { ...input, now }),
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new TurnWorkerReadinessTimeoutError();
}

async function applyEnvironmentTarget(input: {
  release: typeof schema.flyImageReleases.$inferSelect;
  target: typeof schema.flyImageReleaseTargets.$inferSelect;
  isCanary: boolean;
}): Promise<"deferred"> {
  const environmentId = input.target.environmentId!;
  const retryCount = readResultNumber(input.target.result, "retryCount") ?? 0;
  const existingOperationId = readResultString(
    input.target.result,
    "operationId",
  );
  if (existingOperationId) {
    const operation = await knowledgeDb.query.environmentOperations.findFirst({
      where: eq(schema.environmentOperations.id, existingOperationId),
    });
    if (!operation)
      throw new Error("Release Environment operation disappeared.");
    if (operation.status === "failed" || operation.status === "cancelled") {
      throw new Error(
        operation.errorMessage ?? "Release Environment update failed.",
      );
    }
    if (operation.status !== "completed") return "deferred";
    const result = operation.result ?? {};
    const configuredWorkspaceIds = Array.isArray(
      result.configuredUnverifiedWorkspaceIds,
    )
      ? result.configuredUnverifiedWorkspaceIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const runtimeImage = readResultString(result, "runtimeImage");
    if (configuredWorkspaceIds.length && runtimeImage) {
      await knowledgeDb
        .insert(schema.flyImageReleaseTargets)
        .values(
          configuredWorkspaceIds.map((workspaceId) => ({
            releaseId: input.release.id,
            targetKind: "workspace" as const,
            environmentId,
            workspaceId,
            targetKey: `workspace:${workspaceId}`,
            desiredImage: runtimeImage,
            status: "configured_unverified" as const,
            stage: "workspace.configured_while_stopped",
            completedAt: new Date(),
          })),
        )
        .onConflictDoNothing();
    }
    await knowledgeDb
      .update(schema.flyImageReleaseTargets)
      .set({
        status: "completed",
        stage: "environment.verified",
        result,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.flyImageReleaseTargets.id, input.target.id));
    return "deferred";
  }

  const drainStartedAt = input.target.startedAt ?? new Date();
  const components = await knowledgeDb
    .select()
    .from(schema.flyImageReleaseComponents)
    .where(eq(schema.flyImageReleaseComponents.releaseId, input.release.id));
  const runtimeImage = componentImage(components, "workspace-runtime");
  const routerImage = componentImage(components, "environment-router");
  const operationId = crypto.randomUUID();
  const disposition = await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(environmentId)}, 0))`,
    );
    const environment = await transaction.query.environments.findFirst({
      where: and(
        eq(schema.environments.id, environmentId),
        eq(schema.environments.provider, "fly"),
      ),
    });
    const environmentDisposition = classifyFlyImageReleaseEnvironment({
      status: environment?.status ?? null,
      archived: Boolean(environment?.archivedAt),
    });
    if (environmentDisposition === "skip") {
      if (input.isCanary) {
        throw new Error("The canary Environment became unavailable.");
      }
      const now = new Date();
      await transaction
        .update(schema.flyImageReleaseTargets)
        .set({
          status: "completed",
          stage: "environment.skipped_unavailable",
          result: {
            skipped: true,
            environmentStatus: environment?.status ?? "unavailable",
          },
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.flyImageReleaseTargets.id, input.target.id));
      return "skipped" as const;
    }
    if (environmentDisposition === "waiting") {
      await transaction
        .update(schema.flyImageReleaseTargets)
        .set({
          status: "pending",
          stage: "environment.awaiting_provisioning",
          updatedAt: new Date(),
        })
        .where(eq(schema.flyImageReleaseTargets.id, input.target.id));
      return "waiting" as const;
    }
    if (!environment) {
      throw new Error("Release Environment is unavailable.");
    }
    const activeExecutions = await transaction
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.environmentRunExecutions)
      .where(
        and(
          eq(schema.environmentRunExecutions.environmentId, environmentId),
          inArray(schema.environmentRunExecutions.status, [
            "routed",
            "running",
          ]),
        ),
      );
    const activeCount = activeExecutions[0]?.count ?? 0;
    if (activeCount > 0) {
      if (Date.now() - drainStartedAt.getTime() >= RELEASE_DRAIN_TIMEOUT_MS) {
        throw new Error(
          `Environment still had ${activeCount} active execution(s) after the 30 minute drain window.`,
        );
      }
      await transaction
        .update(schema.flyImageReleaseTargets)
        .set({
          status: "draining",
          stage: "environment.draining",
          startedAt: drainStartedAt,
          result: { retryCount, activeExecutionCount: activeCount },
          updatedAt: new Date(),
        })
        .where(eq(schema.flyImageReleaseTargets.id, input.target.id));
      return "draining" as const;
    }
    await transaction.insert(schema.environmentOperations).values({
      id: operationId,
      organizationId: environment.organizationId,
      environmentId: environment.id,
      requestedByUserId: input.release.approvedByUserId,
      type: "environment.update",
      status: "queued",
      stage: "requested",
      idempotencyKey: `fly-image-release:${input.release.id}:${environment.id}:${retryCount}`,
      input: {
        releaseId: input.release.id,
        releaseTargetId: input.target.id,
        runtimeImage,
        routerImage,
        preserveStoppedWorkspaces: true,
        automaticRollback: false,
      },
    });
    await transaction
      .update(schema.flyImageReleaseTargets)
      .set({
        status: "applying",
        stage: "environment.update_queued",
        priorImage: environment.runtimeImage,
        desiredImage: runtimeImage,
        startedAt: drainStartedAt,
        result: {
          retryCount,
          operationId,
          priorRuntimeImage: environment.runtimeImage,
          priorRouterImage: environment.routerImage,
          desiredRouterImage: routerImage,
        },
        updatedAt: new Date(),
      })
      .where(eq(schema.flyImageReleaseTargets.id, input.target.id));
    return "queued" as const;
  });
  if (disposition !== "queued") return "deferred";
  await enqueueEnvironmentOperation(operationId);
  return "deferred";
}

export async function markWorkspaceReleaseVerified(input: {
  workspaceId: string;
  runtimeImage: string;
}) {
  const verified = await knowledgeDb
    .update(schema.flyImageReleaseTargets)
    .set({
      status: "completed",
      stage: "workspace.verified_on_start",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.flyImageReleaseTargets.workspaceId, input.workspaceId),
        eq(schema.flyImageReleaseTargets.desiredImage, input.runtimeImage),
        eq(schema.flyImageReleaseTargets.status, "configured_unverified"),
      ),
    )
    .returning({ releaseId: schema.flyImageReleaseTargets.releaseId });
  for (const releaseId of new Set(verified.map((target) => target.releaseId))) {
    await completeFlyImageReleaseIfReady(releaseId);
  }
}

function createPlatformFlyClient() {
  const token = process.env.FLY_API_TOKEN?.trim();
  const organizationSlug = process.env.KESTREL_FLY_ORGANIZATION_SLUG?.trim();
  if (!(token && organizationSlug)) {
    throw new Error("Platform Fly release credentials are not configured.");
  }
  return new FlyMachinesClient({ token, organizationSlug });
}

function componentImage(
  components: Array<typeof schema.flyImageReleaseComponents.$inferSelect>,
  role: FlyImageRole,
) {
  const image = components.find((component) => component.role === role)?.image;
  if (!image) throw new Error(`Release component '${role}' is unavailable.`);
  return image;
}

export function orderFlyImageReleaseTargets<
  T extends {
    targetKind: string;
    componentRole: string | null;
    environmentId: string | null;
    targetKey: string;
  },
>(targets: T[], canaryEnvironmentId: string | null) {
  const hasEnvironmentTargets = targets.some(
    (target) => target.targetKind === "environment",
  );
  const rank = (target: T) => {
    if (
      hasEnvironmentTargets &&
      target.targetKind === "environment" &&
      target.environmentId === canaryEnvironmentId
    ) {
      return 0;
    }
    if (target.targetKind === "global_app") {
      if (target.componentRole === "preview-edge") return 1;
      if (target.componentRole === "runpod-worker") return 2;
      if (target.componentRole === "turn-worker") return 4;
    }
    if (target.targetKind === "environment") return 3;
    return 5;
  };
  return [...targets].sort(
    (left, right) =>
      rank(left) - rank(right) || left.targetKey.localeCompare(right.targetKey),
  );
}

async function pauseRelease(releaseId: string, code: string, message: string) {
  await knowledgeDb
    .update(schema.flyImageReleases)
    .set({
      status: "paused",
      failureCode: code,
      failureMessage: message,
      updatedAt: new Date(),
    })
    .where(eq(schema.flyImageReleases.id, releaseId));
}

function readResultString(value: unknown, key: string) {
  if (!(value && typeof value === "object")) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : null;
}

function readResultNumber(value: unknown, key: string) {
  if (!(value && typeof value === "object")) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" ? candidate : null;
}
