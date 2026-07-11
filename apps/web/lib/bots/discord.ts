import { getDiscordConfig, getDiscordInstallUrl } from "@/lib/bots/discord-api";
import {
  getDiscordGuildBindingForGuild,
  getDiscordGuildBindingForOrganization,
  touchDiscordGuildBinding,
} from "@/lib/bots/discord-store";
import { getUnifiedBotRuntime } from "@/lib/bots/runtime";

export function getDiscordGatewayStatus() {
  return getUnifiedBotRuntime().getDiscordGatewayStatus();
}

export async function getDiscordIntegrationStatus(
  organizationId: string,
  origin: string
) {
  const config = getDiscordConfig();
  const binding = await getDiscordGuildBindingForOrganization(organizationId);
  const gatewayStatus = getUnifiedBotRuntime().getDiscordGatewayStatus();

  return {
    credentialsConfigured: config.configured,
    installUrl: getDiscordInstallUrl(),
    webhookUrl: `${origin}/api/webhooks/discord`,
    gatewayStatus: gatewayStatus.active ? "active" : "inactive",
    gateway: gatewayStatus,
    binding,
    adapterAvailable: getUnifiedBotRuntime().hasDiscordAdapter(),
    stateBackend: getUnifiedBotRuntime().getStateBackend(),
  };
}

export async function startDiscordGatewayListener(input: {
  organizationId: string;
  origin: string;
  waitUntil: (task: Promise<unknown>) => void;
}) {
  return getUnifiedBotRuntime().startDiscordGatewayListener(input);
}

export async function handleDiscordWebhook(
  request: Request,
  apiUrl: string,
  waitUntil?: (task: Promise<unknown>) => void
) {
  const config = getDiscordConfig();
  if (!config.configured) {
    return Response.json(
      { error: "Discord credentials are not configured" },
      { status: 400 }
    );
  }

  const body = await request.clone().text();

  const guildId = (() => {
    try {
      const payload = JSON.parse(body) as {
        guild_id?: string;
        d?: { guild_id?: string };
      };
      return payload.guild_id ?? payload.d?.guild_id ?? null;
    } catch {
      return null;
    }
  })();

  if (guildId) {
    const binding = await getDiscordGuildBindingForGuild(guildId);
    if (binding) {
      await touchDiscordGuildBinding({
        organizationId: binding.organizationId,
        lastWebhookAt: new Date(),
      }).catch(() => null);
    }
  }

  return getUnifiedBotRuntime().handleWebhook(
    "discord",
    request,
    waitUntil ? { waitUntil } : undefined,
    apiUrl
  );
}
