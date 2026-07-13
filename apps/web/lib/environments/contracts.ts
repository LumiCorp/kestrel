import { z } from "zod";

export const ENVIRONMENT_RUNTIME_TEMPLATE = "kestrel-standard-v1" as const;
export const ENVIRONMENT_IDLE_TIMEOUT_MINUTES = 15;
export const WORKSPACE_BACKUP_RETENTION_DAYS = 30;

export const environmentStatusSchema = z.enum([
  "requested",
  "provisioning",
  "ready",
  "degraded",
  "deleting",
  "deleted",
  "failed",
]);
export type EnvironmentStatus = z.infer<typeof environmentStatusSchema>;

export const workspaceStatusSchema = z.enum([
  "requested",
  "provisioning",
  "stopped",
  "starting",
  "ready",
  "stopping",
  "degraded",
  "deleting",
  "deleted",
  "failed",
]);
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;

export const environmentActivationStageSchema = z.enum([
  "environment.activation.requested",
  "environment.machine.starting",
  "environment.runtime.connecting",
  "environment.workspace.mounting",
  "environment.health.checking",
  "environment.activation.ready",
  "environment.activation.failed",
]);
export type EnvironmentActivationStage = z.infer<
  typeof environmentActivationStageSchema
>;

export const environmentOperationTypeSchema = z.enum([
  "environment.provision",
  "environment.delete",
  "workspace.provision",
  "workspace.start",
  "workspace.stop",
  "workspace.rebuild",
  "workspace.delete",
  "workspace.backup",
  "workspace.restore",
  "workspace.reconcile",
]);
export type EnvironmentOperationType = z.infer<
  typeof environmentOperationTypeSchema
>;

export const createEnvironmentInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(63)
    .regex(/^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/u)
    .optional(),
  region: z
    .string()
    .trim()
    .min(2)
    .max(16)
    .regex(/^[a-z0-9-]+$/u),
  isDefault: z.boolean().optional(),
});
export type CreateEnvironmentInput = z.infer<
  typeof createEnvironmentInputSchema
>;

const blankWorkspaceSourceSchema = z.object({
  type: z.literal("blank"),
});

const githubWorkspaceSourceSchema = z.object({
  type: z.literal("github"),
  resourceId: z.string().uuid(),
});

export const workspaceSourceSchema = z.discriminatedUnion("type", [
  blankWorkspaceSourceSchema,
  githubWorkspaceSourceSchema,
]);
export type WorkspaceSource = z.infer<typeof workspaceSourceSchema>;

export const createProjectWorkspaceInputSchema = z.object({
  environmentId: z.string().uuid(),
  projectId: z.string().uuid(),
  source: workspaceSourceSchema,
});

export const bindProjectEnvironmentInputSchema = z.object({
  environmentId: z.string().uuid(),
});

export const environmentActivationEventSchema = z.object({
  operationId: z.string().uuid(),
  environmentId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  threadId: z.string().uuid(),
  stage: environmentActivationStageSchema,
  occurredAt: z.string().datetime(),
  detail: z.string().trim().min(1).max(500).optional(),
  errorCode: z.string().trim().min(1).max(120).optional(),
});
export type EnvironmentActivationEvent = z.infer<
  typeof environmentActivationEventSchema
>;

const ENVIRONMENT_TRANSITIONS: Record<
  EnvironmentStatus,
  ReadonlySet<EnvironmentStatus>
> = {
  requested: new Set(["provisioning", "deleting", "failed"]),
  provisioning: new Set(["ready", "deleting", "failed"]),
  ready: new Set(["degraded", "deleting"]),
  degraded: new Set(["ready", "deleting", "failed"]),
  deleting: new Set(["deleted", "failed"]),
  deleted: new Set(),
  failed: new Set(["provisioning", "deleting"]),
};

const WORKSPACE_TRANSITIONS: Record<
  WorkspaceStatus,
  ReadonlySet<WorkspaceStatus>
> = {
  requested: new Set(["provisioning", "deleting", "failed"]),
  provisioning: new Set(["stopped", "starting", "ready", "deleting", "failed"]),
  stopped: new Set(["starting", "deleting"]),
  starting: new Set(["ready", "stopped", "degraded", "failed"]),
  ready: new Set(["starting", "stopping", "degraded", "deleting"]),
  stopping: new Set(["stopped", "degraded", "failed"]),
  degraded: new Set(["starting", "ready", "stopping", "deleting", "failed"]),
  deleting: new Set(["deleted", "failed"]),
  deleted: new Set(),
  failed: new Set(["provisioning", "starting", "deleting"]),
};

export class EnvironmentContractError extends Error {
  readonly code:
    | "ENVIRONMENT_INVALID_TRANSITION"
    | "WORKSPACE_INVALID_TRANSITION"
    | "ENVIRONMENT_NOT_FOUND"
    | "ENVIRONMENT_UNAVAILABLE"
    | "ENVIRONMENT_BINDING_NOT_FOUND"
    | "ENVIRONMENT_FORBIDDEN"
    | "WORKSPACE_SOURCE_FORBIDDEN";

  constructor(code: EnvironmentContractError["code"], message: string) {
    super(message);
    this.name = "EnvironmentContractError";
    this.code = code;
  }
}

export function assertEnvironmentTransition(
  current: EnvironmentStatus,
  next: EnvironmentStatus
): void {
  if (current === next || ENVIRONMENT_TRANSITIONS[current].has(next)) {
    return;
  }
  throw new EnvironmentContractError(
    "ENVIRONMENT_INVALID_TRANSITION",
    `Environment cannot transition from '${current}' to '${next}'.`
  );
}

export function assertWorkspaceTransition(
  current: WorkspaceStatus,
  next: WorkspaceStatus
): void {
  if (current === next || WORKSPACE_TRANSITIONS[current].has(next)) {
    return;
  }
  throw new EnvironmentContractError(
    "WORKSPACE_INVALID_TRANSITION",
    `Workspace cannot transition from '${current}' to '${next}'.`
  );
}

export function toEnvironmentSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63)
    .replace(/-+$/u, "");
  if (!(slug && /^[a-z]/u.test(slug))) {
    throw new EnvironmentContractError(
      "ENVIRONMENT_UNAVAILABLE",
      "Environment name must contain a letter and produce a valid slug."
    );
  }
  return slug;
}

export function workspaceProvisionIdempotencyKey(workspaceId: string): string {
  return `workspace.provision:${workspaceId}`;
}

export function environmentProvisionIdempotencyKey(
  environmentId: string
): string {
  return `environment.provision:${environmentId}`;
}
