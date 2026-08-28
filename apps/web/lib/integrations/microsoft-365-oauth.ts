import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/drizzle/schema";
import {
  disconnectPersonalAppConnection,
} from "@/lib/apps/service";
import { knowledgeDb } from "@/lib/knowledge/db";
import {
  MICROSOFT_365_PROVIDER_KEY,
  parseMicrosoft365Packs,
} from "./microsoft-365-contract";

const microsoftIdentitySchema = z.object({
  sub: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
  preferred_username: z.string().optional(),
});

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

export async function disconnectMicrosoft365Connection(input: {
  organizationId: string;
  userId: string;
}) {
  return disconnectPersonalAppConnection({
    organizationId: input.organizationId,
    userId: input.userId,
    appKey: MICROSOFT_365_PROVIDER_KEY,
  });
}
