import { headers } from "next/headers";
import { forbidden, redirect, unauthorized } from "next/navigation";
import { auth as betterAuth } from "@/lib/auth";
import type { OrganizationSnapshot, Session } from "@/lib/auth-types";
import { ensureOrganizationDefaultEnvironment } from "@/lib/environments/store";
import { knowledgeDb } from "@/lib/knowledge/db";
import { canManageOrganization } from "@/lib/knowledge/organization-access";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";
import { requireMobileSession } from "@/lib/mobile/session";
import { ensurePersonalOrganizationByUserId } from "@/lib/personal-workspace";
import { shouldDeferPersonalEnvironmentCreation } from "@/lib/signup-access-codes";
import { getSignupOnboardingState } from "@/lib/signup-onboarding";

type SessionLike = Session | null;
type SessionWithOrg = SessionLike & {
  session?: {
    activeOrganizationId?: string | null;
  } | null;
};

async function getServerSessionStrict(): Promise<Session | null> {
  return (await betterAuth.api.getSession({
    headers: await headers(),
  })) as Session | null;
}

export function parseAdminUserIds(): Set<string> {
  const raw = process.env.ADMIN_USER_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function isAdminUser(
  user: { id?: string | null; role?: string | null } | null | undefined,
) {
  if (!(user?.id || user?.role)) {
    return false;
  }

  const adminIds = parseAdminUserIds();
  return user?.role === "admin" || (user?.id ? adminIds.has(user.id) : false);
}

export async function requireSession(request?: Request) {
  if (request && new URL(request.url).pathname.startsWith("/api/mobile/v2/")) {
    return (await requireMobileSession(request)).session;
  }
  const session = await getServerSessionStrict();
  if (!session?.user?.id) {
    throw Object.assign(new Error("Unauthorized"), { code: "UNAUTHORIZED" });
  }
  return session;
}

export function getActiveOrganizationId(session: SessionLike): string | null {
  return (
    (session as SessionWithOrg | null)?.session?.activeOrganizationId ?? null
  );
}

async function getRequestedOrganizationId(
  session: NonNullable<SessionLike>,
): Promise<string | null> {
  const headerStore = await headers();
  const requestedOrganizationId =
    headerStore.get("x-active-organization-id") ??
    headerStore.get("x-organization-id");

  if (!requestedOrganizationId) {
    return null;
  }

  const member = await knowledgeDb.query.members.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, requestedOrganizationId),
        eq(table.userId, session.user.id),
      ),
    columns: {
      id: true,
    },
  });

  return member ? requestedOrganizationId : null;
}

export async function requireActiveOrganization(request?: Request) {
  if (request && new URL(request.url).pathname.startsWith("/api/mobile/v2/")) {
    return requireMobileSession(request);
  }
  const session = await requireSession();
  const requestedOrganizationId =
    (await getRequestedOrganizationId(session)) ??
    getActiveOrganizationId(session);
  const requestedOrganization = requestedOrganizationId
    ? await knowledgeDb.query.organizations.findFirst({
        where: (table, { eq }) => eq(table.id, requestedOrganizationId),
        columns: { id: true, lifecycleState: true },
      })
    : null;
  const organizationId =
    requestedOrganization?.id ??
    (await ensurePersonalOrganizationByUserId(session.user.id)).id;

  if (!organizationId) {
    throw new Error("Active organization required");
  }
  if (requestedOrganization?.lifecycleState === "deleting") {
    throw Object.assign(new Error("Organization deletion is in progress."), {
      code: "ORGANIZATION_DELETING",
    });
  }

  const deferEnvironment = await shouldDeferPersonalEnvironmentCreation({
    organizationId,
    userId: session.user.id,
  });
  if (!deferEnvironment) {
    const ensuredEnvironment = await ensureOrganizationDefaultEnvironment({
      organizationId,
      userId: session.user.id,
    });
    if (ensuredEnvironment.operation) {
      await enqueueEnvironmentOperation(ensuredEnvironment.operation.id);
    }
  }

  return {
    session,
    organizationId,
  };
}

