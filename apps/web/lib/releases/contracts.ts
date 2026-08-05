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

export const immutableFlyImageSchema = z
  .string()
  .trim()
  .regex(
    /^registry\.fly\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u,
    "Fly image must use an immutable registry.fly.io sha256 digest.",
  );

const gitRevisionSchema = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{40}$/u, "Release revision must be a full Git SHA.");

const sha256Schema = z
  .string()
  .trim()
  .regex(/^sha256:[a-f0-9]{64}$/u, "Expected a sha256 digest.");

export const flyImageReleaseComponentSchema = z.object({
  role: flyImageRoleSchema,
  image: immutableFlyImageSchema,
  sourceRevision: gitRevisionSchema,
  inputFingerprint: sha256Schema,
  smoke: z.object({
    status: z.literal("passed"),
    command: z.string().trim().min(1).max(500),
    completedAt: z.string().datetime(),
  }),
});

export const flyImageReleaseManifestV1Schema = z
  .object({
    version: z.literal(1),
    controllerContractRevision: z.number().int().positive(),
    bundleRevision: gitRevisionSchema,
    trigger: z.enum(["main", "scheduled", "manual"]),
    migrationChanged: z.boolean(),
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

export type FlyImageReleaseManifestV1 = z.infer<
  typeof flyImageReleaseManifestV1Schema
>;

const ROLE_REGISTRY_APPS: Record<FlyImageRole, string> = {
  "workspace-runtime": "kestrel-one-runner",
  "environment-router": "kestrel-one-runner",
  "preview-edge": "kestrel-preview-edge",
  "turn-worker": "kestrel-one-turn-worker",
  "runpod-worker": "kestrel-one-runpod-worker",
};

export function assertFlyImageMatchesRole(
  role: FlyImageRole,
  image: string,
): void {
  const parsed = immutableFlyImageSchema.parse(image);
  const expectedPrefix = `registry.fly.io/${ROLE_REGISTRY_APPS[role]}@`;
  if (!parsed.startsWith(expectedPrefix)) {
    throw new Error(
      `Release image for '${role}' must use registry app '${ROLE_REGISTRY_APPS[role]}'.`,
    );
  }
}

export function isFlyImageReleaseMachineVerified(
  machine: { state: string; image?: string | undefined } | null,
  requestedImage: string,
) {
  if (machine?.state !== "started") return false;
  const currentDigest = machine.image?.match(/sha256:[a-f0-9]{64}$/u)?.[0];
  const requestedDigest = requestedImage.match(/sha256:[a-f0-9]{64}$/u)?.[0];
  return Boolean(
    currentDigest && requestedDigest && currentDigest === requestedDigest,
  );
}
