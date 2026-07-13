import path from "node:path";
import {
  verifyEnvironmentExecutionTicket,
  type EnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";

export function authorizeWorkspaceRequest(input: {
  authorization: string | undefined;
  publicKey: string;
  workspaceId: string;
  organizationId: string;
  environmentId: string;
  machineId: string;
  now?: number;
}): EnvironmentExecutionTicket {
  const match = input.authorization?.match(/^Bearer ([^\s]+)$/u);
  if (!match?.[1]) throw new WorkspaceRequestError(401, "WORKSPACE_TICKET_REQUIRED");
  let ticket: EnvironmentExecutionTicket;
  try {
    ticket = verifyEnvironmentExecutionTicket({
      token: match[1],
      publicKey: input.publicKey,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  } catch {
    throw new WorkspaceRequestError(401, "WORKSPACE_TICKET_INVALID");
  }
  if (
    ticket.workspaceId !== input.workspaceId ||
    ticket.organizationId !== input.organizationId ||
    ticket.environmentId !== input.environmentId ||
    ticket.flyMachineId !== input.machineId
  ) {
    throw new WorkspaceRequestError(403, "WORKSPACE_SCOPE_MISMATCH");
  }
  return ticket;
}

export function resolveWorkspacePath(root: string, requested: string) {
  if (requested.includes("\0")) {
    throw new WorkspaceRequestError(400, "WORKSPACE_PATH_INVALID");
  }
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, requested.replace(/^\/+/, ""));
  const relative = path.relative(absoluteRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceRequestError(403, "WORKSPACE_PATH_FORBIDDEN");
  }
  return absolute;
}

export class WorkspaceRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "WorkspaceRequestError";
  }
}
