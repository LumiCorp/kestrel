import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

export function createPlaintextAdminApiKey(prefix = "sk") {
  const secret = `${prefix}_${randomBytes(24).toString("base64url")}`;
  return {
    secret,
    start: secret.slice(0, 12),
    hashedSecret: hashSecret(secret),
  };
}

export async function listAdminApiKeys(organizationId: string) {
  return knowledgeDb
    .select({
      id: schema.adminApiKeys.id,
      name: schema.adminApiKeys.name,
      prefix: schema.adminApiKeys.prefix,
      start: schema.adminApiKeys.start,
      enabled: schema.adminApiKeys.enabled,
      expiresAt: schema.adminApiKeys.expiresAt,
      createdAt: schema.adminApiKeys.createdAt,
      updatedAt: schema.adminApiKeys.updatedAt,
      lastUsedAt: schema.adminApiKeys.lastUsedAt,
      creatorUserId: schema.adminApiKeys.creatorUserId,
      userName: schema.users.name,
      userEmail: schema.users.email,
      userImage: schema.users.image,
      userRole: schema.users.role,
    })
    .from(schema.adminApiKeys)
    .leftJoin(
      schema.users,
      eq(schema.users.id, schema.adminApiKeys.creatorUserId)
    )
    .where(eq(schema.adminApiKeys.organizationId, organizationId))
    .orderBy(desc(schema.adminApiKeys.createdAt));
}

export async function createAdminApiKey(input: {
  organizationId: string;
  creatorUserId: string;
  name: string;
  expiresAt?: Date | null;
}) {
  const generated = createPlaintextAdminApiKey("sk");

  const [created] = await knowledgeDb
    .insert(schema.adminApiKeys)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      creatorUserId: input.creatorUserId,
      name: input.name,
      prefix: "sk",
      start: generated.start,
      hashedSecret: generated.hashedSecret,
      enabled: true,
      expiresAt: input.expiresAt ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  return {
    key: created,
    secret: generated.secret,
  };
}

export async function deleteAdminApiKey(id: string, organizationId: string) {
  const [deleted] = await knowledgeDb
    .delete(schema.adminApiKeys)
    .where(
      and(
        eq(schema.adminApiKeys.id, id),
        eq(schema.adminApiKeys.organizationId, organizationId)
      )
    )
    .returning();

  return deleted ?? null;
}
