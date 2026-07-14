import "server-only";

import { and, eq } from "drizzle-orm";
import * as schema from "@/drizzle/schema";
import { ensureCoreAppCatalog } from "@/lib/apps/service";
import { knowledgeDb } from "@/lib/knowledge/db";
import { getGoogleUserInfo } from "./google-calendar-api";
import {
  GOOGLE_CALENDAR_CAPABILITIES,
  GOOGLE_WORKSPACE_PROVIDER_KEY,
} from "./google-calendar-contract";

export async function findGoogleAuthAccount(userId: string) {
  return knowledgeDb.query.accounts.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.userId, userId),
        operators.eq(table.providerId, "google")
      ),
    columns: {
      id: true,
      accountId: true,
      scope: true,
    },
  });
}

export async function findGoogleCalendarUserConnection(input: {
  organizationId: string;
  userId: string;
}) {
  return knowledgeDb.query.appConnections.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY),
        eq(table.ownerType, "personal"),
        eq(table.userId, input.userId)
      ),
  });
}

export async function syncGoogleCalendarUserConnection(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  authAccountId: string;
  providerAccountId: string;
  accessToken: string;
  scopes: string[];
  shareAvailability: boolean;
}) {
  await ensureCoreAppCatalog();
  const [project, installation] = await Promise.all([
    knowledgeDb.query.projects.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.id, input.projectId),
          equals(table.organizationId, input.organizationId)
        ),
      columns: { environmentId: true },
    }),
    knowledgeDb.query.appInstallations.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.organizationId, input.organizationId),
          equals(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY),
          equals(table.status, "installed")
        ),
      columns: { appKey: true },
    }),
  ]);
  if (!project) throw new Error("Project not found.");
  if (!installation) {
    throw new Error(
      "Google Workspace must be installed for this Organization first."
    );
  }
  const viewer = await getGoogleUserInfo({ accessToken: input.accessToken });
  if (viewer.sub !== input.providerAccountId) {
    throw new Error(
      "Google account identity did not match the linked account."
    );
  }
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    const existingConnection = await transaction.query.appConnections.findFirst(
      {
        where: (table, operators) =>
          operators.and(
            operators.eq(table.organizationId, input.organizationId),
            operators.eq(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY),
            operators.eq(table.ownerType, "personal"),
            operators.eq(table.userId, input.userId)
          ),
      }
    );
    const connectionId = existingConnection?.id ?? crypto.randomUUID();
    const [appConnection] = await transaction
      .insert(schema.appConnections)
      .values({
        id: connectionId,
        organizationId: input.organizationId,
        appKey: GOOGLE_WORKSPACE_PROVIDER_KEY,
        ownerType: "personal",
        userId: input.userId,
        authAccountId: input.authAccountId,
        name: viewer.email ?? input.providerAccountId,
        status: "connected",
        externalAccountId: input.providerAccountId,
        externalAccountLabel: viewer.email ?? input.providerAccountId,
        scopes: input.scopes,
        deliveryConfig: {},
        lastHealthAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.appConnections.id,
        set: {
          authAccountId: input.authAccountId,
          name: viewer.email ?? input.providerAccountId,
          status: "connected",
          externalAccountId: input.providerAccountId,
          externalAccountLabel: viewer.email ?? input.providerAccountId,
          scopes: input.scopes,
          failureCode: null,
          failureMessage: null,
          disconnectedAt: null,
          lastHealthAt: now,
          updatedAt: now,
        },
      })
      .returning();
    if (!appConnection) {
      throw new Error("Google Calendar App connection could not be recorded.");
    }

    await transaction
      .insert(schema.projectApps)
      .values({
        projectId: input.projectId,
        appKey: GOOGLE_WORKSPACE_PROVIDER_KEY,
        enabled: true,
        addedByUserId: input.userId,
        settings: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.projectApps.projectId, schema.projectApps.appKey],
        set: { enabled: true, updatedAt: now },
      });
    await transaction
      .update(schema.projectAppConnections)
      .set({ isDefault: false, updatedAt: now })
      .where(
        and(
          eq(schema.projectAppConnections.projectId, input.projectId),
          eq(
            schema.projectAppConnections.appKey,
            GOOGLE_WORKSPACE_PROVIDER_KEY
          ),
          eq(schema.projectAppConnections.scope, "personal"),
          eq(schema.projectAppConnections.userId, input.userId),
          eq(schema.projectAppConnections.isDefault, true)
        )
      );
    await transaction
      .insert(schema.projectAppConnections)
      .values({
        projectId: input.projectId,
        appKey: GOOGLE_WORKSPACE_PROVIDER_KEY,
        connectionId,
        scope: "personal",
        userId: input.userId,
        isDefault: true,
        addedByUserId: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.projectAppConnections.projectId,
          schema.projectAppConnections.appKey,
          schema.projectAppConnections.connectionId,
        ],
        set: {
          scope: "personal",
          userId: input.userId,
          isDefault: true,
          addedByUserId: input.userId,
          updatedAt: now,
        },
      });

    const environmentGrants =
      await transaction.query.environmentAppCapabilityGrants.findMany({
        where: (table, { and: all, eq: equals }) =>
          all(
            equals(table.environmentId, project.environmentId),
            equals(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY)
          ),
      });
    for (const grant of environmentGrants) {
      await transaction
        .insert(schema.projectAppCapabilityPolicies)
        .values({
          projectId: input.projectId,
          appKey: GOOGLE_WORKSPACE_PROVIDER_KEY,
          capabilityKey: grant.capabilityKey,
          enabled: grant.enabled,
          approvalMode: grant.approvalMode,
          loggingMode: grant.loggingMode,
          rateLimitMode: grant.rateLimitMode,
          settings: grant.settings,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }

    for (const capabilityKey of GOOGLE_CALENDAR_CAPABILITIES) {
      await transaction
        .insert(schema.projectAppUserCapabilities)
        .values({
          projectId: input.projectId,
          connectionId,
          appKey: GOOGLE_WORKSPACE_PROVIDER_KEY,
          capabilityKey,
          audience: "self",
          enabled: true,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.projectAppUserCapabilities.projectId,
            schema.projectAppUserCapabilities.connectionId,
            schema.projectAppUserCapabilities.appKey,
            schema.projectAppUserCapabilities.capabilityKey,
            schema.projectAppUserCapabilities.audience,
          ],
          set: { enabled: true, updatedAt: now },
        });
    }
    await transaction
      .insert(schema.projectAppUserCapabilities)
      .values({
        projectId: input.projectId,
        connectionId,
        appKey: GOOGLE_WORKSPACE_PROVIDER_KEY,
        capabilityKey: "calendar.availability.read",
        audience: "project",
        enabled: input.shareAvailability,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.projectAppUserCapabilities.projectId,
          schema.projectAppUserCapabilities.connectionId,
          schema.projectAppUserCapabilities.appKey,
          schema.projectAppUserCapabilities.capabilityKey,
          schema.projectAppUserCapabilities.audience,
        ],
        set: { enabled: input.shareAvailability, updatedAt: now },
      });
    return appConnection;
  });
}

