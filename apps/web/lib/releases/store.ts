import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION } from "@lumi/kestrel-environment-auth";
import {
  assertFlyImageMatchesRole,
  countResolvedFlyImageReleaseTargets,
  evaluateFlyImageReleaseAdmission,
  evaluateFlyImageForwardRecoveryEligibility,
  evaluateFlyImageMigrationAcknowledgementEligibility,
  selectFlyImageRollbackTargets,
  FLY_IMAGE_RELEASE_DEPLOYABLE_ENVIRONMENT_STATUSES,
  FLY_IMAGE_ROLES,
  FLY_IMAGE_RELEASE_TARGETABLE_ENVIRONMENT_STATUSES,
  type FlyImageReleaseManifestV2,
  type FlyImageRole,
  flyImageReleaseManifestV2Schema,
} from "./contracts";
import { digestCanonicalJson } from "./digest";
import { mergePinnedFlyImageReleaseHistory } from "./history";
import {
  RELEASE_CONTROLLER_CONTRACT_REVISION,
  RELEASE_CONTROLLER_HEARTBEAT_MAX_AGE_MS,
} from "./controller-contract";

export const FLY_IMAGE_RELEASE_LOCK_KEY = "kestrel:fly-image-release";

type KnowledgeTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

export class FlyImageReleaseError extends Error {
  constructor(
    readonly code:
      | "RELEASE_ACTIVE"
      | "RELEASE_CANARY_REQUIRED"
      | "RELEASE_BUILD_REVISION_MISMATCH"
      | "RELEASE_COMPATIBILITY_BLOCKED"
      | "RELEASE_COMPATIBILITY_UNKNOWN"
      | "RELEASE_CONTROLLER_STALE"
      | "RELEASE_INCOMPLETE"
      | "RELEASE_MIGRATION_BLOCKED"
      | "RELEASE_NOT_FOUND"
      | "RELEASE_STATE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "FlyImageReleaseError";
  }
}

export async function assertReleaseControllerHealthy(
  requiredRevision = RELEASE_CONTROLLER_CONTRACT_REVISION,
) {
  const controller =
    await knowledgeDb.query.releaseControllerHeartbeats.findFirst({
      where: eq(schema.releaseControllerHeartbeats.id, "platform"),
    });
  if (
    !controller ||
    controller.contractRevision < requiredRevision ||
    Date.now() - controller.heartbeatAt.getTime() >
      RELEASE_CONTROLLER_HEARTBEAT_MAX_AGE_MS
  ) {
    throw new FlyImageReleaseError(
      "RELEASE_CONTROLLER_STALE",
      `Release controller revision ${requiredRevision} is not healthy. Deploy and verify the control worker before publishing this candidate.`,
    );
  }
  return controller;
}

