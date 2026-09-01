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
    "microsoft_365.list_chat_messages",
    "microsoft_365.send_chat_message",
  ]),
  sharepoint: Object.freeze(["microsoft_365.search_sites"]),
});

export type Microsoft365Operation =
  | "mail.list"
  | "mail.send"
  | "calendar.list"
  | "chats.list"
  | "chat.messages.list"
  | "chat.send"
  | "sites.search";

/**
 * The native Microsoft 365 operations Kestrel One releases through its
 * hosted authorization broker. Hosted and Desktop callers use this as their
 * single source for the operation-to-tool, scope, and approval mapping.
 */
export interface Microsoft365OperationDescriptor<
  TOperation extends Microsoft365Operation = Microsoft365Operation,
> {
  /** Stable operation identity for policy, audit, and tooling surfaces. */
  readonly id: string;
  readonly inputContractId: string;
  readonly resultContractId: string;
  /** Content-free selector that a host resolves against validated input. */
  readonly approvalResourceSelector: string;
  /** Content-free audit event identity. */
  readonly auditIdentity: string;
  readonly pack: "outlook" | "teams";
  readonly requiredScopes: readonly string[];
  /** The operation accepted by Microsoft365ServicePort. */
  readonly serviceOperation: TOperation;
  readonly desktopToolName: string;
  readonly hostedToolName: string;
  readonly sideEffect: "read" | "external_side_effect";
  readonly minimumApprovalMode: "auto" | "ask";
}

export const MICROSOFT_365_OPERATION_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: "outlook.mail.read",
    inputContractId: "microsoft365.outlook.mail.list.input.v1",
    resultContractId: "microsoft365.outlook.mail.list.result.v1",
    approvalResourceSelector: "account.primary",
    auditIdentity: "microsoft365.outlook.mail.list",
    pack: "outlook",
    requiredScopes: Object.freeze(["Mail.Read"]),
    serviceOperation: "mail.list",
    desktopToolName: "microsoft_365.list_mail",
    hostedToolName: "kestrel_one.microsoft_365_list_mail",
    sideEffect: "read",
    minimumApprovalMode: "auto",
  }),
  Object.freeze({
    id: "outlook.mail.send",
    inputContractId: "microsoft365.outlook.mail.send.input.v1",
    resultContractId: "microsoft365.outlook.mail.send.result.v1",
    approvalResourceSelector: "account.primary",
    auditIdentity: "microsoft365.outlook.mail.send",
    pack: "outlook",
    requiredScopes: Object.freeze(["Mail.Send"]),
    serviceOperation: "mail.send",
    desktopToolName: "microsoft_365.send_mail",
    hostedToolName: "kestrel_one.microsoft_365_send_mail",
    sideEffect: "external_side_effect",
    minimumApprovalMode: "ask",
  }),
  Object.freeze({
    id: "outlook.calendar.read",
    inputContractId: "microsoft365.outlook.calendar.list.input.v1",
    resultContractId: "microsoft365.outlook.calendar.list.result.v1",
    approvalResourceSelector: "account.primary",
    auditIdentity: "microsoft365.outlook.calendar.list",
    pack: "outlook",
    requiredScopes: Object.freeze(["Calendars.Read"]),
    serviceOperation: "calendar.list",
    desktopToolName: "microsoft_365.list_events",
    hostedToolName: "kestrel_one.microsoft_365_list_events",
    sideEffect: "read",
    minimumApprovalMode: "auto",
  }),
  Object.freeze({
    id: "teams.chat.read",
    inputContractId: "microsoft365.teams.chats.list.input.v1",
    resultContractId: "microsoft365.teams.chats.list.result.v1",
    approvalResourceSelector: "account.primary",
    auditIdentity: "microsoft365.teams.chats.list",
    pack: "teams",
    requiredScopes: Object.freeze(["Chat.Read"]),
    serviceOperation: "chats.list",
    desktopToolName: "microsoft_365.list_chats",
    hostedToolName: "kestrel_one.microsoft_365_list_chats",
    sideEffect: "read",
    minimumApprovalMode: "auto",
  }),
  Object.freeze({
    id: "teams.chat.messages.read",
    inputContractId: "microsoft365.teams.chat.messages.list.input.v1",
    resultContractId: "microsoft365.teams.chat.messages.list.result.v1",
    approvalResourceSelector: "chat.input.chatId",
    auditIdentity: "microsoft365.teams.chat.messages.list",
    pack: "teams",
    requiredScopes: Object.freeze(["Chat.Read"]),
    serviceOperation: "chat.messages.list",
    desktopToolName: "microsoft_365.list_chat_messages",
    hostedToolName: "kestrel_one.microsoft_365_list_chat_messages",
    sideEffect: "read",
    minimumApprovalMode: "auto",
  }),
  Object.freeze({
    id: "teams.chat.send",
    inputContractId: "microsoft365.teams.chats.send.input.v1",
    resultContractId: "microsoft365.teams.chats.send.result.v1",
    approvalResourceSelector: "chat.input.chatId",
    auditIdentity: "microsoft365.teams.chats.send",
    pack: "teams",
    requiredScopes: Object.freeze(["ChatMessage.Send"]),
    serviceOperation: "chat.send",
    desktopToolName: "microsoft_365.send_chat_message",
    hostedToolName: "kestrel_one.microsoft_365_send_chat_message",
    sideEffect: "external_side_effect",
    minimumApprovalMode: "ask",
  }),
] as const satisfies readonly Microsoft365OperationDescriptor[]);

export type Microsoft365CanonicalOperation =
  (typeof MICROSOFT_365_OPERATION_DESCRIPTORS)[number]["serviceOperation"];

export function microsoft365OperationDescriptor(
  operation: Microsoft365CanonicalOperation,
): (typeof MICROSOFT_365_OPERATION_DESCRIPTORS)[number] {
  const descriptor = MICROSOFT_365_OPERATION_DESCRIPTORS.find(
    (candidate) => candidate.serviceOperation === operation,
  );
  if (descriptor === undefined) {
    throw new Error(`Microsoft 365 operation '${operation}' is not canonical.`);
  }
  return descriptor;
}

export function microsoft365MinimumApprovalMode(
  operation: Microsoft365CanonicalOperation,
): "auto" | "ask" {
  return microsoft365OperationDescriptor(operation).minimumApprovalMode;
}

export function microsoft365OperationHasRequiredScopes(input: {
  operation: Microsoft365Operation;
  grantedScopes: readonly string[];
}): boolean {
  const descriptor = MICROSOFT_365_OPERATION_DESCRIPTORS.find(
    (candidate) => candidate.serviceOperation === input.operation,
  );
  if (descriptor === undefined) return true;
  const granted = new Set(
    input.grantedScopes.map((scope) => scope.toLowerCase()),
  );
  return descriptor.requiredScopes.every((scope) =>
    granted.has(scope.toLowerCase()),
  );
}

export interface Microsoft365ServicePort {
  invoke(
    operation: Microsoft365Operation,
    input: Record<string, unknown>,
    options?: { cursorScope?: string | undefined },
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
