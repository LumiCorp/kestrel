export const MICROSOFT_365_APP_ID = "microsoft_365" as const;
export const MICROSOFT_365_CREDENTIAL_PREFIX =
  "mcp.standard.microsoft_365" as const;

export const MICROSOFT_365_PACK_SCOPES = Object.freeze({
  outlook: Object.freeze(["Mail.Read", "Mail.Send", "Calendars.Read"]),
  teams: Object.freeze(["Chat.Read", "ChatMessage.Send"]),
  sharepoint: Object.freeze(["Sites.Read.All"]),
});

export type Microsoft365Pack = keyof typeof MICROSOFT_365_PACK_SCOPES;

export const MICROSOFT_365_BASE_SCOPES = Object.freeze([
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
]);

export const MICROSOFT_365_PACK_TOOLS = Object.freeze({
  outlook: Object.freeze([
    "microsoft_365.list_mail",
    "microsoft_365.send_mail",
    "microsoft_365.list_events",
  ]),
  teams: Object.freeze([
    "microsoft_365.list_chats",
    "microsoft_365.send_chat_message",
  ]),
  sharepoint: Object.freeze(["microsoft_365.search_sites"]),
});

export type Microsoft365Operation =
  | "mail.list"
  | "mail.send"
  | "calendar.list"
  | "chats.list"
  | "chat.send"
  | "sites.search";

export interface Microsoft365ServicePort {
  invoke(
    operation: Microsoft365Operation,
    input: Record<string, unknown>,
  ): Promise<unknown>;
}

export function scopesForMicrosoft365Packs(
  packs: readonly Microsoft365Pack[],
): string[] {
  return [
    ...MICROSOFT_365_BASE_SCOPES,
    ...new Set(packs.flatMap((pack) => MICROSOFT_365_PACK_SCOPES[pack])),
  ];
}

export function resourceScopesForMicrosoft365Packs(
  packs: readonly Microsoft365Pack[],
): string[] {
  return [
    "User.Read",
    ...new Set(packs.flatMap((pack) => MICROSOFT_365_PACK_SCOPES[pack])),
  ];
}

export function isMicrosoft365Pack(value: string): value is Microsoft365Pack {
  return Object.hasOwn(MICROSOFT_365_PACK_SCOPES, value);
}

export function toolsForMicrosoft365Packs(
  packs: readonly Microsoft365Pack[],
): string[] {
  return [...new Set(packs.flatMap((pack) => MICROSOFT_365_PACK_TOOLS[pack]))];
}