export async function registerFlyImageReleaseCandidate(
  input: FlyImageReleaseManifestV2,
) {
  const manifest = flyImageReleaseManifestV2Schema.parse(input);
  assertCurrentBuildRevision(manifest.bundleRevision);
  for (const component of manifest.components) {
    assertFlyImageMatchesRole(component.role, component.image);
  }
  await assertReleaseControllerHealthy(manifest.controllerContractRevision);

  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${FLY_IMAGE_RELEASE_LOCK_KEY}, 0))`,
    );
    const settings = await ensureSettings(transaction);
    const baseComponents = settings.stableReleaseId
      ? await transaction
          .select()
          .from(schema.flyImageReleaseComponents)
          .where(
            eq(
              schema.flyImageReleaseComponents.releaseId,
              settings.stableReleaseId,
            ),
          )
      : [];
    const changedByRole = new Map(
      manifest.components.map((component) => [component.role, component]),
    );
    const baseByRole = new Map(
      baseComponents.map((component) => [component.role, component]),
    );
    const components = FLY_IMAGE_ROLES.map((role) => {
      const changed = changedByRole.get(role);
      if (changed) return { ...changed, changed: true };
      const base = baseByRole.get(role);
      if (!base) {
        throw new FlyImageReleaseError(
          "RELEASE_INCOMPLETE",
          `The first Fly image release must publish '${role}'.`,
        );
      }
      return {
        role,
        image: base.image,
        sourceRevision: base.sourceRevision,
        inputFingerprint: base.inputFingerprint,
        smoke: base.smoke,
        environmentGateway:
          role === "environment-router" &&
          base.environmentGatewayAcceptedVersions
            ? {
                acceptedVersions: [...base.environmentGatewayAcceptedVersions],
              }
            : undefined,
        changed: false,
      };
    });
    const router = components.find(
      (component) => component.role === "environment-router",
    );
    const acceptedVersions = router?.environmentGateway?.acceptedVersions;
    if (!acceptedVersions) {
      throw new FlyImageReleaseError(
        "RELEASE_COMPATIBILITY_UNKNOWN",
        "The Environment Router does not declare gateway compatibility.",
      );
    }
    if (
      !acceptedVersions.includes(manifest.environmentGateway.producedVersion)
    ) {
      throw new FlyImageReleaseError(
        "RELEASE_COMPATIBILITY_BLOCKED",
        `Environment Router versions [${acceptedVersions.join(", ")}] do not accept gateway configuration version ${manifest.environmentGateway.producedVersion}.`,
      );
    }
    const manifestDigest = digestCanonicalJson({
      version: manifest.version,
      controllerContractRevision: manifest.controllerContractRevision,
      bundleRevision: manifest.bundleRevision,
      trigger: manifest.trigger,
      migrationChanged: manifest.migrationChanged,
      environmentGatewayConfigVersion:
        manifest.environmentGateway.producedVersion,
      validationStatus: manifest.validation.status,
      components: components.map((component) => ({
        role: component.role,
        image: component.image,
        sourceRevision: component.sourceRevision,
        inputFingerprint: component.inputFingerprint,
        changed: component.changed,
        smokeStatus: component.smoke.status,
        environmentGatewayAcceptedVersions:
          component.environmentGateway?.acceptedVersions ?? null,
      })),
    });
    const existing = await transaction.query.flyImageReleases.findFirst({
      where: eq(schema.flyImageReleases.manifestDigest, manifestDigest),
    });
    if (existing) return existing;

    await transaction
      .update(schema.flyImageReleases)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(eq(schema.flyImageReleases.status, "candidate"));
    const [release] = await transaction
      .insert(schema.flyImageReleases)
      .values({
        bundleRevision: manifest.bundleRevision,
        manifestDigest,
        trigger: manifest.trigger,
        status: "candidate",
        migrationChanged: manifest.migrationChanged,
        validation: manifest.validation,
        environmentGatewayConfigVersion:
          manifest.environmentGateway.producedVersion,
        baseReleaseId: settings.stableReleaseId,
      })
      .returning();
    if (!release) throw new Error("Fly image release insert returned no row.");
    await transaction.insert(schema.flyImageReleaseComponents).values(
      components.map((component) => ({
        releaseId: release.id,
        role: component.role,
        image: component.image,
        sourceRevision: component.sourceRevision,
        inputFingerprint: component.inputFingerprint,
        changed: component.changed,
        smoke: component.smoke,
        environmentGatewayAcceptedVersions:
          component.environmentGateway?.acceptedVersions ?? null,
      })),
    );
    return release;
  });
}

export async function listFlyImageReleases(limit = 25) {
  const normalizedLimit = Math.max(1, Math.min(limit, 100));
  const [recentReleases, settings] = await Promise.all([
    knowledgeDb
      .select()
      .from(schema.flyImageReleases)
      .orderBy(desc(schema.flyImageReleases.createdAt))
      .limit(normalizedLimit),
    knowledgeDb.query.flyImageReleaseSettings.findFirst({
      where: eq(schema.flyImageReleaseSettings.id, "platform"),
    }),
  ]);
  const recentIds = new Set(recentReleases.map((release) => release.id));
  const pinnedIds = [
    settings?.activeReleaseId,
    settings?.stableReleaseId,
  ].filter((releaseId): releaseId is string =>
    Boolean(releaseId && !recentIds.has(releaseId)),
  );
  const pinnedReleases = pinnedIds.length
    ? await knowledgeDb
        .select()
        .from(schema.flyImageReleases)
        .where(inArray(schema.flyImageReleases.id, pinnedIds))
    : [];
  const releases = mergePinnedFlyImageReleaseHistory(
    recentReleases,
    pinnedReleases,
  );
  const releaseIds = releases.map((release) => release.id);
  const [components, targets, canary] = await Promise.all([
    releaseIds.length
      ? knowledgeDb
          .select()
          .from(schema.flyImageReleaseComponents)
          .where(
            inArray(schema.flyImageReleaseComponents.releaseId, releaseIds),
          )
      : [],
    releaseIds.length
      ? knowledgeDb
          .select()
          .from(schema.flyImageReleaseTargets)
          .where(inArray(schema.flyImageReleaseTargets.releaseId, releaseIds))
      : [],
    settings?.canaryEnvironmentId
      ? knowledgeDb.query.environments.findFirst({
          where: and(
            eq(schema.environments.id, settings.canaryEnvironmentId),
            eq(schema.environments.provider, "fly"),
            isNull(schema.environments.archivedAt),
            inArray(
              schema.environments.status,
              FLY_IMAGE_RELEASE_DEPLOYABLE_ENVIRONMENT_STATUSES,
            ),
          ),
          columns: { id: true },
        })
      : null,
  ]);
  const configuredRevision = process.env.KESTREL_BUILD_REVISION?.trim() ?? "";
  const servingRevision = /^[a-f0-9]{40}$/u.test(configuredRevision)
    ? configuredRevision
    : null;
  const stableRouter = components.find(
    (component) =>
      component.releaseId === settings?.stableReleaseId &&
      component.role === "environment-router",
  );
  const rollbackEligibility = stableRouter?.environmentGatewayAcceptedVersions
    ? stableRouter.environmentGatewayAcceptedVersions.includes(
        ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION,
      )
      ? { ok: true as const }
      : {
          ok: false as const,
          code: "RELEASE_COMPATIBILITY_BLOCKED",
          message:
            "The stable Environment Router is incompatible with the serving control plane.",
        }
    : {
        ok: false as const,
        code: "RELEASE_COMPATIBILITY_UNKNOWN",
        message: "The stable Environment Router has no compatibility evidence.",
      };
  return {
    settings: settings ?? null,
    currentBuildRevision: servingRevision,
    compatibilityMode: stableRouter?.environmentGatewayAcceptedVersions
      ? ("enforced" as const)
      : ("legacy_bridge" as const),
    rollbackEligibility,
    releases: releases.map((release) => {
      const releaseComponents = components.filter(
        (component) => component.releaseId === release.id,
      );
      const releaseTargets = targets.filter(
        (target) => target.releaseId === release.id,
      );
      const admission = [
        "candidate",
        "approved",
        "deploying",
        "paused",
      ].includes(release.status)
        ? servingRevision
          ? evaluateStoredReleaseAdmission(release, releaseComponents)
          : {
              ok: false as const,
              code: "RELEASE_BUILD_REVISION_MISMATCH",
              message: "The serving Kestrel build revision is unavailable.",
            }
        : { ok: true as const };
      return {
        ...release,
        components: releaseComponents,
        targets: releaseTargets,
        resolvedTargetCount:
          countResolvedFlyImageReleaseTargets(releaseTargets),
        totalTargetCount: releaseTargets.length,
        admission,
        migrationAcknowledgementEligibility:
          evaluateFlyImageMigrationAcknowledgementEligibility(release),
        recoveryEligibility:
          release.status === "candidate"
            ? evaluateFlyImageForwardRecoveryEligibility({
                activeStatus:
                  releases.find(
                    (candidate) => candidate.id === settings?.activeReleaseId,
                  )?.status ?? null,
                admission,
                migrationReady:
                  !release.migrationChanged ||
                  release.migrationApprovedAt !== null,
                canaryValid: Boolean(canary),
              })
            : {
                ok: false as const,
                code: "RELEASE_STATE_INVALID",
                message: "Only a candidate can recover a paused release.",
              },
      };
    }),
  };
}

export async function listFlyImageReleaseCanaries() {
  return knowledgeDb
    .select({
      id: schema.environments.id,
      name: schema.environments.name,
      organizationName: schema.organizations.name,
      status: schema.environments.status,
    })
    .from(schema.environments)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.environments.organizationId),
    )
    .where(
      and(
        eq(schema.environments.provider, "fly"),
        isNull(schema.environments.archivedAt),
        inArray(
          schema.environments.status,
          FLY_IMAGE_RELEASE_DEPLOYABLE_ENVIRONMENT_STATUSES,
        ),
      ),
    )
    .orderBy(asc(schema.organizations.name), asc(schema.environments.name));
}

export async function getFlyImageReleasePublicationState() {
  await assertReleaseControllerHealthy();
  const settings = await knowledgeDb.query.flyImageReleaseSettings.findFirst({
    where: eq(schema.flyImageReleaseSettings.id, "platform"),
    columns: { stableReleaseId: true },
  });
  if (!settings?.stableReleaseId) {
    return {
      requiresFullBundle: true as const,
      stableBundleRevision: null,
    };
  }
  const stable = await knowledgeDb.query.flyImageReleases.findFirst({
    where: eq(schema.flyImageReleases.id, settings.stableReleaseId),
    columns: { bundleRevision: true },
  });
  return stable
    ? {
        requiresFullBundle: false as const,
        stableBundleRevision: stable.bundleRevision,
      }
    : {
        requiresFullBundle: true as const,
        stableBundleRevision: null,
      };
}

export async function attachActiveFlyImageReleaseTarget(
  transaction: KnowledgeTransaction,
  environmentId: string,
) {
  await lockFlyImageReleases(transaction);
  const settings = await transaction.query.flyImageReleaseSettings.findFirst({
    where: eq(schema.flyImageReleaseSettings.id, "platform"),
    columns: { activeReleaseId: true },
  });
  if (!settings?.activeReleaseId) return false;
  if (
    !(await releaseChangesEnvironmentImages(
      transaction,
      settings.activeReleaseId,
    ))
  ) {
    return false;
  }
  await insertEnvironmentTargets(transaction, settings.activeReleaseId, [
    environmentId,
  ]);
  return true;
}

export async function completeFlyImageReleaseIfReady(releaseId: string) {
  return knowledgeDb.transaction(async (transaction) => {
    await lockFlyImageReleases(transaction);
    const [settings, release] = await Promise.all([
      transaction.query.flyImageReleaseSettings.findFirst({
        where: eq(schema.flyImageReleaseSettings.id, "platform"),
      }),
      transaction.query.flyImageReleases.findFirst({
        where: eq(schema.flyImageReleases.id, releaseId),
      }),
    ]);
    if (
      settings?.activeReleaseId !== releaseId ||
      !(release && ["approved", "deploying"].includes(release.status))
    ) {
      return false;
    }
    if (await releaseChangesEnvironmentImages(transaction, releaseId)) {
      const environments = await transaction
        .select({ id: schema.environments.id })
        .from(schema.environments)
        .where(
          and(
            eq(schema.environments.provider, "fly"),
            isNull(schema.environments.archivedAt),
            inArray(
              schema.environments.status,
              FLY_IMAGE_RELEASE_TARGETABLE_ENVIRONMENT_STATUSES,
            ),
          ),
        );
      await insertEnvironmentTargets(
        transaction,
        releaseId,
        environments.map((environment) => environment.id),
      );
    }
    const incompleteTarget =
      await transaction.query.flyImageReleaseTargets.findFirst({
        where: and(
          eq(schema.flyImageReleaseTargets.releaseId, releaseId),
          notInArray(schema.flyImageReleaseTargets.status, [
            "completed",
            "configured_unverified",
          ]),
        ),
        columns: { id: true },
      });
    if (incompleteTarget) return false;

    const now = new Date();
    await transaction
      .update(schema.flyImageReleases)
      .set({ status: "completed", completedAt: now, updatedAt: now })
      .where(eq(schema.flyImageReleases.id, releaseId));
    await transaction
      .update(schema.flyImageReleaseSettings)
      .set({
        stableReleaseId: releaseId,
        activeReleaseId: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.flyImageReleaseSettings.id, "platform"),
          eq(schema.flyImageReleaseSettings.activeReleaseId, releaseId),
        ),
      );
    return true;
  });
}

export async function getFlyImageRelease(releaseId: string) {
  const release = await knowledgeDb.query.flyImageReleases.findFirst({
    where: eq(schema.flyImageReleases.id, releaseId),
  });
  if (!release) return null;
  const [components, targets] = await Promise.all([
    knowledgeDb
      .select()
      .from(schema.flyImageReleaseComponents)
      .where(eq(schema.flyImageReleaseComponents.releaseId, releaseId)),
    knowledgeDb
      .select()
      .from(schema.flyImageReleaseTargets)
      .where(eq(schema.flyImageReleaseTargets.releaseId, releaseId)),
  ]);
  return { ...release, components, targets };
}

export async function getStableFlyEnvironmentImages() {
  const settings = await knowledgeDb.query.flyImageReleaseSettings.findFirst({
    where: eq(schema.flyImageReleaseSettings.id, "platform"),
    columns: { stableReleaseId: true },
  });
  if (!settings?.stableReleaseId) return null;
  const components = await knowledgeDb
    .select()
    .from(schema.flyImageReleaseComponents)
    .where(
      and(
        eq(
          schema.flyImageReleaseComponents.releaseId,
          settings.stableReleaseId,
        ),
        inArray(schema.flyImageReleaseComponents.role, [
          "workspace-runtime",
          "environment-router",
        ]),
      ),
    );
  const runtimeImage = components.find(
    (component) => component.role === "workspace-runtime",
  )?.image;
  const routerImage = components.find(
    (component) => component.role === "environment-router",
  )?.image;
  return runtimeImage && routerImage ? { runtimeImage, routerImage } : null;
}

export async function getEnvironmentFlyImageReleaseStatus(
  environmentId: string,
) {
  const settings = await knowledgeDb.query.flyImageReleaseSettings.findFirst({
    where: eq(schema.flyImageReleaseSettings.id, "platform"),
  });
  const stableImages = await getStableFlyEnvironmentImages();
  const activeTarget = settings?.activeReleaseId
    ? await knowledgeDb.query.flyImageReleaseTargets.findFirst({
        where: and(
          eq(schema.flyImageReleaseTargets.releaseId, settings.activeReleaseId),
          eq(schema.flyImageReleaseTargets.environmentId, environmentId),
          eq(schema.flyImageReleaseTargets.targetKind, "environment"),
        ),
      })
    : null;
  return {
    stableReleaseId: settings?.stableReleaseId ?? null,
    activeReleaseId: settings?.activeReleaseId ?? null,
    desiredRuntimeImage: stableImages?.runtimeImage ?? null,
    rolloutStatus: activeTarget?.status ?? null,
    rolloutStage: activeTarget?.stage ?? null,
  };
}

export async function setFlyImageReleaseCanary(environmentId: string | null) {
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${FLY_IMAGE_RELEASE_LOCK_KEY}, 0))`,
    );
    const settings = await ensureSettings(transaction);
    if (settings.activeReleaseId) {
      throw new FlyImageReleaseError(
        "RELEASE_ACTIVE",
        "The canary cannot change while a Fly image release is active.",
      );
    }
    if (environmentId) {
      const environment = await transaction.query.environments.findFirst({
        where: and(
          eq(schema.environments.id, environmentId),
          eq(schema.environments.provider, "fly"),
          isNull(schema.environments.archivedAt),
          inArray(
            schema.environments.status,
            FLY_IMAGE_RELEASE_DEPLOYABLE_ENVIRONMENT_STATUSES,
          ),
        ),
        columns: { id: true },
      });
      if (!environment) {
        throw new FlyImageReleaseError(
          "RELEASE_CANARY_REQUIRED",
          "The canary must be an active Fly Environment.",
        );
      }
    }
    const [updated] = await transaction
      .update(schema.flyImageReleaseSettings)
      .set({ canaryEnvironmentId: environmentId, updatedAt: new Date() })
      .where(eq(schema.flyImageReleaseSettings.id, "platform"))
      .returning();
    return updated;
  });
}

