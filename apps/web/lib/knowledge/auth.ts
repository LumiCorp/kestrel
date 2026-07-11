import { headers } from "next/headers";
import { forbidden, redirect, unauthorized } from "next/navigation";
import { auth as betterAuth } from "@/lib/auth";
import type { OrganizationSnapshot, Session } from "@/lib/auth-types";
import { knowledgeDb } from "@/lib/knowledge/db";
import { ensurePersonalOrganizationByUserId } from "@/lib/personal-workspace";

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
      .filter(Boolean)
  );
}

export function isAdminUser(
  user: { id?: string | null; role?: string | null } | null | undefined
) {
  if (!(user?.id || user?.role)) {
    return false;
  }

  const adminIds = parseAdminUserIds();
  return user?.role === "admin" || (user?.id ? adminIds.has(user.id) : false);
}

export async function requireSession() {
  const session = await getServerSessionStrict();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }
  return session;
}

export function getActiveOrganizationId(session: SessionLike): string | null {
  return (
    (session as SessionWithOrg | null)?.session?.activeOrganizationId ?? null
  );
}

async function getRequestedOrganizationId(
  session: NonNullable<SessionLike>
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
        eq(table.userId, session.user.id)
      ),
    columns: {
      id: true,
    },
  });

  return member ? requestedOrganizationId : null;
}

export async function requireActiveOrganization() {
  const session = await requireSession();
  const organizationId =
    (await getRequestedOrganizationId(session)) ??
    getActiveOrganizationId(session) ??
    (await ensurePersonalOrganizationByUserId(session.user.id)).id;

  if (!organizationId) {
    throw new Error("Active organization required");
  }

  return {
    session,
    organizationId,
  };
}

export async function getActiveOrganizationSnapshot(
  session: SessionLike
): Promise<OrganizationSnapshot | null> {
  if (!session?.user?.id) {
    return null;
  }

  const organizationId =
    (await getRequestedOrganizationId(session)) ??
    getActiveOrganizationId(session) ??
    (await ensurePersonalOrganizationByUserId(session.user.id)).id;

  if (!organizationId) {
    return null;
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

  return {
    session,
    organizationId,
  };
}

export async function requireAuthenticatedShell(input?: {
  requireAdmin?: boolean;
  requireActiveOrganization?: boolean;
}) {
  const session = await getServerSessionStrict();

  if (!session?.user) {
    unauthorized();
  }

  const isAdmin = isAdminUser(session.user);

  if (input?.requireAdmin && !isAdmin) {
    forbidden();
  }

  const activeOrganization = await getActiveOrganizationSnapshot(session);

  if (input?.requireActiveOrganization && !activeOrganization) {
    redirect("/dashboard");
  }

  return {
    session,
    activeOrganization,
    isAdmin,
  };
}
