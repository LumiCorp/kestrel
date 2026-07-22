import { z } from "zod";

export const MICROSOFT_365_PROVIDER_KEY = "microsoft_365";
export const MICROSOFT_365_AUTH_PROVIDER_ID = "microsoft-entra-id";

export const MICROSOFT_365_PACKS = {
  outlook: {
    name: "Outlook",
    description: "Read mail and calendars, and send mail with approval.",
    scopes: ["Mail.Read", "Mail.Send", "Calendars.Read"],
  },
  teams: {
    name: "Teams",
    description: "Read the user's chats and send chat messages.",
    scopes: ["Chat.Read", "ChatMessage.Send"],
  },
  sharepoint: {
    name: "SharePoint",
    description: "Find SharePoint sites and shared content the user can access.",
    scopes: ["Sites.Read.All"],
  },
} as const;

export type Microsoft365Pack = keyof typeof MICROSOFT_365_PACKS;

export const MICROSOFT_365_CAPABILITIES = [
  "outlook.mail.read",
  "outlook.mail.send",
  "outlook.calendar.read",
  "teams.chat.read",
  "teams.chat.send",
  "sharepoint.sites.search",
] as const;

export type Microsoft365Capability =
  (typeof MICROSOFT_365_CAPABILITIES)[number];

export const microsoft365RuntimeInputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("mail.list"),
    maxResults: z.number().int().min(1).max(50).default(20),
  }),
  z.object({
    operation: z.literal("mail.send"),
    to: z.array(z.string().email()).min(1).max(50),
    cc: z.array(z.string().email()).max(50).default([]),
    subject: z.string().trim().min(1).max(998),
    body: z.string().min(1).max(100_000),
  }),
  z.object({
    operation: z.literal("calendar.list"),
    timeMin: z.string().datetime({ offset: true }),
    timeMax: z.string().datetime({ offset: true }),
    maxResults: z.number().int().min(1).max(100).default(50),
  }),
  z.object({
    operation: z.literal("chats.list"),
    chatId: z.string().trim().min(1).max(512).optional(),
    maxResults: z.number().int().min(1).max(50).default(20),
  }),
  z.object({
    operation: z.literal("chat.send"),
    chatId: z.string().trim().min(1).max(512),
    content: z.string().trim().min(1).max(28_000),
  }),
  z.object({
    operation: z.literal("sites.search"),
    query: z.string().trim().min(1).max(256),
    maxResults: z.number().int().min(1).max(50).default(20),
  }),
]);

export type Microsoft365RuntimeInput = z.infer<
  typeof microsoft365RuntimeInputSchema
>;

export function capabilityForMicrosoft365Operation(
  operation: Microsoft365RuntimeInput["operation"]
): Microsoft365Capability {
  if (operation === "mail.list") return "outlook.mail.read" as const;
  if (operation === "mail.send") return "outlook.mail.send" as const;
  if (operation === "calendar.list") return "outlook.calendar.read" as const;
  if (operation === "chats.list") return "teams.chat.read" as const;
  if (operation === "chat.send") return "teams.chat.send" as const;
  return "sharepoint.sites.search" as const;
}

export function requiresMicrosoft365Approval(
  capability: Microsoft365Capability
) {
  return capability === "outlook.mail.send" || capability === "teams.chat.send";
}

export const microsoft365ConnectionInputSchema = z.object({
  packs: z
    .array(z.enum(["outlook", "teams", "sharepoint"]))
    .min(1)
    .transform((packs) => [...new Set(packs)]),
});

export function scopesForMicrosoft365Packs(
  packs: readonly Microsoft365Pack[]
) {
  return [
    "openid",
    "profile",
    "email",
    "offline_access",
    "User.Read",
    ...new Set(packs.flatMap((pack) => MICROSOFT_365_PACKS[pack].scopes)),
  ];
}

export function resourceScopesForMicrosoft365Packs(
  packs: readonly Microsoft365Pack[]
) {
  return [
    "User.Read",
    ...new Set(packs.flatMap((pack) => MICROSOFT_365_PACKS[pack].scopes)),
  ];
}

export function parseMicrosoftOAuthScopes(scope: string | null | undefined) {
  return (scope ?? "")
    .split(/[\s,]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function hasMicrosoft365PackScopes(input: {
  grantedScopes: readonly string[];
  packs: readonly Microsoft365Pack[];
}) {
  const granted = new Set(input.grantedScopes.map((scope) => scope.toLowerCase()));
  return resourceScopesForMicrosoft365Packs(input.packs).every((scope) =>
    granted.has(scope.toLowerCase())
  );
}

export function parseMicrosoft365Packs(value: unknown): Microsoft365Pack[] {
  const parsed = z
    .array(z.enum(["outlook", "teams", "sharepoint"]))
    .safeParse(value);
  return parsed.success ? [...new Set(parsed.data)] : [];
}

export function microsoft365PackAllowsCapability(input: {
  selectedPacks: readonly Microsoft365Pack[];
  capabilityMetadata: unknown;
}) {
  const metadata =
    input.capabilityMetadata &&
    typeof input.capabilityMetadata === "object" &&
    !Array.isArray(input.capabilityMetadata)
      ? (input.capabilityMetadata as Record<string, unknown>)
      : {};
  return (
    typeof metadata.pack === "string" &&
    input.selectedPacks.includes(metadata.pack as Microsoft365Pack)
  );
}