export async function approveFlyImageRelease(input: {
  releaseId: string;
  actorUserId: string;
}) {
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${FLY_IMAGE_RELEASE_LOCK_KEY}, 0))`,
    );
    const settings = await ensureSettings(transaction);
    if (settings.activeReleaseId) {
      throw new FlyImageReleaseError(
        "RELEASE_ACTIVE",
        "Another Fly image release is already active.",
      );
    }
    if (!settings.canaryEnvironmentId) {
      throw new FlyImageReleaseError(
        "RELEASE_CANARY_REQUIRED",
        "Choose a canary Fly Environment before approval.",
      );
    }
    const canary = await transaction.query.environments.findFirst({
      where: and(
        eq(schema.environments.id, settings.canaryEnvironmentId),
        eq(schema.environments.provider, "fly"),
        isNull(schema.environments.archivedAt),
        inArray(
          schema.environments.status,
          FLY_IMAGE_RELEASE_DEPLOYABLE_ENVIRONMENT_STATUSES,
        ),
      ),
      columns: { id: true },
    });
    if (!canary) {
      throw new FlyImageReleaseError(
        "RELEASE_CANARY_REQUIRED",
        "Choose an active canary Fly Environment before approval.",
      );
    }
    const release = await transaction.query.flyImageReleases.findFirst({
      where: eq(schema.flyImageReleases.id, input.releaseId),
    });
    if (!release) {
      throw new FlyImageReleaseError(
        "RELEASE_NOT_FOUND",
        "Fly image release not found.",
      );
    }
    if (release.status !== "candidate") {
      throw new FlyImageReleaseError(
        "RELEASE_STATE_INVALID",
        "Only a candidate Fly image release can be approved.",
      );
    }
    if (release.migrationChanged && !release.migrationApprovedAt) {
      throw new FlyImageReleaseError(
        "RELEASE_MIGRATION_BLOCKED",
        "This candidate changes database migrations and requires the migration runbook before promotion.",
      );
    }
    const components = await transaction
      .select()
      .from(schema.flyImageReleaseComponents)
      .where(eq(schema.flyImageReleaseComponents.releaseId, release.id));
    assertStoredReleaseAdmission(release, components);
    return promoteFlyImageReleaseCandidate({
      transaction,
      settings,
      release,
      components,
      actorUserId: input.actorUserId,
    });
  });
}

export async function recoverFlyImageReleaseForward(input: {
  releaseId: string;
  actorUserId: string;
}) {
  return knowledgeDb.transaction(async (transaction) => {
    await lockFlyImageReleases(transaction);
    const settings = await ensureSettings(transaction);
    if (!settings.activeReleaseId) {
      throw new FlyImageReleaseError(
        "RELEASE_STATE_INVALID",
        "Forward recovery requires an active paused Fly image release.",
      );
    }
    const [paused, candidate] = await Promise.all([
      transaction.query.flyImageReleases.findFirst({
        where: eq(schema.flyImageReleases.id, settings.activeReleaseId),
      }),
      transaction.query.flyImageReleases.findFirst({
        where: eq(schema.flyImageReleases.id, input.releaseId),
      }),
    ]);
    if (!paused || paused.status !== "paused") {
      throw new FlyImageReleaseError(
        "RELEASE_STATE_INVALID",
        "Forward recovery requires the active Fly image release to be paused.",
      );
    }
    if (!candidate || candidate.status !== "candidate") {
      throw new FlyImageReleaseError(
        "RELEASE_STATE_INVALID",
        "Forward recovery requires a candidate Fly image release.",
      );
    }
    if (candidate.migrationChanged && !candidate.migrationApprovedAt) {
      throw new FlyImageReleaseError(
        "RELEASE_MIGRATION_BLOCKED",
        "This candidate changes database migrations and requires the migration runbook before recovery.",
      );
    }
    await requireFlyImageReleaseCanary(
      transaction,
      settings.canaryEnvironmentId,
    );
    const components = await transaction
      .select()
      .from(schema.flyImageReleaseComponents)
      .where(eq(schema.flyImageReleaseComponents.releaseId, candidate.id));
    assertStoredReleaseAdmission(candidate, components);
    const now = new Date();
    await transaction
      .update(schema.flyImageReleases)
      .set({ status: "superseded", updatedAt: now })
      .where(eq(schema.flyImageReleases.id, paused.id));
    return promoteFlyImageReleaseCandidate({
      transaction,
      settings,
      release: candidate,
      components,
      actorUserId: input.actorUserId,
      recoveryOfReleaseId: paused.id,
      now,
    });
  });
}

async function promoteFlyImageReleaseCandidate(input: {
  transaction: KnowledgeTransaction;
  settings: typeof schema.flyImageReleaseSettings.$inferSelect;
  release: typeof schema.flyImageReleases.$inferSelect;
  components: Array<typeof schema.flyImageReleaseComponents.$inferSelect>;
  actorUserId: string;
  recoveryOfReleaseId?: string | undefined;
  now?: Date | undefined;
}) {
  const changedRoles = new Set(
    input.components
      .filter((component) => component.changed)
      .map((component) => component.role),
  );
  const environments =
    changedRoles.has("workspace-runtime") ||
    changedRoles.has("environment-router")
      ? await input.transaction
          .select({ id: schema.environments.id })
          .from(schema.environments)
          .where(
            and(
              eq(schema.environments.provider, "fly"),
              isNull(schema.environments.archivedAt),
              inArray(
                schema.environments.status,
                FLY_IMAGE_RELEASE_TARGETABLE_ENVIRONMENT_STATUSES,
              ),
            ),
          )
      : [];
  const globalRoles = ["preview-edge", "turn-worker", "runpod-worker"] as const;
  const targets = [
    ...globalRoles
      .filter((role) => changedRoles.has(role))
      .map((role) => {
        const component = requireComponent(input.components, role);
        return {
          releaseId: input.release.id,
          targetKind: "global_app" as const,
          componentRole: role,
          targetKey: `global:${role}`,
          desiredImage: component.image,
        };
      }),
    ...environments.map((environment) => ({
      releaseId: input.release.id,
      targetKind: "environment" as const,
      environmentId: environment.id,
      targetKey: `environment:${environment.id}`,
    })),
  ];
  if (targets.length) {
    await input.transaction
      .insert(schema.flyImageReleaseTargets)
      .values(targets);
  }
  const now = input.now ?? new Date();
  const [approved] = await input.transaction
    .update(schema.flyImageReleases)
    .set({
      status: targets.length ? "approved" : "completed",
      approvedByUserId: input.actorUserId,
      approvedAt: now,
      completedAt: targets.length ? null : now,
      recoveryOfReleaseId: input.recoveryOfReleaseId ?? null,
      updatedAt: now,
    })
    .where(eq(schema.flyImageReleases.id, input.release.id))
    .returning();
  await input.transaction
    .update(schema.flyImageReleaseSettings)
    .set({
      activeReleaseId: targets.length ? input.release.id : null,
      stableReleaseId: targets.length
        ? input.settings.stableReleaseId
        : input.release.id,
      updatedAt: now,
    })
    .where(eq(schema.flyImageReleaseSettings.id, "platform"));
  return approved;
}

async function requireFlyImageReleaseCanary(
  transaction: KnowledgeTransaction,
  environmentId: string | null,
) {
  if (!environmentId) {
    throw new FlyImageReleaseError(
      "RELEASE_CANARY_REQUIRED",
      "Choose a canary Fly Environment before recovery.",
    );
  }
  const canary = await transaction.query.environments.findFirst({
    where: and(
      eq(schema.environments.id, environmentId),
      eq(schema.environments.provider, "fly"),
      isNull(schema.environments.archivedAt),
      inArray(
        schema.environments.status,
        FLY_IMAGE_RELEASE_DEPLOYABLE_ENVIRONMENT_STATUSES,
      ),
    ),
    columns: { id: true },
  });
  if (!canary) {
    throw new FlyImageReleaseError(
      "RELEASE_CANARY_REQUIRED",
      "Choose an active canary Fly Environment before recovery.",
    );
  }
}

export async function acknowledgeFlyImageReleaseMigration(input: {
  releaseId: string;
  actorUserId: string;
}) {
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${FLY_IMAGE_RELEASE_LOCK_KEY}, 0))`,
    );
    const release = await transaction.query.flyImageReleases.findFirst({
      where: eq(schema.flyImageReleases.id, input.releaseId),
    });
    if (!release) {
      throw new FlyImageReleaseError(
        "RELEASE_NOT_FOUND",
        "Fly image release not found.",
      );
    }
    if (release.status !== "candidate" || !release.migrationChanged) {
      throw new FlyImageReleaseError(
        "RELEASE_STATE_INVALID",
        "Only a migration-bearing candidate can complete the migration runbook.",
      );
    }
    const now = new Date();
    const [acknowledged] = await transaction
      .update(schema.flyImageReleases)
      .set({
        migrationApprovedByUserId: input.actorUserId,
        migrationApprovedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.flyImageReleases.id, release.id))
      .returning();
    return acknowledged;
  });
}

