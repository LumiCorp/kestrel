import { z } from "zod";

export const sourceRevisionSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/u, "Expected a full Git revision.");

export const immutableFlyImageSchema = z
  .string()
  .regex(
    /^registry\.fly\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u,
    "Expected an immutable Fly image digest.",
  );

export const runtimeRolloutContractSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["rolling", "maintenance"]),
    workspaceDataMigrationRevision: z.string().trim().min(1).nullable(),
  })
  .superRefine((contract, context) => {
    if (
      contract.workspaceDataMigrationRevision !== null &&
      contract.mode !== "maintenance"
    ) {
      context.addIssue({
        code: "custom",
        path: ["workspaceDataMigrationRevision"],
        message: "Workspace data migrations require maintenance mode.",
      });
    }
  });

const smokeEvidenceSchema = z.object({
  status: z.literal("passed"),
  command: z.string().trim().min(1),
  completedAt: z.string().datetime(),
});

export const platformImagePublicationSchema = z.object({
  sourceRevision: sourceRevisionSchema,
  routerImage: immutableFlyImageSchema,
  runtimeImage: immutableFlyImageSchema,
  rollout: runtimeRolloutContractSchema,
  smoke: z
    .object({
      router: smokeEvidenceSchema.optional(),
      runtime: smokeEvidenceSchema.optional(),
    })
    .refine((smoke) => smoke.router || smoke.runtime, {
      message: "At least one changed platform image must include smoke evidence.",
    }),
  activateMaintenance: z.boolean().optional().default(false),
});

export type PlatformImagePublication = z.infer<
  typeof platformImagePublicationSchema
>;

export const platformRuntimeStatusSchema = z.enum([
  "ready",
  "canary",
  "fanout",
  "degraded",
  "blocked",
  "rejected",
  "maintenance_pending",
  "maintenance",
]);

export const runtimeDeploymentActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("retry_resource"),
    environmentId: z.string().uuid(),
    workspaceId: z.string().uuid().optional(),
  }),
  z.object({ action: z.literal("retry_canary") }),
  z.object({
    action: z.literal("rollback_resource"),
    environmentId: z.string().uuid(),
    workspaceId: z.string().uuid().optional(),
  }),
]);
