import path from "node:path";
import { realpath } from "node:fs/promises";
import {
  EnvironmentTicketError,
  getFlyEnvironmentExecutionTarget,
  getGatewayEnvironmentExecutionTarget,
  verifyEnvironmentExecutionTicket,
  type EnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";

export function authorizeWorkspaceRequest(input: {
  authorization: string | undefined;
  publicKey: string;
  workspaceId: string;
  organizationId: string;
  environmentId: string;
  machineId?: string | undefined;
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
  } catch (error) {
    throw new WorkspaceRequestError(
      401,
      error instanceof EnvironmentTicketError && error.code === "TICKET_EXPIRED"
        ? "EXECUTION_AUTH_EXPIRED"
        : "WORKSPACE_TICKET_INVALID",
    );
  }
  const target = getFlyEnvironmentExecutionTarget(ticket);
  const gateway = getGatewayEnvironmentExecutionTarget(ticket);
  if (
    ticket.workspaceId !== input.workspaceId ||
    ticket.organizationId !== input.organizationId ||
    ticket.environmentId !== input.environmentId ||
    !(gateway || (target && input.machineId && target.machineId === input.machineId))
  ) {
    throw new WorkspaceRequestError(403, "WORKSPACE_SCOPE_MISMATCH");
  }
  return ticket;
}

export async function resolveWorkspacePath(root: string, requested: string): Promise<string> {
  if (requested.includes("\0")) {
    throw new WorkspaceRequestError(400, "WORKSPACE_PATH_INVALID");
  }
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, requested.replace(/^\/+/, ""));
  const relative = path.relative(absoluteRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceRequestError(403, "WORKSPACE_PATH_FORBIDDEN");
  }
  const canonicalRoot = await realpath(absoluteRoot);
  const nearest = await findNearestExistingAncestor(absolute);
  assertWithinWorkspace(canonicalRoot, nearest.realPath);
  const unresolvedSuffix = path.relative(nearest.path, absolute);
  const canonicalTarget = path.resolve(nearest.realPath, unresolvedSuffix);
  assertWithinWorkspace(canonicalRoot, canonicalTarget);
  return canonicalTarget;
}

export class WorkspaceRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "WorkspaceRequestError";
  }
}

async function findNearestExistingAncestor(
  candidate: string,
): Promise<{ path: string; realPath: string }> {
  let current = path.resolve(candidate);
  while (true) {
    try {
      return { path: current, realPath: await realpath(current) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new WorkspaceRequestError(403, "WORKSPACE_PATH_FORBIDDEN");
    }
    current = parent;
  }
}

function assertWithinWorkspace(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceRequestError(403, "WORKSPACE_PATH_FORBIDDEN");
  }
}
