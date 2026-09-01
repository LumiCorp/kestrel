import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const TTL_MS = 15 * 60 * 1000;

export interface GoogleCalendarPageContext {
  accountId: string;
  projectId: string;
  timeMin: string;
  timeMax: string;
  maxResults: number;
}

type Payload = GoogleCalendarPageContext & { expiresAt: number; pageToken: string };

/** Encrypts the provider token and binds it to the exact primary-calendar read. */
export function createGoogleCalendarPageCursor(input: {
  secret: string;
  context: GoogleCalendarPageContext;
  pageToken: string;
  now?: number;
}) {
  validateContext(input.context);
  if (!input.pageToken.trim()) throw new Error("Google Calendar cursor is invalid.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(input.secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify({
      ...input.context,
      expiresAt: (input.now ?? Date.now()) + TTL_MS,
      pageToken: input.pageToken,
    } satisfies Payload), "utf8")),
    cipher.final(),
  ]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function readGoogleCalendarPageCursor(input: {
  secret: string;
  cursor: string;
  context: GoogleCalendarPageContext;
  now?: number;
}) {
  validateContext(input.context);
  const parts = input.cursor.split(".");
  if (
    parts.length !== 4 ||
    parts[0] !== VERSION ||
    !isCanonicalBase64Url(parts[1]!) ||
    !isCanonicalBase64Url(parts[2]!) ||
    !isCanonicalBase64Url(parts[3]!)
  ) throw new Error("Google Calendar cursor is invalid.");
  let payload: Payload;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(input.secret), Buffer.from(parts[1]!, "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));
    payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8")) as Payload;
  } catch {
    throw new Error("Google Calendar cursor is invalid.");
  }
  validateContext(payload);
  if (
    payload.accountId !== input.context.accountId ||
    payload.projectId !== input.context.projectId ||
    payload.timeMin !== input.context.timeMin ||
    payload.timeMax !== input.context.timeMax ||
    payload.maxResults !== input.context.maxResults ||
    payload.expiresAt <= (input.now ?? Date.now()) ||
    !payload.pageToken.trim()
  ) throw new Error("Google Calendar cursor does not match this request.");
  return { pageToken: payload.pageToken };
}

function key(secret: string) {
  if (secret.length < 32) throw new Error("Google Calendar cursor secret is not configured.");
  return createHash("sha256").update(secret).digest();
}

function validateContext(context: GoogleCalendarPageContext) {
  if (
    !context || typeof context !== "object" ||
    !context.accountId || !context.projectId ||
    !Number.isSafeInteger(context.maxResults) || context.maxResults < 1 || context.maxResults > 100 ||
    !Number.isFinite(Date.parse(context.timeMin)) || !Number.isFinite(Date.parse(context.timeMax))
  ) throw new Error("Google Calendar cursor context is invalid.");
}

function isCanonicalBase64Url(value: string) {
  return /^[A-Za-z0-9_-]+$/u.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value;
}