export async function retryFlyImageRelease(releaseId: string) {
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${FLY_IMAGE_RELEASE_LOCK_KEY}, 0))`,
    );
    const settings = await ensureSettings(transaction);
    const release = await transaction.query.flyImageReleases.findFirst({
      where: eq(schema.flyImageReleases.id, releaseId),
    });
    if (
      !release ||
      release.status !== "paused" ||
      settings.activeReleaseId !== release.id
    ) {
      throw new FlyImageReleaseError(
        "RELEASE_STATE_INVALID",
        "Only the currently paused Fly image release can be retried.",
      );
    }
    const components = await transaction
      .select()
      .from(schema.flyImageReleaseComponents)
      .where(eq(schema.flyImageReleaseComponents.releaseId, release.id));
    assertStoredReleaseAdmission(release, components);
    await transaction
      .update(schema.flyImageReleaseTargets)
      .set({
        status: "pending",
        stage: "retry.requested",
        failureCode: null,
        failureMessage: null,
        result: sql<Record<string, unknown>>`jsonb_build_object(
          'retryCount',
          COALESCE((${schema.flyImageReleaseTargets.result}->>'retryCount')::int, 0) + 1
        )`,
        startedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.flyImageReleaseTargets.releaseId, release.id),
          eq(schema.flyImageReleaseTargets.status, "failed"),
        ),
      );
    const [retried] = await transaction
      .update(schema.flyImageReleases)
      .set({
        status: "deploying",
        failureCode: null,
        failureMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.flyImageReleases.id, release.id))
      .returning();
    return retried;
  });
}

export async function createFlyImageRollback(input: {
  failedReleaseId: string;
  actorUserId: string;
}) {
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${FLY_IMAGE_RELEASE_LOCK_KEY}, 0))`,
    );
    const settings = await ensureSettings(transaction);
    if (!(settings.stableReleaseId && settings.canaryEnvironmentId)) {
      throw new FlyImageReleaseError(
        "RELEASE_STATE_INVALID",
        "A stable release and canary Environment are required for rollback.",
      );
    }
    const failed = await transaction.query.flyImageReleases.findFirst({
      where: eq(schema.flyImageReleases.id, input.failedReleaseId),
    });
    if (
      !failed ||
      failed.status !== "paused" ||
      settings.activeReleaseId !== failed.id
    ) {
      throw new FlyImageReleaseError(
        "RELEASE_STATE_INVALID",
        "Only the currently paused Fly image release can be rolled back.",
      );
    }
    const [stable, stableComponents, failedTargets] = await Promise.all([
      transaction.query.flyImageReleases.findFirst({
        where: eq(schema.flyImageReleases.id, settings.stableReleaseId),
      }),
      transaction
        .select()
        .from(schema.flyImageReleaseComponents)
        .where(
          eq(
            schema.flyImageReleaseComponents.releaseId,
            settings.stableReleaseId,
          ),
        ),
      transaction
        .select()
        .from(schema.flyImageReleaseTargets)
        .where(eq(schema.flyImageReleaseTargets.releaseId, failed.id)),
    ]);
    if (!stable || stableComponents.length !== FLY_IMAGE_ROLES.length) {
      throw new FlyImageReleaseError(
        "RELEASE_INCOMPLETE",
        "The stable Fly image release is incomplete.",
      );
    }
    assertRollbackCompatibility(stableComponents);
    const rollbackId = crypto.randomUUID();
    const now = new Date();
    const manifestDigest = digestCanonicalJson({
      trigger: "rollback",
      rollbackId,
      failedReleaseId: failed.id,
      stableReleaseId: stable.id,
    });
    await transaction.insert(schema.flyImageReleases).values({
      id: rollbackId,
      bundleRevision: stable.bundleRevision,
      manifestDigest,
      trigger: "rollback",
      status: "approved",
      migrationChanged: false,
      validation: stable.validation,
      environmentGatewayConfigVersion:
        ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION,
      baseReleaseId: stable.id,
      approvedByUserId: input.actorUserId,
      approvedAt: now,
    });
    await transaction.insert(schema.flyImageReleaseComponents).values(
      stableComponents.map((component) => ({
        releaseId: rollbackId,
        role: component.role,
        image: component.image,
        sourceRevision: component.sourceRevision,
        inputFingerprint: component.inputFingerprint,
        changed: true,
        smoke: component.smoke,
        environmentGatewayAcceptedVersions:
          component.environmentGatewayAcceptedVersions,
      })),
    );
    const affected = selectFlyImageRollbackTargets(failedTargets);
    await transaction.insert(schema.flyImageReleaseTargets).values([
      ...affected.globalRoles.map((role) => ({
        releaseId: rollbackId,
        targetKind: "global_app" as const,
        componentRole: role,
        targetKey: `global:${role}`,
        desiredImage: requireComponent(stableComponents, role).image,
      })),
      ...affected.environmentIds.map((environmentId) => ({
        releaseId: rollbackId,
        targetKind: "environment" as const,
        environmentId,
        targetKey: `environment:${environmentId}`,
      })),
    ]);
    await transaction
      .update(schema.flyImageReleases)
      .set({ status: "superseded", updatedAt: now })
      .where(eq(schema.flyImageReleases.id, failed.id));
    await transaction
      .update(schema.flyImageReleaseSettings)
      .set({ activeReleaseId: rollbackId, updatedAt: now })
      .where(eq(schema.flyImageReleaseSettings.id, "platform"));
    return transaction.query.flyImageReleases.findFirst({
      where: eq(schema.flyImageReleases.id, rollbackId),
    });
  });
}

