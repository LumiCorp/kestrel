import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const CURSOR_VERSION = "v1";
const CURSOR_TTL_MS = 15 * 60 * 1000;

export type Microsoft365TeamsPageOperation =
  | "chats.list"
  | "chat.messages.list";

export interface Microsoft365TeamsCursorContext {
  accountId: string;
  projectId: string;
  operation: Microsoft365TeamsPageOperation;
  chatId?: string;
  maxResults: number;
}

interface Microsoft365TeamsCursorPayload extends Microsoft365TeamsCursorContext {
  expiresAt: number;
  nextLink: string;
}

/**
 * Encrypt and authenticate a Microsoft Graph continuation URL with the exact
 * account, Project, operation shape, and requested chat that issued it.
 * The returned token is opaque: Graph URLs do not become model-visible input.
 */
export function createMicrosoft365TeamsCursor(input: {
  secret: string;
  context: Microsoft365TeamsCursorContext;
  nextLink: string;
  now?: number;
}): string {
  validateContext(input.context);
  validateGraphNextLink(input.nextLink, input.context.operation);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cursorKey(input.secret), iv);
  const plaintext = Buffer.from(
    JSON.stringify({
      ...input.context,
      expiresAt: (input.now ?? Date.now()) + CURSOR_TTL_MS,
      nextLink: input.nextLink,
    } satisfies Microsoft365TeamsCursorPayload),
    "utf8",
  );
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    CURSOR_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function readMicrosoft365TeamsCursor(input: {
  secret: string;
  cursor: string;
  context: Microsoft365TeamsCursorContext;
  now?: number;
}): { nextLink: string } {
  validateContext(input.context);
  const parts = input.cursor.split(".");
  if (parts.length !== 4 || parts[0] !== CURSOR_VERSION) {
    throw new Error("Microsoft 365 cursor is invalid.");
  }
  let payload: Microsoft365TeamsCursorPayload;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      cursorKey(input.secret),
      Buffer.from(parts[1]!, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));
    payload = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(parts[3]!, "base64url")),
        decipher.final(),
      ]).toString("utf8"),
    ) as Microsoft365TeamsCursorPayload;
  } catch {
    throw new Error("Microsoft 365 cursor is invalid.");
  }
  validatePayload(payload);
  if (
    payload.accountId !== input.context.accountId ||
    payload.projectId !== input.context.projectId ||
    payload.operation !== input.context.operation ||
    payload.chatId !== input.context.chatId ||
    payload.maxResults !== input.context.maxResults ||
    payload.expiresAt <= (input.now ?? Date.now())
  ) {
    throw new Error("Microsoft 365 cursor does not match this request.");
  }
  return { nextLink: payload.nextLink };
}

export function createMicrosoft365ChatMessagesCursor(input: {
  secret: string;
  context: Omit<Microsoft365TeamsCursorContext, "operation"> & {
    chatId: string;
  };
  nextLink: string;
  now?: number;
}) {
  return createMicrosoft365TeamsCursor({
    ...input,
    context: { ...input.context, operation: "chat.messages.list" },
  });
}

export function readMicrosoft365ChatMessagesCursor(input: {
  secret: string;
  cursor: string;
  context: Omit<Microsoft365TeamsCursorContext, "operation"> & {
    chatId: string;
  };
  now?: number;
}) {
  return readMicrosoft365TeamsCursor({
    ...input,
    context: { ...input.context, operation: "chat.messages.list" },
  });
}

function cursorKey(secret: string) {
  if (secret.length < 32) {
    throw new Error("Microsoft 365 cursor secret is not configured.");
  }
  return createHash("sha256").update(secret).digest();
}

function validateContext(context: Microsoft365TeamsCursorContext) {
  if (
    !context.accountId ||
    !context.projectId ||
    (context.operation !== "chats.list" &&
      context.operation !== "chat.messages.list") ||
    (context.operation === "chat.messages.list" && !context.chatId) ||
    (context.operation === "chats.list" && context.chatId !== undefined) ||
    !Number.isSafeInteger(context.maxResults) ||
    context.maxResults < 1 ||
    context.maxResults > 50
  ) {
    throw new Error("Microsoft 365 cursor context is invalid.");
  }
}

function validatePayload(payload: Microsoft365TeamsCursorPayload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.accountId !== "string" ||
    typeof payload.projectId !== "string" ||
    (payload.operation !== "chats.list" &&
      payload.operation !== "chat.messages.list") ||
    (payload.operation === "chat.messages.list" &&
      typeof payload.chatId !== "string") ||
    (payload.operation === "chats.list" && payload.chatId !== undefined) ||
    !Number.isSafeInteger(payload.maxResults) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    typeof payload.nextLink !== "string"
  ) {
    throw new Error("Microsoft 365 cursor is invalid.");
  }
  validateGraphNextLink(payload.nextLink, payload.operation);
}

function validateGraphNextLink(
  nextLink: string,
  operation: Microsoft365TeamsPageOperation = "chat.messages.list",
) {
  let url: URL;
  try {
    url = new URL(nextLink);
  } catch {
    throw new Error("Microsoft 365 cursor is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "graph.microsoft.com" ||
    (operation === "chats.list"
      ? url.pathname !== "/v1.0/me/chats"
      : !url.pathname.startsWith("/v1.0/chats/"))
  ) {
    throw new Error("Microsoft 365 cursor is invalid.");
  }
}
