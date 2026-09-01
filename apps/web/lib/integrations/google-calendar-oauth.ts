import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "@/drizzle/schema";
import {
  disconnectPersonalAppConnection,
} from "@/lib/apps/service";
import { resolvePlatformOAuthRegistration } from "@/lib/apps/platform-oauth-registrations";
import { knowledgeDb } from "@/lib/knowledge/db";
import {
  GOOGLE_CALENDAR_CAPABILITIES,
  GOOGLE_WORKSPACE_PROVIDER_KEY,
  googleWorkspacePackHealth,
  hasGoogleWorkspacePackScopes,
  parseSelectedGoogleWorkspacePacks,
} from "./google-calendar-contract";

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
        eq(table.userId, input.userId),
      ),
  });
}

export class PersonalConnectionRequiredError extends Error {
  readonly code = "PERSONAL_CONNECTION_REQUIRED";
  readonly settingsUrl = "/settings/connections#google-workspace";
}

export async function attachGoogleCalendarConnectionToProject(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  shareAvailability: boolean;
}) {
  const [connection, project] = await Promise.all([
    findGoogleCalendarUserConnection({
      organizationId: input.organizationId,
      userId: input.userId,
    }),
    knowledgeDb.query.projects.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.id, input.projectId),
          equals(table.organizationId, input.organizationId),
        ),
      columns: { environmentId: true },
    }),
  ]);
  if (!project) throw new Error("Project not found.");
  if (
    !connection ||
    connection.status === "disconnected" ||
    !hasGoogleWorkspacePackScopes({
      pack: "calendar",
      grantedScopes: connection.scopes,
    })
  ) {
    throw new PersonalConnectionRequiredError(
      "Connect Google Workspace in Settings before adding it to a Project.",
    );
  }

  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    const connectionLockKey = `personal-app-connection:${connection.id}`;
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${connectionLockKey}, 0))`,
    );
    const lockedConnection = await transaction.query.appConnections.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.id, connection.id),
          equals(table.organizationId, input.organizationId),
          equals(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY),
          equals(table.ownerType, "personal"),
          equals(table.userId, input.userId),
          inArray(table.status, ["connected", "degraded"]),
        ),
    });
    if (!lockedConnection) {
      throw new PersonalConnectionRequiredError(
        "Connect Google Workspace in Settings before adding it to a Project.",
      );
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
            GOOGLE_WORKSPACE_PROVIDER_KEY,
          ),
          eq(schema.projectAppConnections.scope, "personal"),
          eq(schema.projectAppConnections.userId, input.userId),
          eq(schema.projectAppConnections.isDefault, true),
        ),
      );
    await transaction
      .insert(schema.projectAppConnections)
      .values({
        projectId: input.projectId,
        appKey: GOOGLE_WORKSPACE_PROVIDER_KEY,
        connectionId: lockedConnection.id,
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
            equals(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY),
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
          connectionId: lockedConnection.id,
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
        connectionId: lockedConnection.id,
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
    return lockedConnection;
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
            eq(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY),
          ),
      })
    : [];
  const project = await knowledgeDb.query.projects.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.projectId),
        eq(table.organizationId, input.organizationId),
      ),
    columns: { environmentId: true },
  });
  const [environmentGrants, attachment, registration] = await Promise.all([
    project
      ? knowledgeDb.query.environmentAppCapabilityGrants.findMany({
          where: (table, { and, eq, inArray }) =>
            and(
              eq(table.environmentId, project.environmentId),
              eq(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY),
              inArray(table.capabilityKey, [...GOOGLE_CALENDAR_CAPABILITIES]),
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
              equals(table.isDefault, true),
            ),
          columns: { connectionId: true },
        })
      : Promise.resolve(undefined),
    resolvePlatformOAuthRegistration("google_workspace"),
  ]);
  return {
    configured: registration.status === "ready",
    linked: Boolean(
      connection &&
      connection.status !== "disconnected" &&
      hasGoogleWorkspacePackScopes({
        pack: "calendar",
        grantedScopes: connection.scopes,
      }),
    ),
    projectConnected: Boolean(attachment),
    shareAvailability: rows.some(
      (row) =>
        row.audience === "project" &&
        row.capabilityKey === "calendar.availability.read" &&
        row.enabled,
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
            grant.approvalMode !== "deny",
        ),
      }),
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
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    const connectionLockKey = `personal-app-connection:${connection.id}`;
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${connectionLockKey}, 0))`,
    );
    const [lockedConnection, selfCapability] = await Promise.all([
      transaction.query.appConnections.findFirst({
        where: (table, { and: all, eq: equals }) =>
          all(
            equals(table.id, connection.id),
            equals(table.organizationId, input.organizationId),
            equals(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY),
            equals(table.ownerType, "personal"),
            equals(table.userId, input.userId),
            inArray(table.status, ["connected", "degraded"]),
          ),
        columns: { id: true },
      }),
      transaction.query.projectAppUserCapabilities.findFirst({
        where: (table, { and: all, eq: equals }) =>
          all(
            equals(table.projectId, input.projectId),
            equals(table.connectionId, connection.id),
            equals(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY),
            equals(table.capabilityKey, "calendar.availability.read"),
            equals(table.audience, "self"),
            equals(table.enabled, true),
          ),
      }),
    ]);
    if (!(lockedConnection && selfCapability)) {
      throw new Error("Connect Google Calendar to this Project first.");
    }
    const [sharing] = await transaction
      .insert(schema.projectAppUserCapabilities)
      .values({
        projectId: input.projectId,
        connectionId: lockedConnection.id,
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
  });
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
            GOOGLE_WORKSPACE_PROVIDER_KEY,
          ),
          eq(schema.projectAppConnections.connectionId, connection.id),
          eq(schema.projectAppConnections.userId, input.userId),
        ),
      );
    await transaction
      .delete(schema.projectAppUserCapabilities)
      .where(
        and(
          eq(schema.projectAppUserCapabilities.projectId, input.projectId),
          eq(schema.projectAppUserCapabilities.connectionId, connection.id),
          eq(
            schema.projectAppUserCapabilities.appKey,
            GOOGLE_WORKSPACE_PROVIDER_KEY,
          ),
        ),
      );
  });
}

export async function disconnectGoogleCalendarUserConnection(input: {
  organizationId: string;
  userId: string;
}) {
  return disconnectPersonalAppConnection({
    organizationId: input.organizationId,
    userId: input.userId,
    appKey: GOOGLE_WORKSPACE_PROVIDER_KEY,
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