function requireComponent(
  components: Array<typeof schema.flyImageReleaseComponents.$inferSelect>,
  role: FlyImageRole,
) {
  const component = components.find((candidate) => candidate.role === role);
  if (!component) {
    throw new FlyImageReleaseError(
      "RELEASE_INCOMPLETE",
      `Fly image release is missing '${role}'.`,
    );
  }
  return component;
}

function currentBuildRevision() {
  const revision = process.env.KESTREL_BUILD_REVISION?.trim().toLowerCase();
  if (!(revision && /^[a-f0-9]{40}$/u.test(revision))) {
    throw new FlyImageReleaseError(
      "RELEASE_BUILD_REVISION_MISMATCH",
      "The serving Kestrel build revision is unavailable.",
    );
  }
  return revision;
}

function assertCurrentBuildRevision(bundleRevision: string) {
  const revision = currentBuildRevision();
  if (bundleRevision !== revision) {
    throw new FlyImageReleaseError(
      "RELEASE_BUILD_REVISION_MISMATCH",
      `Release ${bundleRevision} does not match the serving Kestrel revision ${revision}.`,
    );
  }
}

function assertStoredReleaseAdmission(
  release: typeof schema.flyImageReleases.$inferSelect,
  components: Array<typeof schema.flyImageReleaseComponents.$inferSelect>,
) {
  const admission = evaluateStoredReleaseAdmission(release, components);
  if (!admission.ok) {
    throw new FlyImageReleaseError(admission.code, admission.message);
  }
}

