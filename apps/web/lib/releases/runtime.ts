import { and, eq, inArray, sql } from "drizzle-orm";
import { FlyMachinesClient } from "@/lib/environments/providers/fly-machines";
import { environmentLifecycleLockKey } from "@/lib/environments/lifecycle-lock";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";
import {
  classifyFlyImageReleaseEnvironment,
  isFlyImageReleaseMachineVerified,
  type FlyImageRole,
} from "./contracts";
import { completeFlyImageReleaseIfReady } from "./store";

const RELEASE_DRAIN_TIMEOUT_MS = 30 * 60 * 1000;
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
  const target = orderReleaseTargets(
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
    await knowledgeDb
      .update(schema.flyImageReleaseTargets)
      .set({
        status: "failed",
        failureCode: "RELEASE_TARGET_FAILED",
        failureMessage: message,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.flyImageReleaseTargets.id, target.id));
    await pauseRelease(release.id, "RELEASE_TARGET_FAILED", message);
    return "not_claimed";
  }
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
  await knowledgeDb
    .update(schema.flyImageReleaseTargets)
    .set({
      status: "applying",
      stage: "global_app.updating",
      priorImage: before[0]?.image ?? null,
      startedAt: target.startedAt ?? new Date(),
      result: { machineIds: before.map((machine) => machine.id) },
      updatedAt: new Date(),
    })
    .where(eq(schema.flyImageReleaseTargets.id, target.id));
  for (const machine of before) {
    const updated = await client.updateMachineImage({
      appName,
      machineId: machine.id,
      runtimeImage: target.desiredImage,
    });
    if (updated.state !== "started") {
      await client.waitForMachine({
        appName,
        machineId: machine.id,
        state: "started",
        timeoutSeconds: 120,
      });
    }
    if (role === "preview-edge") {
      await client.waitForMachineHealth({
        appName,
        machineId: machine.id,
        checkName: "preview_edge",
        timeoutSeconds: 120,
      });
    }
    const verified = await client.getMachine({
      appName,
      machineId: machine.id,
    });
    if (!isFlyImageReleaseMachineVerified(verified, target.desiredImage)) {
      throw new Error(
        `Fly Machine '${machine.id}' was not running on the release digest.`,
      );
    }
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
  await knowledgeDb
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
    );
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

function orderReleaseTargets<
  T extends typeof schema.flyImageReleaseTargets.$inferSelect,
>(targets: T[], canaryEnvironmentId: string | null) {
  const rank = (target: T) => {
    if (target.targetKind === "global_app") {
      if (target.componentRole === "preview-edge") return 0;
      if (target.componentRole === "runpod-worker") return 1;
      if (target.componentRole === "turn-worker") return 4;
    }
    if (
      target.targetKind === "environment" &&
      target.environmentId === canaryEnvironmentId
    ) {
      return 2;
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
