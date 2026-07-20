import { auth } from "@/lib/auth";
import type { Session } from "@/lib/auth-types";
import { ensureOrganizationDefaultEnvironment } from "@/lib/environments/store";
import { knowledgeDb } from "@/lib/knowledge/db";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";
import { ensurePersonalOrganizationByUserId } from "@/lib/personal-workspace";

export type MobileSessionErrorCode =
  | "UNAUTHORIZED"
  | "ORGANIZATION_MEMBERSHIP_REQUIRED"
  | "ORGANIZATION_CONFIGURATION_ERROR";

export class MobileSessionError extends Error {
  readonly code: MobileSessionErrorCode;

  constructor(code: MobileSessionErrorCode, message: string) {
    super(message);
    this.name = "MobileSessionError";
    this.code = code;
  }
}

export type MobileSessionDependencies = {
  getSession(input: { headers: Headers }): Promise<Session | null>;
  findMembership(input: {
    organizationId: string;
    userId: string;
  }): Promise<{ id: string } | null>;
  ensurePersonalOrganization(userId: string): Promise<{ id: string }>;
  ensureDefaultEnvironment(input: {
    organizationId: string;
    userId: string;
  }): Promise<{ operation?: { id: string } | null }>;
  enqueueEnvironmentOperation(operationId: string): Promise<unknown>;
};

const dependencies: MobileSessionDependencies = {
  getSession: async ({ headers }) =>
    (await auth.api.getSession({ headers })) as Session | null,
  findMembership: async ({ organizationId, userId }) => {
    const member = await knowledgeDb.query.members.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.organizationId, organizationId), eq(table.userId, userId)),
      columns: { id: true },
    });
    return member ?? null;
  },
  ensurePersonalOrganization: ensurePersonalOrganizationByUserId,
  ensureDefaultEnvironment: ensureOrganizationDefaultEnvironment,
  enqueueEnvironmentOperation,
};

function requestedOrganizationId(request: Request) {
  return (
    request.headers.get("x-active-organization-id")?.trim() ||
    request.headers.get("x-organization-id")?.trim() ||
    null
  );
}

function sessionOrganizationId(session: Session) {
  return (
    (session as Session & {
      session?: { activeOrganizationId?: string | null } | null;
    }).session?.activeOrganizationId ?? null
  );
}

export async function resolveMobileSession(
  request: Request,
  input: MobileSessionDependencies
) {
  const session = await input.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    throw new MobileSessionError("UNAUTHORIZED", "Mobile session required");
  }

  const explicitlyRequestedOrganizationId = requestedOrganizationId(request);
  const existingOrganizationId =
    explicitlyRequestedOrganizationId ?? sessionOrganizationId(session);

  let organizationId: string;
  if (existingOrganizationId) {
    let membership: { id: string } | null;
    try {
      membership = await input.findMembership({
        organizationId: existingOrganizationId,
        userId: session.user.id,
      });
    } catch {
      throw new MobileSessionError(
        "ORGANIZATION_CONFIGURATION_ERROR",
        "Unable to resolve organization membership"
      );
    }
    if (!membership) {
      throw new MobileSessionError(
        "ORGANIZATION_MEMBERSHIP_REQUIRED",
        "Organization membership required"
      );
    }
    organizationId = existingOrganizationId;
  } else {
    try {
      organizationId = (
        await input.ensurePersonalOrganization(session.user.id)
      ).id;
    } catch {
      throw new MobileSessionError(
        "ORGANIZATION_CONFIGURATION_ERROR",
        "Unable to configure organization"
      );
    }
  }

  try {
    const ensuredEnvironment = await input.ensureDefaultEnvironment({
      organizationId,
      userId: session.user.id,
    });
    if (ensuredEnvironment.operation) {
      await input.enqueueEnvironmentOperation(ensuredEnvironment.operation.id);
    }
  } catch {
    throw new MobileSessionError(
      "ORGANIZATION_CONFIGURATION_ERROR",
      "Unable to configure organization environment"
    );
  }

  return { session, organizationId };
}

export function mobileSessionFailureFacts(request: Request, error: unknown) {
  const code =
    error instanceof MobileSessionError ? error.code : "INTERNAL_ERROR";
  const status =
    code === "UNAUTHORIZED"
      ? 401
      : code === "ORGANIZATION_MEMBERSHIP_REQUIRED"
        ? 403
        : 503;

  return {
    path: new URL(request.url).pathname,
    status,
    code,
    hasCookie: request.headers.has("cookie"),
    hasAuthorization: request.headers.has("authorization"),
    hasApiKey: request.headers.has("x-api-key"),
  };
}

export async function requireMobileSession(request: Request) {
  try {
    return await resolveMobileSession(request, dependencies);
  } catch (error) {
    console.warn(
      "[mobile-session] request rejected",
      mobileSessionFailureFacts(request, error)
    );
    throw error;
  }
}
