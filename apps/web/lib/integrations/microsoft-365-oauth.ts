import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/drizzle/schema";
import { ensureCoreAppCatalog } from "@/lib/apps/service";
import { knowledgeDb } from "@/lib/knowledge/db";
import {
  MICROSOFT_365_AUTH_PROVIDER_ID,
  MICROSOFT_365_PROVIDER_KEY,
  type Microsoft365Pack,
  parseMicrosoft365Packs,
} from "./microsoft-365-contract";

const microsoftIdentitySchema = z.object({
  sub: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
  preferred_username: z.string().optional(),
});

export async function findMicrosoftAuthAccount(userId: string) {
  return knowledgeDb.query.accounts.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.userId, userId),
        operators.eq(table.providerId, MICROSOFT_365_AUTH_PROVIDER_ID)
      ),
    columns: {
      id: true,
      accountId: true,
      scope: true,
    },
  });
}

export async function findMicrosoft365Connection(input: {
  organizationId: string;
  userId: string;
}) {
  return knowledgeDb.query.appConnections.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.appKey, MICROSOFT_365_PROVIDER_KEY),
        eq(table.ownerType, "personal"),
        eq(table.userId, input.userId)
      ),
  });
}

export async function getMicrosoftIdentity(input: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}) {
  const response = await (input.fetchImpl ?? fetch)(
    "https://graph.microsoft.com/oidc/userinfo",
    { headers: { authorization: `Bearer ${input.accessToken}` } }
  );
  if (!response.ok) {
    throw new Error("Microsoft 365 account verification failed.");
  }
  return microsoftIdentitySchema.parse(await response.json());
}

export function packsFromMicrosoft365Connection(
  connection:
    | Pick<typeof schema.appConnections.$inferSelect, "deliveryConfig">
    | null
    | undefined
) {
  const config = connection?.deliveryConfig;
  return parseMicrosoft365Packs(
    config && typeof config === "object" ? config.capabilityPacks : undefined
  );
}

export async function syncMicrosoft365Connection(input: {
  organizationId: string;
  userId: string;
  authAccountId: string;
  providerAccountId: string;
  accessToken: string;
  scopes: string[];
  packs: Microsoft365Pack[];
}) {
  await ensureCoreAppCatalog();
  const installation = await knowledgeDb.query.appInstallations.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.appKey, MICROSOFT_365_PROVIDER_KEY),
        eq(table.status, "installed")
      ),
    columns: { appKey: true },
  });
  if (!installation) {
    throw new Error("Install Microsoft 365 before connecting an account.");
  }
  const identity = await getMicrosoftIdentity({ accessToken: input.accessToken });
  if (identity.sub !== input.providerAccountId) {
    throw new Error("Microsoft 365 account identity did not match the linked account.");
  }
  const label =
    identity.email ??
    identity.preferred_username ??
    identity.name ??
    identity.sub;
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    const existing = await transaction.query.appConnections.findFirst({
      where: (table, operators) =>
        operators.and(
          operators.eq(table.organizationId, input.organizationId),
          operators.eq(table.appKey, MICROSOFT_365_PROVIDER_KEY),
          operators.eq(table.ownerType, "personal"),
          operators.eq(table.userId, input.userId)
        ),
    });
    const id = existing?.id ?? crypto.randomUUID();
    const [connection] = await transaction
      .insert(schema.appConnections)
      .values({
        id,
        organizationId: input.organizationId,
        appKey: MICROSOFT_365_PROVIDER_KEY,
        ownerType: "personal",
        userId: input.userId,
        authAccountId: input.authAccountId,
        name: label,
        status: "connected",
        externalAccountId: input.providerAccountId,
        externalAccountLabel: label,
        scopes: input.scopes,
        deliveryConfig: { capabilityPacks: input.packs },
        lastHealthAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.appConnections.id,
        set: {
          authAccountId: input.authAccountId,
          name: label,
          status: "connected",
          externalAccountId: input.providerAccountId,
          externalAccountLabel: label,
          scopes: input.scopes,
          deliveryConfig: { capabilityPacks: input.packs },
          failureCode: null,
          failureMessage: null,
          disconnectedAt: null,
          lastHealthAt: now,
          updatedAt: now,
        },
      })
      .returning();
    if (!connection) throw new Error("Microsoft 365 connection could not be recorded.");

    return connection;
  });
}

export async function markMicrosoft365ConnectionDegraded(input: {
  connectionId: string;
  failureCode: string;
}) {
  await knowledgeDb
    .update(schema.appConnections)
    .set({
      status: "degraded",
      failureCode: input.failureCode,
      failureMessage: "Reconnect Microsoft 365 to restore this App.",
      updatedAt: new Date(),
    })
    .where(eq(schema.appConnections.id, input.connectionId));
}
