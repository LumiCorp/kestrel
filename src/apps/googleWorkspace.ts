export const GOOGLE_WORKSPACE_APP_ID = "google_workspace" as const;
export const GOOGLE_WORKSPACE_CREDENTIAL_PREFIX =
  "mcp.standard.google_workspace" as const;

/**
 * Identity and refresh scopes needed for every native Google Workspace
 * connection. Capability packs must remain resource-specific so an
 * incremental consent request can name only the newly selected resource.
 */
export const GOOGLE_WORKSPACE_BASE_SCOPES = Object.freeze([
  "openid",
  "email",
  "profile",
]);

export const GOOGLE_WORKSPACE_PACK_SCOPES = Object.freeze({
  calendar: Object.freeze([
    "https://www.googleapis.com/auth/calendar.events.owned",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
  ]),
  gmail: Object.freeze([
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ]),
});
export type GoogleWorkspacePack = keyof typeof GOOGLE_WORKSPACE_PACK_SCOPES;

export const GOOGLE_WORKSPACE_PACK_TOOLS = Object.freeze({
  calendar: Object.freeze([
    "google_workspace.list_events",
    "google_workspace.create_event",
    "google_workspace.update_event",
    "google_workspace.delete_event",
  ]),
  gmail: Object.freeze([
    "google_workspace.search_gmail",
    "google_workspace.get_gmail_message",
    "google_workspace.get_gmail_thread",
    "google_workspace.import_gmail_attachment",
  ]),
});

export type GoogleWorkspaceOperation =
  | "events.list"
  | "events.create"
  | "events.update"
  | "events.delete"
  | "gmail.messages.search"
  | "gmail.messages.get"
  | "gmail.threads.get"
  | "gmail.attachments.import"
  | "gmail.messages.send"
  | "gmail.messages.reply";

/**
 * Provider-neutral Calendar event shape returned by both hosted and Desktop
 * Google Workspace operations. Keep this conversion shared so a model does
 * not receive different Calendar fields solely because it runs on Desktop.
 */
export function normalizeGoogleCalendarEvent(value: unknown) {
  const event = googleCalendarRecord(value, "Google Calendar event");
  const attendees = event.attendees === undefined
    ? []
    : Array.isArray(event.attendees)
      ? event.attendees.map((candidate) => {
          const attendee = googleCalendarRecord(candidate, "Google Calendar attendee");
          return {
            email: googleCalendarOptionalString(attendee.email) ?? null,
            displayName: googleCalendarOptionalString(attendee.displayName) ?? null,
            responseStatus: googleCalendarOptionalString(attendee.responseStatus) ?? null,
          };
        })
      : (() => {
          throw new Error("Google Calendar event attendees are invalid.");
        })();
  return {
    id: googleCalendarRequiredString(event.id, "Google Calendar event ID"),
    status: googleCalendarOptionalString(event.status) ?? null,
    url: googleCalendarOptionalString(event.htmlLink) ?? null,
    summary: googleCalendarOptionalString(event.summary) ?? "",
    description: googleCalendarOptionalString(event.description) ?? null,
    location: googleCalendarOptionalString(event.location) ?? null,
    start: normalizeGoogleCalendarEventTime(event.start, "Google Calendar event start"),
    end: normalizeGoogleCalendarEventTime(event.end, "Google Calendar event end"),
    attendees,
    updatedAt: googleCalendarOptionalString(event.updated) ?? null,
  };
}

function normalizeGoogleCalendarEventTime(value: unknown, label: string) {
  const time = googleCalendarRecord(value, label);
  const date = googleCalendarOptionalString(time.date);
  const dateTime = googleCalendarOptionalString(time.dateTime);
  if (date === undefined && dateTime === undefined) {
    throw new Error(`${label} is invalid.`);
  }
  const timeZone = googleCalendarOptionalString(time.timeZone);
  return {
    ...(date === undefined ? {} : { date }),
    ...(dateTime === undefined ? {} : { dateTime }),
    ...(timeZone === undefined ? {} : { timeZone }),
  };
}

function googleCalendarRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function googleCalendarRequiredString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function googleCalendarOptionalString(value: unknown) {
  if (value === undefined) return undefined;
  return googleCalendarRequiredString(value, "Google Calendar string");
}

/**
 * The native Google Calendar operations Kestrel currently supports. Hosted
 * and Desktop callers can derive their tool, scope, side-effect, and minimum
 * approval contract from these descriptors.
 */
export interface GoogleWorkspaceOperationDescriptor<
  TOperation extends GoogleWorkspaceOperation = GoogleWorkspaceOperation,
> {
  /** Stable operation identity for policy, audit, and tooling surfaces. */
  readonly id: string;
  readonly inputContractId: string;
  readonly resultContractId: string;
  /** Content-free selector that a host resolves against validated input. */
  readonly approvalResourceSelector: string;
  /** Content-free audit event identity. */
  readonly auditIdentity: string;
  readonly pack: GoogleWorkspacePack;
  readonly requiredScopes: readonly string[];
  /** The operation accepted by GoogleWorkspaceServicePort. */
  readonly serviceOperation: TOperation;
  readonly desktopToolName: string;
  readonly hostedToolName: string;
  readonly sideEffect: "read" | "external_side_effect";
  readonly minimumApprovalMode: "auto" | "ask";
}

