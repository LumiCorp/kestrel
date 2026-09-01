import { z } from "zod";
import {
  MICROSOFT_365_OPERATION_DESCRIPTORS,
  microsoft365OperationHasRequiredScopes,
  microsoft365MinimumApprovalMode,
  microsoft365OperationDescriptor,
} from "../../../../src/apps/microsoft365.js";

export const MICROSOFT_365_PROVIDER_KEY = "microsoft_365";

export const MICROSOFT_365_PACKS = {
  outlook: {
    name: "Outlook",
    description: "Read mail and calendars, and send mail with approval.",
    scopes: ["Mail.Read", "Mail.Send", "Calendars.Read"],
  },
  teams: {
    name: "Teams",
    description: "Read the user's chats and send chat messages.",
    scopes: [
      ...new Set(
        MICROSOFT_365_OPERATION_DESCRIPTORS.filter(
          (operation) => operation.pack === "teams",
        ).flatMap(
          (operation) => operation.requiredScopes,
        ),
      ),
    ],
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
  "teams.chat.messages.read",
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
    cursor: z.string().trim().min(1).max(4096).optional(),
    maxResults: z.number().int().min(1).max(50).default(20),
  }).strict(),
  z.object({
    operation: z.literal("chat.messages.list"),
    chatId: z.string().trim().min(1).max(512),
    cursor: z.string().trim().min(1).max(4096).optional(),
    maxResults: z.number().int().min(1).max(50).default(20),
  }).strict(),
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
  if (
    operation === "chats.list" ||
    operation === "chat.messages.list" ||
    operation === "chat.send"
  ) {
    return microsoft365OperationDescriptor(operation).id as Microsoft365Capability;
  }
  return "sharepoint.sites.search" as const;
}

export function requiresMicrosoft365Approval(
  capability: Microsoft365Capability
) {
  if (capability === "teams.chat.send") {
    return microsoft365MinimumApprovalMode("chat.send") === "ask";
  }
  return capability === "outlook.mail.send";
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

export function hasMicrosoft365CapabilityScopes(input: {
  grantedScopes: readonly string[];
  capability: Microsoft365Capability;
}) {
  const operationByCapability: Partial<Record<Microsoft365Capability, Microsoft365RuntimeInput["operation"]>> = {
    "outlook.mail.read": "mail.list",
    "outlook.mail.send": "mail.send",
    "outlook.calendar.read": "calendar.list",
    "teams.chat.read": "chats.list",
    "teams.chat.messages.read": "chat.messages.list",
    "teams.chat.send": "chat.send",
  };
  const operation = operationByCapability[input.capability];
  return operation
    ? microsoft365OperationHasRequiredScopes({
        operation,
        grantedScopes: input.grantedScopes,
      })
    : true;
}

/**
 * The hosted personal-connection surface releases Outlook and Teams. SharePoint
 * remains outside the hosted broker's Platform registration envelope.
 */
export function requireMicrosoft365HostedConnectionPacks(
  packs: readonly Microsoft365Pack[],
) {
  const hostedPacks = packs.filter(
    (pack): pack is "outlook" | "teams" =>
      pack === "outlook" || pack === "teams",
  );
  if (!hostedPacks.length || hostedPacks.length !== packs.length) {
    throw new Error(
      "Only Outlook and Teams capability packs are available through this connection.",
    );
  }
  return (["outlook", "teams"] as const).filter((pack) =>
    hostedPacks.includes(pack),
  );
}

/**
 * ChatMessage.Send is an administrator-consented Microsoft permission. Its
 * absence is a send-specific recovery state; Chat.Read stays independently
 * usable for the same connection.
 */
export function microsoft365TeamsSendEligibility(
  grantedScopes: readonly string[],
) {
  return hasMicrosoft365CapabilityScopes({
    grantedScopes,
    capability: "teams.chat.send",
  })
    ? "granted"
    : "tenant_admin_consent_required";
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
