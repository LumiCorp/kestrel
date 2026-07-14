import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const WORKSPACE_IDLE_NOTIFICATION_VERSION =
  "workspace-idle-notification-v1" as const;

export const workspaceIdleNotificationSchema = z.object({
  version: z.literal(WORKSPACE_IDLE_NOTIFICATION_VERSION),
  organizationId: z.string().trim().min(1).max(255),
  environmentId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  machineId: z.string().trim().min(1).max(128),
  lastActivityAt: z.string().datetime(),
});

export type WorkspaceIdleNotification = z.infer<
  typeof workspaceIdleNotificationSchema
>;

export class WorkspaceIdleNotificationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "WorkspaceIdleNotificationError";
    this.code = code;
    this.status = status;
  }
}

export function authorizeWorkspaceIdleNotification(input: {
  authorization: string | null;
  expectedToken: string | undefined;
}) {
  const expectedToken = input.expectedToken?.trim();
  if (!expectedToken) {
    throw new WorkspaceIdleNotificationError(
      "WORKSPACE_IDLE_AUTH_NOT_CONFIGURED",
      "Workspace idle authentication is not configured.",
      503
    );
  }
  const prefix = "Bearer ";
  if (!input.authorization?.startsWith(prefix)) {
    throw new WorkspaceIdleNotificationError(
      "WORKSPACE_IDLE_UNAUTHORIZED",
      "Workspace idle authorization is required.",
      401
    );
  }
  const supplied = Buffer.from(
    input.authorization.slice(prefix.length),
    "utf8"
  );
  const expected = Buffer.from(expectedToken, "utf8");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new WorkspaceIdleNotificationError(
      "WORKSPACE_IDLE_UNAUTHORIZED",
      "Workspace idle authorization is invalid.",
      401
    );
  }
}