export async function getGoogleCalendarProjectStatus(input: {
  organizationId: string;
  projectId: string;
  userId: string;
}) {
  const connection = await findGoogleCalendarUserConnection({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  const rows = connection
    ? await knowledgeDb.query.projectAppUserCapabilities.findMany({
        where: (table, { and, eq }) =>
          and(
            eq(table.projectId, input.projectId),
            eq(table.connectionId, connection.id),
            eq(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY)
          ),
      })
    : [];
  const project = await knowledgeDb.query.projects.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.projectId),
        eq(table.organizationId, input.organizationId)
      ),
    columns: { environmentId: true },
  });
  const [environmentGrants, attachment] = await Promise.all([
    project
      ? knowledgeDb.query.environmentAppCapabilityGrants.findMany({
          where: (table, { and, eq, inArray }) =>
            and(
              eq(table.environmentId, project.environmentId),
              eq(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY),
              inArray(table.capabilityKey, [...GOOGLE_CALENDAR_CAPABILITIES])
            ),
        })
      : Promise.resolve([]),
    connection
      ? knowledgeDb.query.projectAppConnections.findFirst({
          where: (table, { and: all, eq: equals }) =>
            all(
              equals(table.projectId, input.projectId),
              equals(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY),
              equals(table.connectionId, connection.id),
              equals(table.scope, "personal"),
              equals(table.userId, input.userId),
              equals(table.isDefault, true)
            ),
          columns: { connectionId: true },
        })
      : Promise.resolve(undefined),
  ]);
  return {
    configured: Boolean(
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ),
    linked: Boolean(connection),
    projectConnected: Boolean(attachment),
    shareAvailability: rows.some(
      (row) =>
        row.audience === "project" &&
        row.capabilityKey === "calendar.availability.read" &&
        row.enabled
    ),
    needsReconnect: connection?.status === "degraded",
    providerLogin: connection?.externalAccountLabel ?? null,
    scopes: connection?.scopes ?? [],
    environmentCapabilities: GOOGLE_CALENDAR_CAPABILITIES.map(
      (capabilityKey) => ({
        capabilityKey,
        enabled: environmentGrants.some(
          (grant) =>
            grant.capabilityKey === capabilityKey &&
            grant.enabled &&
            grant.approvalMode !== "deny"
        ),
      })
    ),
  };
}

