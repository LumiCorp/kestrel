const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_INSTALL_PERMISSIONS = "274878024704";

export function getDiscordConfig() {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const applicationId = process.env.DISCORD_APPLICATION_ID;
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  const mentionRoleIds = process.env.DISCORD_MENTION_ROLE_IDS
    ? process.env.DISCORD_MENTION_ROLE_IDS.split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : [];

  return {
    botToken,
    applicationId,
    publicKey,
    mentionRoleIds,
    configured: Boolean(botToken && applicationId && publicKey),
  };
}

export function getDiscordInstallUrl() {
  const { applicationId } = getDiscordConfig();
  if (!applicationId) {
    return null;
  }

  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot%20applications.commands&permissions=${DISCORD_INSTALL_PERMISSIONS}`;
}

export async function createDiscordThreadFromMessage(input: {
  channelId: string;
  messageId: string;
  name: string;
}) {
  const { botToken } = getDiscordConfig();
  if (!botToken) {
    throw new Error("Discord credentials are not configured");
  }

  const response = await fetch(
    `${DISCORD_API_BASE}/channels/${input.channelId}/messages/${input.messageId}/threads`,
    {
      method: "POST",
      headers: {
        authorization: `Bot ${botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: input.name,
        auto_archive_duration: 1440,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Discord API request failed (${response.status})${errorText ? `: ${errorText}` : ""}`
    );
  }

  return (await response.json()) as {
    id: string;
    name?: string;
  };
}
