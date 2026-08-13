import { z } from "zod";

export const FLY_IMAGE_ROLES = [
  "workspace-runtime",
  "environment-router",
  "preview-edge",
  "turn-worker",
  "runpod-worker",
] as const;

export const flyImageRoleSchema = z.enum(FLY_IMAGE_ROLES);
export type FlyImageRole = z.infer<typeof flyImageRoleSchema>;

export const flyImageReleaseStatusSchema = z.enum([
  "candidate",
  "approved",
  "deploying",
  "paused",
  "completed",
  "superseded",
]);
export type FlyImageReleaseStatus = z.infer<typeof flyImageReleaseStatusSchema>;

export const flyImageReleaseCandidatePublicationResponseSchema = z
  .object({
    release: z
      .object({
        id: z.string().uuid(),
        status: z.literal("candidate"),
      })
      .strict(),
  })
  .strict();

export type FlyImageReleaseAdmissionFailureCode =
  | "RELEASE_BUILD_REVISION_MISMATCH"
  | "RELEASE_COMPATIBILITY_BLOCKED"
  | "RELEASE_COMPATIBILITY_UNKNOWN";

export function evaluateFlyImageForwardRecoveryEligibility(input: {
  activeStatus: string | null;
  admission: { ok: true } | { ok: false; code: string; message: string };
  migrationReady: boolean;
  canaryValid: boolean;
}): { ok: true } | { ok: false; code: string; message: string } {
  if (input.activeStatus !== "paused") {
    return {
      ok: false,
      code: "RELEASE_STATE_INVALID",
      message: "Forward recovery requires an active paused release.",
    };
  }
  if (!input.admission.ok) return input.admission;
  if (!input.migrationReady) {
    return {
      ok: false,
      code: "RELEASE_MIGRATION_BLOCKED",
      message: "Complete the migration runbook before forward recovery.",
    };
  }
  if (!input.canaryValid) {
    return {
      ok: false,
      code: "RELEASE_CANARY_REQUIRED",
      message: "Choose an active Fly Environment canary before recovery.",
    };
  }
  return { ok: true };
}

export function evaluateFlyImageMigrationAcknowledgementEligibility(input: {
  status: string;
  migrationChanged: boolean;
  migrationApprovedAt: Date | null;
}): { ok: true } | { ok: false; code: string; message: string } {
  if (input.status !== "candidate" || !input.migrationChanged) {
    return {
      ok: false,
      code: "RELEASE_STATE_INVALID",
      message:
        "Only a migration-bearing candidate can complete the migration runbook.",
    };
  }
  if (input.migrationApprovedAt) {
    return {
      ok: false,
      code: "RELEASE_MIGRATION_ALREADY_ACKNOWLEDGED",
      message: "The migration runbook is already complete.",
    };
  }
  return { ok: true };
}

export function countResolvedFlyImageReleaseTargets(
  targets: Array<{ status: string }>,
) {
  return targets.filter((target) =>
    ["completed", "configured_unverified"].includes(target.status),
  ).length;
}

export function evaluateFlyImageReleaseAdmission(input: {
  trigger: string;
  bundleRevision: string;
  currentBuildRevision: string;
  currentProducedVersion: number;
  releaseProducedVersion: number | null;
  routerAcceptedVersions: number[] | null;
}):
  | { ok: true }
  | {
      ok: false;
      code: FlyImageReleaseAdmissionFailureCode;
      message: string;
    } {
  if (
    input.trigger !== "rollback" &&
    input.bundleRevision !== input.currentBuildRevision
  ) {
    return {
      ok: false,
      code: "RELEASE_BUILD_REVISION_MISMATCH",
      message: "Release revision does not match the serving Kestrel revision.",
    };
  }
  if (
    input.releaseProducedVersion === null ||
    input.routerAcceptedVersions === null
  ) {
    return {
      ok: false,
      code: "RELEASE_COMPATIBILITY_UNKNOWN",
      message: "Release gateway compatibility evidence is unavailable.",
    };
  }
  if (
    input.trigger !== "rollback" &&
    input.releaseProducedVersion !== input.currentProducedVersion
  ) {
    return {
      ok: false,
      code: "RELEASE_COMPATIBILITY_BLOCKED",
      message:
        "Release producer version does not match the serving control plane.",
    };
  }
  if (!input.routerAcceptedVersions.includes(input.currentProducedVersion)) {
    return {
      ok: false,
      code: "RELEASE_COMPATIBILITY_BLOCKED",
      message:
        "The release Environment Router does not accept the serving gateway configuration version.",
    };
  }
  return { ok: true };
}

