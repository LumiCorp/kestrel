type GraphRecord = Record<string, unknown>;

export type Microsoft365TeamsParticipant = {
  id: string | null;
  displayName: string | null;
  email: string | null;
};

export type Microsoft365TeamsChat = {
  id: string;
  topic: string | null;
  chatType: string | null;
  createdAt: string | null;
  lastUpdatedAt: string | null;
  webUrl: string | null;
  participants: Microsoft365TeamsParticipant[];
};

export type Microsoft365TeamsMessage = {
  id: string;
  chatId: string;
  createdAt: string | null;
  lastModifiedAt: string | null;
  sender: Microsoft365TeamsParticipant | null;
  body: { format: "text" | "html" | "unknown"; content: string };
};

/** Normalize only the stable Teams fields Kestrel exposes across both hosts. */
export function normalizeMicrosoft365TeamsChats(
  items: readonly unknown[],
): Microsoft365TeamsChat[] {
  return items.map((item) => {
    const record = requireRecord(item, "Teams chat");
    return {
      id: requiredString(record.id, "Teams chat id"),
      topic: optionalString(record.topic),
      chatType: optionalString(record.chatType),
      createdAt: optionalString(record.createdDateTime),
      lastUpdatedAt: optionalString(record.lastUpdatedDateTime),
      webUrl: optionalString(record.webUrl),
      participants: Array.isArray(record.members)
        ? record.members.map(normalizeParticipant)
        : [],
    };
  });
}

export function normalizeMicrosoft365TeamsMessages(input: {
  chatId: string;
  items: readonly unknown[];
}): Microsoft365TeamsMessage[] {
  return input.items.map((item) => {
    const record = requireRecord(item, "Teams message");
    const body = asRecord(record.body);
    const contentType = optionalString(body.contentType)?.toLowerCase();
    return {
      id: requiredString(record.id, "Teams message id"),
      chatId: optionalString(record.chatId) ?? input.chatId,
      createdAt: optionalString(record.createdDateTime),
      lastModifiedAt: optionalString(record.lastModifiedDateTime),
      sender: record.from === undefined ? null : normalizeParticipant(record.from),
      body: {
        format:
          contentType === "text" || contentType === "html"
            ? contentType
            : "unknown",
        content: optionalString(body.content) ?? "",
      },
    };
  });
}

function normalizeParticipant(value: unknown): Microsoft365TeamsParticipant {
  const record = asRecord(value);
  const user = asRecord(record.user);
  const application = asRecord(record.application);
  return {
    id:
      optionalString(record.id) ??
      optionalString(user.id) ??
      optionalString(application.id),
    displayName:
      optionalString(record.displayName) ??
      optionalString(user.displayName) ??
      optionalString(application.displayName),
    email:
      optionalString(record.email) ??
      optionalString(user.email) ??
      optionalString(user.userPrincipalName),
  };
}

function requireRecord(value: unknown, label: string): GraphRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is malformed.`);
  }
  return value as GraphRecord;
}

function asRecord(value: unknown): GraphRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as GraphRecord)
    : {};
}

function requiredString(value: unknown, label: string) {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`${label} is missing.`);
  return parsed;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}