function evaluateStoredReleaseAdmission(
  release: typeof schema.flyImageReleases.$inferSelect,
  components: Array<typeof schema.flyImageReleaseComponents.$inferSelect>,
) {
  const router = components.find(
    (component) => component.role === "environment-router",
  );
  return evaluateFlyImageReleaseAdmission({
    trigger: release.trigger,
    bundleRevision: release.bundleRevision,
    currentBuildRevision: currentBuildRevision(),
    currentProducedVersion: ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION,
    releaseProducedVersion: release.environmentGatewayConfigVersion,
    routerAcceptedVersions: router?.environmentGatewayAcceptedVersions ?? null,
  });
}

function assertRollbackCompatibility(
  components: Array<typeof schema.flyImageReleaseComponents.$inferSelect>,
) {
  const accepted = requireComponent(
    components,
    "environment-router",
  ).environmentGatewayAcceptedVersions;
  if (!accepted) {
    throw new FlyImageReleaseError(
      "RELEASE_COMPATIBILITY_UNKNOWN",
      "The stable Environment Router has no compatibility evidence. Recover forward with an exact candidate.",
    );
  }
  if (!accepted.includes(ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION)) {
    throw new FlyImageReleaseError(
      "RELEASE_COMPATIBILITY_BLOCKED",
      `The stable Environment Router does not accept gateway configuration version ${ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION}.`,
    );
  }
}