export function selectFlyImageRollbackTargets(
  targets: Array<{
    targetKind: string;
    componentRole: string | null;
    environmentId: string | null;
    status: string;
    startedAt: Date | null;
    result: unknown;
  }>,
) {
  const globalRoles = new Set<FlyImageRole>();
  const environmentIds = new Set<string>();
  for (const target of targets) {
    if (
      target.targetKind === "global_app" &&
      target.componentRole &&
      FLY_IMAGE_ROLES.some((role) => role === target.componentRole) &&
      target.startedAt
    ) {
      globalRoles.add(target.componentRole as FlyImageRole);
    }
    const result =
      target.result && typeof target.result === "object"
        ? (target.result as Record<string, unknown>)
        : null;
    if (
      target.targetKind === "environment" &&
      target.environmentId &&
      (target.status === "completed" || typeof result?.operationId === "string")
    ) {
      environmentIds.add(target.environmentId);
    }
  }
  return {
    globalRoles: [...globalRoles],
    environmentIds: [...environmentIds],
  };
}

export const flyImageReleaseTargetStatusSchema = z.enum([
  "pending",
  "draining",
  "applying",
  "configured_unverified",
  "verifying",
  "completed",
  "failed",
]);
export type FlyImageReleaseTargetStatus = z.infer<
  typeof flyImageReleaseTargetStatusSchema
>;

export const FLY_IMAGE_RELEASE_DEPLOYABLE_ENVIRONMENT_STATUSES = [
  "ready",
  "degraded",
] as const;
export const FLY_IMAGE_RELEASE_WAITING_ENVIRONMENT_STATUSES = [
  "requested",
  "provisioning",
] as const;
export const FLY_IMAGE_RELEASE_TARGETABLE_ENVIRONMENT_STATUSES = [
  ...FLY_IMAGE_RELEASE_WAITING_ENVIRONMENT_STATUSES,
  ...FLY_IMAGE_RELEASE_DEPLOYABLE_ENVIRONMENT_STATUSES,
] as const;

export function classifyFlyImageReleaseEnvironment(input: {
  status: string | null;
  archived: boolean;
}): "deployable" | "waiting" | "skip" {
  if (input.archived || !input.status) return "skip";
  if (
    FLY_IMAGE_RELEASE_DEPLOYABLE_ENVIRONMENT_STATUSES.some(
      (status) => status === input.status,
    )
  ) {
    return "deployable";
  }
  if (
    FLY_IMAGE_RELEASE_WAITING_ENVIRONMENT_STATUSES.some(
      (status) => status === input.status,
    )
  ) {
    return "waiting";
  }
  return "skip";
}

export const immutableOciImageSchema = z
  .string()
  .trim()
  .regex(
    /^(?:registry\.fly\.io|ghcr\.io)\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u,
    "Image must use an immutable supported OCI repository and sha256 digest.",
  );

export const immutableFlyImageSchema = immutableOciImageSchema;

const gitRevisionSchema = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{40}$/u, "Release revision must be a full Git SHA.");

const sha256Schema = z
  .string()
  .trim()
  .regex(/^sha256:[a-f0-9]{64}$/u, "Expected a sha256 digest.");

const acceptedGatewayVersionsSchema = z
  .array(z.number().int().positive())
  .min(1)
  .max(10)
  .superRefine((versions, context) => {
    for (let index = 0; index < versions.length; index += 1) {
      if (index > 0 && versions[index - 1]! >= versions[index]!) {
        context.addIssue({
          code: "custom",
          message:
            "Accepted gateway versions must be unique and sorted ascending.",
        });
        return;
      }
    }
  });

