import { logAdminEvent } from "@/lib/admin/logs";
import { upsertDiscordGuildBinding } from "@/lib/bots/discord-store";
import {
  getResolvedToolProvider,
  getToolsOverview,
  testToolProviderConnection,
  updateOrganizationToolCapability,
  updateOrganizationToolProvider,
} from "@/lib/tools/service";
import type {
  ToolCapabilityKey,
  ToolCapabilityPolicy,
  ToolProviderKey,
  ToolsOverview,
} from "@/lib/tools/types";

export async function getAdminToolsOverview(
  organizationId: string,
  origin: string
): Promise<ToolsOverview> {
  return getToolsOverview({ organizationId, origin });
}

export async function getAdminToolProvider(
  organizationId: string,
  providerKey: ToolProviderKey,
  origin: string
) {
  return getResolvedToolProvider({ organizationId, providerKey, origin });
}

export async function patchAdminToolProvider(input: {
  organizationId: string;
  providerKey: ToolProviderKey;
  enabled?: boolean;
  settings?: Record<string, unknown>;
  origin: string;
}) {
  await updateOrganizationToolProvider(input);
  return getResolvedToolProvider({
    organizationId: input.organizationId,
    providerKey: input.providerKey,
    origin: input.origin,
  });
}

export async function patchAdminToolCapability(input: {
  organizationId: string;
  providerKey: ToolProviderKey;
  capabilityKey: ToolCapabilityKey;
  patch: Partial<ToolCapabilityPolicy>;
  origin: string;
}) {
  await updateOrganizationToolCapability(input);
  return getResolvedToolProvider({
    organizationId: input.organizationId,
    providerKey: input.providerKey,
    origin: input.origin,
  });
}

export async function testAdminToolProvider(
  organizationId: string,
  providerKey: ToolProviderKey,
  origin: string
) {
  return testToolProviderConnection({ organizationId, providerKey, origin });
}

export async function saveAdminToolProvider(input: {
  actorUserId: string;
  enabled?: boolean;
  organizationId: string;
  origin: string;
  providerKey: ToolProviderKey;
  settings?: Record<string, unknown>;
}) {
  const provider = await patchAdminToolProvider(input);

  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "tools",
    action: "provider.update",
    targetType: "tool-provider",
    targetId: input.providerKey,
    message: `Updated tool provider ${input.providerKey}.`,
    metadata: {
      enabled: input.enabled,
    },
  });

  return provider;
}

export async function saveAdminToolCapability(input: {
  actorUserId: string;
  capabilityKey: ToolCapabilityKey;
  organizationId: string;
  origin: string;
  patch: Partial<ToolCapabilityPolicy>;
  providerKey: ToolProviderKey;
}) {
  const provider = await patchAdminToolCapability(input);

  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "tools",
    action: "capability.update",
    targetType: "tool-capability",
    targetId: `${input.providerKey}:${input.capabilityKey}`,
    message: `Updated tool capability ${input.providerKey}/${input.capabilityKey}.`,
    metadata: input.patch,
  });

  return provider;
}

export async function runAdminToolProviderTest(input: {
  actorUserId: string;
  organizationId: string;
  origin: string;
  providerKey: ToolProviderKey;
}) {
  const result = await testAdminToolProvider(
    input.organizationId,
    input.providerKey,
    input.origin
  );

  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "tools",
    action: "provider.test",
    targetType: "tool-provider",
    targetId: input.providerKey,
    message: `Tested tool provider ${input.providerKey}.`,
    metadata: result.connection,
  });

  return result;
}

export async function saveAdminDiscordBinding(input: {
  actorUserId: string;
  enabled: boolean;
  guildId: string;
  guildName?: string | null;
  organizationId: string;
}) {
  const binding = await upsertDiscordGuildBinding({
    organizationId: input.organizationId,
    guildId: input.guildId,
    guildName: input.guildName ?? null,
    enabled: input.enabled,
  });

  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "tools",
    action: "discord.binding.update",
    targetType: "discord-guild-binding",
    targetId: binding.guildId,
    message: `Updated Discord guild binding for ${input.guildId}.`,
    metadata: {
      guildName: binding.guildName,
      enabled: binding.enabled,
    },
  });

  return binding;
}