const GOOGLE_CALENDAR_OPERATION_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
] as const);

const GOOGLE_GMAIL_READONLY_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/gmail.readonly",
] as const);
const GOOGLE_GMAIL_SEND_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/gmail.send",
] as const);

export const GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: "calendar.events.read",
    inputContractId: "google_workspace.calendar.events.list.input.v1",
    resultContractId: "google_workspace.calendar.events.list.result.v1",
    approvalResourceSelector: "calendar.primary",
    auditIdentity: "google_workspace.calendar.events.list",
    pack: "calendar",
    requiredScopes: GOOGLE_CALENDAR_OPERATION_SCOPES,
    serviceOperation: "events.list",
    desktopToolName: "google_workspace.list_events",
    hostedToolName: "kestrel_one.google_calendar_list_events",
    sideEffect: "read",
    minimumApprovalMode: "auto",
  }),
  Object.freeze({
    id: "calendar.events.create",
    inputContractId: "google_workspace.calendar.events.create.input.v1",
    resultContractId: "google_workspace.calendar.events.create.result.v1",
    approvalResourceSelector: "calendar.primary",
    auditIdentity: "google_workspace.calendar.events.create",
    pack: "calendar",
    requiredScopes: GOOGLE_CALENDAR_OPERATION_SCOPES,
    serviceOperation: "events.create",
    desktopToolName: "google_workspace.create_event",
    hostedToolName: "kestrel_one.google_calendar_create_event",
    sideEffect: "external_side_effect",
    minimumApprovalMode: "ask",
  }),
  Object.freeze({
    id: "calendar.events.update",
    inputContractId: "google_workspace.calendar.events.update.input.v1",
    resultContractId: "google_workspace.calendar.events.update.result.v1",
    approvalResourceSelector: "calendar.primary/event.input.eventId",
    auditIdentity: "google_workspace.calendar.events.update",
    pack: "calendar",
    requiredScopes: GOOGLE_CALENDAR_OPERATION_SCOPES,
    serviceOperation: "events.update",
    desktopToolName: "google_workspace.update_event",
    hostedToolName: "kestrel_one.google_calendar_update_event",
    sideEffect: "external_side_effect",
    minimumApprovalMode: "ask",
  }),
  Object.freeze({
    id: "calendar.events.delete",
    inputContractId: "google_workspace.calendar.events.delete.input.v1",
    resultContractId: "google_workspace.calendar.events.delete.result.v1",
    approvalResourceSelector: "calendar.primary/event.input.eventId",
    auditIdentity: "google_workspace.calendar.events.delete",
    pack: "calendar",
    requiredScopes: GOOGLE_CALENDAR_OPERATION_SCOPES,
    serviceOperation: "events.delete",
    desktopToolName: "google_workspace.delete_event",
    hostedToolName: "kestrel_one.google_calendar_delete_event",
    sideEffect: "external_side_effect",
    minimumApprovalMode: "ask",
  }),
  Object.freeze({
    id: "gmail.messages.search",
    inputContractId: "google_workspace.gmail.messages.search.input.v1",
    resultContractId: "google_workspace.gmail.messages.search.result.v1",
    approvalResourceSelector: "gmail.account",
    auditIdentity: "google_workspace.gmail.messages.search",
    pack: "gmail",
    requiredScopes: GOOGLE_GMAIL_READONLY_SCOPES,
    serviceOperation: "gmail.messages.search",
    desktopToolName: "google_workspace.search_gmail",
    hostedToolName: "kestrel_one.gmail_search_messages",
    sideEffect: "read",
    minimumApprovalMode: "auto",
  }),
  Object.freeze({
    id: "gmail.messages.read",
    inputContractId: "google_workspace.gmail.messages.get.input.v1",
    resultContractId: "google_workspace.gmail.messages.get.result.v1",
    approvalResourceSelector: "gmail.account/message.input.messageId",
    auditIdentity: "google_workspace.gmail.messages.get",
    pack: "gmail",
    requiredScopes: GOOGLE_GMAIL_READONLY_SCOPES,
    serviceOperation: "gmail.messages.get",
    desktopToolName: "google_workspace.get_gmail_message",
    hostedToolName: "kestrel_one.gmail_get_message",
    sideEffect: "read",
    minimumApprovalMode: "auto",
  }),
  Object.freeze({
    id: "gmail.threads.read",
    inputContractId: "google_workspace.gmail.threads.get.input.v1",
    resultContractId: "google_workspace.gmail.threads.get.result.v1",
    approvalResourceSelector: "gmail.account/thread.input.threadId",
    auditIdentity: "google_workspace.gmail.threads.get",
    pack: "gmail",
    requiredScopes: GOOGLE_GMAIL_READONLY_SCOPES,
    serviceOperation: "gmail.threads.get",
    desktopToolName: "google_workspace.get_gmail_thread",
    hostedToolName: "kestrel_one.gmail_get_thread",
    sideEffect: "read",
    minimumApprovalMode: "auto",
  }),
  Object.freeze({
    id: "gmail.attachments.import",
    inputContractId: "google_workspace.gmail.attachments.import.input.v1",
    resultContractId: "google_workspace.gmail.attachments.import.result.v1",
    approvalResourceSelector: "gmail.account/message.input.messageId/attachment.input.attachmentId",
    auditIdentity: "google_workspace.gmail.attachments.import",
    pack: "gmail",
    requiredScopes: GOOGLE_GMAIL_READONLY_SCOPES,
    serviceOperation: "gmail.attachments.import",
    desktopToolName: "google_workspace.import_gmail_attachment",
    hostedToolName: "kestrel_one.gmail_import_attachment",
    sideEffect: "read",
    minimumApprovalMode: "auto",
  }),
  Object.freeze({
    id: "gmail.messages.send",
    inputContractId: "google_workspace.gmail.messages.send.input.v1",
    resultContractId: "google_workspace.gmail.messages.send.result.v1",
    approvalResourceSelector: "gmail.account",
    auditIdentity: "google_workspace.gmail.messages.send",
    pack: "gmail",
    requiredScopes: GOOGLE_GMAIL_SEND_SCOPES,
    serviceOperation: "gmail.messages.send",
    desktopToolName: "google_workspace.send_gmail",
    hostedToolName: "kestrel_one.gmail_send_message",
    sideEffect: "external_side_effect",
    minimumApprovalMode: "ask",
  }),
  Object.freeze({
    id: "gmail.messages.reply",
    inputContractId: "google_workspace.gmail.messages.reply.input.v1",
    resultContractId: "google_workspace.gmail.messages.reply.result.v1",
    approvalResourceSelector: "gmail.account/message.input.messageId",
    auditIdentity: "google_workspace.gmail.messages.reply",
    pack: "gmail",
    requiredScopes: GOOGLE_GMAIL_SEND_SCOPES,
    serviceOperation: "gmail.messages.reply",
    desktopToolName: "google_workspace.reply_gmail",
    hostedToolName: "kestrel_one.gmail_reply_message",
    sideEffect: "external_side_effect",
    minimumApprovalMode: "ask",
  }),
] as const satisfies readonly GoogleWorkspaceOperationDescriptor[]);

