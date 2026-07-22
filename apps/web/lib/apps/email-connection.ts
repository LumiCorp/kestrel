import { and, eq } from "drizzle-orm";
import type { ResolvedOrganizationEmailConfig } from "@/lib/email/organization-config";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { ensureCoreAppCatalog } from "./service";

export async function syncOrganizationEmailAppConnection(input: {
  organizationId: string;
  config: ResolvedOrganizationEmailConfig;
}) {
  await ensureCoreAppCatalog();
  const now = new Date();
  const status =
    input.config.enabled && input.config.status === "ready"
      ? "connected"
      : "degraded";
  const existing = await knowledgeDb.query.appConnections.findFirst({
    where: and(
      eq(schema.appConnections.organizationId, input.organizationId),
      eq(schema.appConnections.appKey, "email"),
      eq(schema.appConnections.ownerType, "organization")
    ),
  });
  const connection = existing
    ? (
        await knowledgeDb
          .update(schema.appConnections)
          .set({
            name: "Organization Resend",
            status,
            externalAccountLabel: input.config.fromEmail,
            failureCode: status === "connected" ? null : input.config.status,
            failureMessage:
              status === "connected"
                ? null
                : "Configure, test, and enable organization email delivery.",
            lastHealthAt: input.config.lastTestedAt,
            updatedAt: now,
          })
          .where(eq(schema.appConnections.id, existing.id))
          .returning()
      )[0]
    : (
        await knowledgeDb
          .insert(schema.appConnections)
          .values({
            organizationId: input.organizationId,
            appKey: "email",
            ownerType: "organization",
            name: "Organization Resend",
            status,
            externalAccountLabel: input.config.fromEmail,
            scopes: ["email.send"],
            failureCode: status === "connected" ? null : input.config.status,
            failureMessage:
              status === "connected"
                ? null
                : "Configure, test, and enable organization email delivery.",
            lastHealthAt: input.config.lastTestedAt,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
      )[0];
  if (!connection) throw new Error("EMAIL_APP_CONNECTION_SYNC_FAILED");

  const externalId = input.config.fromEmail || input.organizationId;
  const resource = await knowledgeDb.query.appConnectionResources.findFirst({
    where: and(
      eq(schema.appConnectionResources.connectionId, connection.id),
      eq(schema.appConnectionResources.resourceType, "sender")
    ),
  });
  if (resource) {
    await knowledgeDb
      .update(schema.appConnectionResources)
      .set({
        externalId,
        label: input.config.fromEmail || "Organization sender",
        enabled: status === "connected",
        permissions: { send: status === "connected" },
        metadata: { provider: "resend" },
        updatedAt: now,
      })
      .where(eq(schema.appConnectionResources.id, resource.id));
  } else {
    await knowledgeDb.insert(schema.appConnectionResources).values({
      connectionId: connection.id,
      externalId,
      resourceType: "sender",
      label: input.config.fromEmail || "Organization sender",
      enabled: status === "connected",
      permissions: { send: status === "connected" },
      metadata: { provider: "resend" },
      createdAt: now,
      updatedAt: now,
    });
  }
  return connection;
}