export async function setGoogleCalendarAvailabilitySharing(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  enabled: boolean;
}) {
  const connection = await requireGoogleCalendarConnection(input);
  const selfCapability =
    await knowledgeDb.query.projectAppUserCapabilities.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.projectId, input.projectId),
          eq(table.connectionId, connection.id),
          eq(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY),
          eq(table.capabilityKey, "calendar.availability.read"),
          eq(table.audience, "self"),
          eq(table.enabled, true)
        ),
    });
  if (!selfCapability) {
    throw new Error("Connect Google Calendar to this Project first.");
  }
  const now = new Date();
  const [sharing] = await knowledgeDb
    .insert(schema.projectAppUserCapabilities)
    .values({
      projectId: input.projectId,
      connectionId: connection.id,
      appKey: GOOGLE_WORKSPACE_PROVIDER_KEY,
      capabilityKey: "calendar.availability.read",
      audience: "project",
      enabled: input.enabled,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.projectAppUserCapabilities.projectId,
        schema.projectAppUserCapabilities.connectionId,
        schema.projectAppUserCapabilities.appKey,
        schema.projectAppUserCapabilities.capabilityKey,
        schema.projectAppUserCapabilities.audience,
      ],
      set: { enabled: input.enabled, updatedAt: now },
    })
    .returning();
  return sharing;
}

export async function disconnectGoogleCalendarFromProject(input: {
  organizationId: string;
  projectId: string;
  userId: string;
}) {
  const connection = await requireGoogleCalendarConnection(input);
  await knowledgeDb.transaction(async (transaction) => {
    await transaction
      .delete(schema.projectAppConnections)
      .where(
        and(
          eq(schema.projectAppConnections.projectId, input.projectId),
          eq(
            schema.projectAppConnections.appKey,
            GOOGLE_WORKSPACE_PROVIDER_KEY
          ),
          eq(schema.projectAppConnections.connectionId, connection.id),
          eq(schema.projectAppConnections.userId, input.userId)
        )
      );
    await transaction
      .delete(schema.projectAppUserCapabilities)
      .where(
        and(
          eq(schema.projectAppUserCapabilities.projectId, input.projectId),
          eq(schema.projectAppUserCapabilities.connectionId, connection.id),
          eq(
            schema.projectAppUserCapabilities.appKey,
            GOOGLE_WORKSPACE_PROVIDER_KEY
          )
        )
      );
  });
}

export async function markGoogleCalendarConnectionDegraded(input: {
  connectionId: string;
  failureCode: string;
}) {
  await knowledgeDb
    .update(schema.appConnections)
    .set({
      status: "degraded",
      failureCode: input.failureCode,
      updatedAt: new Date(),
    })
    .where(eq(schema.appConnections.id, input.connectionId));
}

async function requireGoogleCalendarConnection(input: {
  organizationId: string;
  userId: string;
}) {
  const connection = await findGoogleCalendarUserConnection({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  if (!connection) throw new Error("Google Calendar is not connected.");
  return connection;
}