export async function getActiveOrganizationSnapshot(
  session: SessionLike,
): Promise<OrganizationSnapshot | null> {
  if (!session?.user?.id) {
    return null;
  }

  const requestedOrganizationId =
    (await getRequestedOrganizationId(session)) ??
    getActiveOrganizationId(session);
  const requestedOrganization = requestedOrganizationId
    ? await knowledgeDb.query.organizations.findFirst({
        where: (table, { eq }) => eq(table.id, requestedOrganizationId),
        columns: { id: true, lifecycleState: true },
      })
    : null;
  const organizationId =
    requestedOrganization?.id ??
    (await ensurePersonalOrganizationByUserId(session.user.id)).id;

  if (!organizationId) {
    return null;
  }

  const deferEnvironment = await shouldDeferPersonalEnvironmentCreation({
    organizationId,
    userId: session.user.id,
  });
  if (
    requestedOrganization?.lifecycleState !== "deleting" &&
    !deferEnvironment
  ) {
    const ensuredEnvironment = await ensureOrganizationDefaultEnvironment({
      organizationId,
      userId: session.user.id,
    });
    if (ensuredEnvironment.operation) {
      await enqueueEnvironmentOperation(ensuredEnvironment.operation.id);
    }
  }

  const organization = await knowledgeDb.query.organizations.findFirst({
    where: (table, { eq }) => eq(table.id, organizationId),
    columns: {
      id: true,
      name: true,
      slug: true,
      logo: true,
    },
  });

  return organization ?? null;
}

export async function requireAdmin() {
  const session = await requireSession();
  const user = session.user as { id?: string; role?: string | null };
  if (isAdminUser(user)) {
    return session;
  }
  throw new Error("Forbidden");
}

export async function requireAdminOrganization() {
  const session = await requireAdmin();
  const organizationId =
    (await getRequestedOrganizationId(session)) ??
    getActiveOrganizationId(session) ??
    (await ensurePersonalOrganizationByUserId(session.user.id)).id;

  if (!organizationId) {
    throw new Error("Active organization required");
  }

  const ensuredEnvironment = await ensureOrganizationDefaultEnvironment({
    organizationId,
    userId: session.user.id,
  });
  if (ensuredEnvironment.operation) {
    await enqueueEnvironmentOperation(ensuredEnvironment.operation.id);
  }

  return {
    session,
    organizationId,
  };
}

export { canManageOrganization } from "@/lib/knowledge/organization-access";

export async function requireOrganizationAdmin() {
  const { organizationId, session } = await requireActiveOrganization();
  if (
    !(await canManageOrganization({
      organizationId,
      userId: session.user.id,
    }))
  ) {
    throw new Error("Forbidden");
  }
  return { organizationId, session };
}

export async function requireOrganizationOwner(options?: {
  allowDeleting?: boolean;
}) {
  const session = await requireSession();
  const organizationId =
    (await getRequestedOrganizationId(session)) ??
    getActiveOrganizationId(session) ??
    (await ensurePersonalOrganizationByUserId(session.user.id)).id;
  const [organization, membership] = await Promise.all([
    knowledgeDb.query.organizations.findFirst({
      where: (table, { eq }) => eq(table.id, organizationId),
    }),
    knowledgeDb.query.members.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, organizationId),
          eq(table.userId, session.user.id),
        ),
      columns: { role: true },
    }),
  ]);
  if (!(organization && membership?.role === "owner")) {
    throw new Error("Forbidden");
  }
  if (organization.lifecycleState === "deleting" && !options?.allowDeleting) {
    throw Object.assign(new Error("Organization deletion is in progress."), {
      code: "ORGANIZATION_DELETING",
    });
  }
  return { organizationId, session, organization };
}

export async function requireAuthenticatedShell(input?: {
  requireAdmin?: boolean;
  requireActiveOrganization?: boolean;
}) {
  const session = await getServerSessionStrict();

  if (!session?.user) {
    unauthorized();
  }

  const onboarding = await getSignupOnboardingState({
    userId: session.user.id,
    email: session.user.email,
    emailVerified: session.user.emailVerified,
  });
  if (onboarding.state !== "not_applicable" && onboarding.state !== "complete") {
    redirect("/onboarding");
  }

  const isAdmin = isAdminUser(session.user);

  if (input?.requireAdmin && !isAdmin) {
    forbidden();
  }

  const activeOrganization = await getActiveOrganizationSnapshot(session);
  const canManageActiveOrganization = activeOrganization
    ? await canManageOrganization({
        organizationId: activeOrganization.id,
        userId: session.user.id,
      })
    : false;

  if (input?.requireActiveOrganization && !activeOrganization) {
    redirect("/dashboard");
  }

  return {
    session,
    activeOrganization,
    canManageActiveOrganization,
    isAdmin,
  };
}
