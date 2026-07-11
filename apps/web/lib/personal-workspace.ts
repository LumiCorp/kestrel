import { and, eq, isNull, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

const PERSONAL_WORKSPACE_NAME = "Personal";
const PERSONAL_WORKSPACE_PREFIX = "personal-";

type UserLike = {
  id: string;
  name?: string | null;
  email?: string | null;
};

type SessionLike = {
  user?: UserLike | null;
  session?: {
    id?: string | null;
    token?: string | null;
    activeOrganizationId?: string | null;
  } | null;
};

function encodePersonalSlug(userId: string) {
  return Buffer.from(userId).toString("base64url").toLowerCase();
}

export function getPersonalOrganizationSlug(userId: string) {
  return `${PERSONAL_WORKSPACE_PREFIX}${encodePersonalSlug(userId)}`;
}

function buildPersonalMetadata(userId: string) {
  return JSON.stringify({
    kind: "personal-workspace",
    userId,
  });
}

export async function ensurePersonalOrganization(user: UserLike) {
  const slug = getPersonalOrganizationSlug(user.id);
  const metadata = buildPersonalMetadata(user.id);
  const now = new Date();
  const lockKey = `kestrel:personal-workspace:${user.id}`;

  return knowledgeDb.transaction(async (transaction) => {
    // Layouts and pages may resolve the same new session concurrently.
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
    );

    let organization = await transaction.query.organizations.findFirst({
      where: (table, { eq }) => eq(table.slug, slug),
    });

    if (!organization) {
      const [createdOrganization] = await transaction
        .insert(schema.organizations)
        .values({
          id: crypto.randomUUID(),
          name: PERSONAL_WORKSPACE_NAME,
          slug,
          logo: null,
          createdAt: now,
          metadata,
        })
        .returning();

      organization = createdOrganization;
    } else if (
      organization.name !== PERSONAL_WORKSPACE_NAME ||
      organization.metadata !== metadata
    ) {
      const [updatedOrganization] = await transaction
        .update(schema.organizations)
        .set({
          name: PERSONAL_WORKSPACE_NAME,
          metadata,
        })
        .where(eq(schema.organizations.id, organization.id))
        .returning();

      organization = updatedOrganization ?? organization;
    }

    const membership = await transaction.query.members.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, organization.id),
          eq(table.userId, user.id)
        ),
    });

    if (!membership) {
      await transaction.insert(schema.members).values({
        id: crypto.randomUUID(),
        organizationId: organization.id,
        userId: user.id,
        role: "owner",
        createdAt: now,
      });
    } else if (membership.role !== "owner") {
      await transaction
        .update(schema.members)
        .set({ role: "owner" })
        .where(eq(schema.members.id, membership.id));
    }

    return organization;
  });
}

export async function ensurePersonalOrganizationByUserId(userId: string) {
  const user = await knowledgeDb.query.users.findFirst({
    where: (table, { eq }) => eq(table.id, userId),
    columns: {
      id: true,
      name: true,
      email: true,
    },
  });

  if (!user) {
    throw new Error(`Unable to load user ${userId} for personal workspace`);
  }

  return ensurePersonalOrganization(user);
}

async function sessionHasOrganizationAccess(
  userId: string,
  organizationId: string
) {
  const membership = await knowledgeDb.query.members.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.userId, userId), eq(table.organizationId, organizationId)),
    columns: {
      id: true,
    },
  });

  return Boolean(membership);
}

async function persistActiveOrganizationId(input: {
  sessionId?: string | null;
  token?: string | null;
  organizationId: string;
}) {
  const nextValues = {
    activeOrganizationId: input.organizationId,
    updatedAt: new Date(),
  };

  if (input.sessionId) {
    await knowledgeDb
      .update(schema.sessions)
      .set(nextValues)
      .where(eq(schema.sessions.id, input.sessionId));
    return;
  }

  if (input.token) {
    await knowledgeDb
      .update(schema.sessions)
      .set(nextValues)
      .where(eq(schema.sessions.token, input.token));
  }
}

export async function ensureSessionHasActiveOrganization<
  T extends SessionLike | null,
>(session: T): Promise<T> {
  if (!session?.user?.id) {
    return session;
  }

  const personalOrganization = await ensurePersonalOrganization(session.user);
  const currentOrganizationId = session.session?.activeOrganizationId ?? null;

  if (
    currentOrganizationId &&
    (await sessionHasOrganizationAccess(session.user.id, currentOrganizationId))
  ) {
    return session;
  }

  await persistActiveOrganizationId({
    sessionId: session.session?.id ?? null,
    token: session.session?.token ?? null,
    organizationId: personalOrganization.id,
  });

  return {
    ...session,
    session: {
      ...(session.session ?? {}),
      activeOrganizationId: personalOrganization.id,
    },
  } as T;
}

export async function backfillPersonalWorkspaceData() {
  const users = await knowledgeDb.query.users.findMany({
    columns: {
      id: true,
      name: true,
      email: true,
    },
  });

  for (const user of users) {
    const personalOrganization = await ensurePersonalOrganization(user);

    await knowledgeDb
      .update(schema.sessions)
      .set({
        activeOrganizationId: personalOrganization.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.sessions.userId, user.id),
          isNull(schema.sessions.activeOrganizationId)
        )
      );

    await knowledgeDb
      .update(schema.knowledgeChats)
      .set({ organizationId: personalOrganization.id })
      .where(
        and(
          eq(schema.knowledgeChats.userId, user.id),
          isNull(schema.knowledgeChats.organizationId)
        )
      );

    await knowledgeDb
      .update(schema.apiUsage)
      .set({ organizationId: personalOrganization.id })
      .where(
        and(
          eq(schema.apiUsage.userId, user.id),
          isNull(schema.apiUsage.organizationId)
        )
      );

    await knowledgeDb
      .update(schema.usageStats)
      .set({ organizationId: personalOrganization.id })
      .where(
        and(
          eq(schema.usageStats.userId, user.id),
          isNull(schema.usageStats.organizationId)
        )
      );

    await knowledgeDb
      .update(schema.adminEventLogs)
      .set({ organizationId: personalOrganization.id })
      .where(
        and(
          eq(schema.adminEventLogs.actorUserId, user.id),
          isNull(schema.adminEventLogs.organizationId)
        )
      );
  }
}