export async function getFlyImageReleaseExecutionAdmission(releaseId: string) {
  const [release, components] = await Promise.all([
    knowledgeDb.query.flyImageReleases.findFirst({
      where: eq(schema.flyImageReleases.id, releaseId),
    }),
    knowledgeDb
      .select()
      .from(schema.flyImageReleaseComponents)
      .where(eq(schema.flyImageReleaseComponents.releaseId, releaseId)),
  ]);
  if (!release) {
    return {
      ok: false as const,
      code: "RELEASE_NOT_FOUND",
      message: "Fly image release not found.",
    };
  }
  return evaluateStoredReleaseAdmission(release, components);
}

async function ensureSettings(transaction: KnowledgeTransaction) {
  const [settings] = await transaction
    .insert(schema.flyImageReleaseSettings)
    .values({ id: "platform" })
    .onConflictDoNothing()
    .returning();
  return (
    settings ??
    (await transaction.query.flyImageReleaseSettings.findFirst({
      where: eq(schema.flyImageReleaseSettings.id, "platform"),
    }))!
  );
}

async function lockFlyImageReleases(transaction: KnowledgeTransaction) {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${FLY_IMAGE_RELEASE_LOCK_KEY}, 0))`,
  );
}

async function releaseChangesEnvironmentImages(
  transaction: KnowledgeTransaction,
  releaseId: string,
) {
  const component = await transaction.query.flyImageReleaseComponents.findFirst(
    {
      where: and(
        eq(schema.flyImageReleaseComponents.releaseId, releaseId),
        eq(schema.flyImageReleaseComponents.changed, true),
        inArray(schema.flyImageReleaseComponents.role, [
          "workspace-runtime",
          "environment-router",
        ]),
      ),
      columns: { id: true },
    },
  );
  return Boolean(component);
}

async function insertEnvironmentTargets(
  transaction: KnowledgeTransaction,
  releaseId: string,
  environmentIds: string[],
) {
  if (!environmentIds.length) return;
  await transaction
    .insert(schema.flyImageReleaseTargets)
    .values(
      environmentIds.map((environmentId) => ({
        releaseId,
        targetKind: "environment" as const,
        environmentId,
        targetKey: `environment:${environmentId}`,
      })),
    )
    .onConflictDoNothing();
}