export const flyImageReleaseComponentSchema = z
  .object({
    role: flyImageRoleSchema,
    image: immutableOciImageSchema,
    sourceRevision: gitRevisionSchema,
    inputFingerprint: sha256Schema,
    smoke: z.object({
      status: z.literal("passed"),
      command: z.string().trim().min(1).max(500),
      completedAt: z.string().datetime(),
    }),
    environmentGateway: z
      .object({ acceptedVersions: acceptedGatewayVersionsSchema })
      .optional(),
  })
  .superRefine((component, context) => {
    try {
      assertFlyImageMatchesRole(component.role, component.image);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid role image.",
        path: ["image"],
      });
    }
    if (
      component.role === "environment-router" &&
      !component.environmentGateway
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The environment-router component must declare accepted gateway versions.",
        path: ["environmentGateway"],
      });
    }
    if (
      component.role !== "environment-router" &&
      component.environmentGateway
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Only the environment-router component may declare gateway compatibility.",
        path: ["environmentGateway"],
      });
    }
  });

export const flyImageReleaseManifestV2Schema = z
  .object({
    version: z.literal(2),
    controllerContractRevision: z.number().int().positive(),
    bundleRevision: gitRevisionSchema,
    trigger: z.enum(["main", "scheduled", "manual"]),
    migrationChanged: z.boolean(),
    environmentGateway: z.object({
      producedVersion: z.number().int().positive(),
    }),
    validation: z.object({
      status: z.literal("passed"),
      commands: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
      completedAt: z.string().datetime(),
    }),
    components: z.array(flyImageReleaseComponentSchema).min(1).max(5),
  })
  .superRefine((manifest, context) => {
    const roles = new Set<FlyImageRole>();
    for (const component of manifest.components) {
      if (roles.has(component.role)) {
        context.addIssue({
          code: "custom",
          message: `Release component '${component.role}' is duplicated.`,
          path: ["components"],
        });
      }
      roles.add(component.role);
      if (component.sourceRevision !== manifest.bundleRevision) {
        context.addIssue({
          code: "custom",
          message: `Changed component '${component.role}' must identify the bundle revision.`,
          path: ["components"],
        });
      }
    }
  });

export type FlyImageReleaseManifestV2 = z.infer<
  typeof flyImageReleaseManifestV2Schema
>;

export const ROLE_IMAGE_REPOSITORIES: Record<FlyImageRole, string> = {
  "workspace-runtime": "ghcr.io/lumicorp/kestrel-workspace-runtime",
  "environment-router": "ghcr.io/lumicorp/kestrel-environment-router",
  "preview-edge": "registry.fly.io/kestrel-preview-edge",
  "turn-worker": "registry.fly.io/kestrel-one-turn-worker",
  "runpod-worker": "registry.fly.io/kestrel-one-runpod-worker",
};

export function assertFlyImageMatchesRole(
  role: FlyImageRole,
  image: string,
): void {
  const parsed = immutableOciImageSchema.parse(image);
  const expectedRepository = ROLE_IMAGE_REPOSITORIES[role];
  const expectedPrefix = `${expectedRepository}@`;
  if (!parsed.startsWith(expectedPrefix)) {
    throw new Error(
      `Release image for '${role}' must use repository '${expectedRepository}'.`,
    );
  }
}

export function isFlyImageReleaseMachineVerified(
  machine: { state: string; image?: string | undefined } | null,
  requestedImage: string,
  expectedState: "started" | "stopped",
) {
  if (machine?.state !== expectedState) return false;
  const currentDigest = machine.image?.match(/sha256:[a-f0-9]{64}$/u)?.[0];
  const requestedDigest = requestedImage.match(/sha256:[a-f0-9]{64}$/u)?.[0];
  return Boolean(
    currentDigest && requestedDigest && currentDigest === requestedDigest,
  );
}
