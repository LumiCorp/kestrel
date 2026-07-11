import { eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export async function getDiscordGuildBindingForOrganization(
  organizationId: string
) {
  return knowledgeDb.query.discordGuildBindings.findFirst({
    where: (table, { eq }) => eq(table.organizationId, organizationId),
  });
}

export async function getDiscordGuildBindingForGuild(guildId: string) {
  return knowledgeDb.query.discordGuildBindings.findFirst({
    where: (table, { eq }) => eq(table.guildId, guildId),
  });
}

export async function upsertDiscordGuildBinding(input: {
  organizationId: string;
  guildId: string;
  guildName?: string | null;
  enabled: boolean;
}) {
  const existingGuildBinding = await getDiscordGuildBindingForGuild(
    input.guildId
  );
  if (
    existingGuildBinding &&
    existingGuildBinding.organizationId !== input.organizationId
  ) {
    throw new Error("Discord guild already bound to another organization");
  }

  const [binding] = await knowledgeDb
    .insert(schema.discordGuildBindings)
    .values({
      organizationId: input.organizationId,
      guildId: input.guildId,
      guildName: input.guildName ?? null,
      enabled: input.enabled,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.discordGuildBindings.organizationId,
      set: {
        guildId: input.guildId,
        guildName: input.guildName ?? null,
        enabled: input.enabled,
        updatedAt: new Date(),
      },
    })
    .returning();

  return binding;
}

export async function touchDiscordGuildBinding(input: {
  organizationId: string;
  lastWebhookAt?: Date | null;
  lastGatewayStartedAt?: Date | null;
  lastEventAt?: Date | null;
}) {
  const patch: Partial<typeof schema.discordGuildBindings.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (input.lastWebhookAt !== undefined) {
    patch.lastWebhookAt = input.lastWebhookAt;
  }

  if (input.lastGatewayStartedAt !== undefined) {
    patch.lastGatewayStartedAt = input.lastGatewayStartedAt;
  }

  if (input.lastEventAt !== undefined) {
    patch.lastEventAt = input.lastEventAt;
  }

  const [binding] = await knowledgeDb
    .update(schema.discordGuildBindings)
    .set(patch)
    .where(eq(schema.discordGuildBindings.organizationId, input.organizationId))
    .returning();

  return binding ?? null;
}