export type GoogleWorkspaceCanonicalOperation =
  (typeof GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS)[number]["serviceOperation"];

export function googleWorkspaceOperationDescriptor(
  operation: GoogleWorkspaceCanonicalOperation,
): (typeof GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS)[number] {
  const descriptor = GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS.find(
    (candidate) => candidate.serviceOperation === operation,
  );
  if (descriptor === undefined) {
    throw new Error(
      `Google Workspace operation '${operation}' is not canonical.`,
    );
  }
  return descriptor;
}

export function googleWorkspaceMinimumApprovalMode(
  operation: GoogleWorkspaceCanonicalOperation,
): "auto" | "ask" {
  return googleWorkspaceOperationDescriptor(operation).minimumApprovalMode;
}

export function googleWorkspaceOperationHasRequiredScopes(input: {
  operation: GoogleWorkspaceCanonicalOperation;
  grantedScopes: readonly string[];
}): boolean {
  const granted = new Set(input.grantedScopes);
  return googleWorkspaceOperationDescriptor(
    input.operation,
  ).requiredScopes.every((scope) => granted.has(scope));
}

export interface GoogleWorkspaceServicePort {
  /**
   * Resolve provider-owned Gmail mutation state before the runtime binds an
   * approval. Implementations must ignore any caller-supplied prepared state.
   */
  prepareApprovalInput?(
    operation: Extract<
      GoogleWorkspaceOperation,
      "gmail.messages.send" | "gmail.messages.reply"
    >,
    input: Record<string, unknown>,
    options: { threadId: string },
  ): Promise<Record<string, unknown>>;
  invoke(
    operation: GoogleWorkspaceOperation,
    input: Record<string, unknown>,
    options?: {
      cursorScope?: string | undefined;
      /** Required only when an operation stores a selected item in a Thread. */
      threadId?: string | undefined;
    },
  ): Promise<unknown>;
}

export function scopesForGoogleWorkspacePacks(
  packs: readonly GoogleWorkspacePack[],
): string[] {
  return [
    ...GOOGLE_WORKSPACE_BASE_SCOPES,
    ...new Set(packs.flatMap((pack) => GOOGLE_WORKSPACE_PACK_SCOPES[pack])),
  ];
}

/** Resource scopes only, for pack-specific health and incremental consent. */
export function resourceScopesForGoogleWorkspacePacks(
  packs: readonly GoogleWorkspacePack[],
): string[] {
  return [
    ...new Set(packs.flatMap((pack) => GOOGLE_WORKSPACE_PACK_SCOPES[pack])),
  ];
}

export function isGoogleWorkspacePack(
  value: string,
): value is GoogleWorkspacePack {
  return Object.hasOwn(GOOGLE_WORKSPACE_PACK_SCOPES, value);
}
