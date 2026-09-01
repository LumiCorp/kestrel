import { createHash } from "node:crypto";
import { z } from "zod";

const gmailAddressSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const gmailAttachmentSchema = z.object({
  attachmentId: z.string(),
  filename: z.string(),
  mediaType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
});

const gmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labels: z.array(z.string()),
  internalDate: z.string().nullable(),
  from: z.array(gmailAddressSchema),
  to: z.array(gmailAddressSchema),
  cc: z.array(gmailAddressSchema),
  bcc: z.array(gmailAddressSchema),
  replyTo: z.array(gmailAddressSchema),
  subject: z.string().nullable(),
  text: z.string().nullable(),
  html: z.string().nullable(),
  attachments: z.array(gmailAttachmentSchema),
});

type GmailMessage = z.infer<typeof gmailMessageSchema>;

const rawBodySchema = z.object({
  attachmentId: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  data: z.string().optional(),
});
type RawPart = {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: z.infer<typeof rawBodySchema>;
  parts?: RawPart[];
};
const rawPartSchema: z.ZodType<RawPart> = z.lazy(() => z.object({
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  headers: z.array(z.object({ name: z.string().optional(), value: z.string().optional() })).optional(),
  body: rawBodySchema.optional(),
  parts: z.array(rawPartSchema).optional(),
}));
const rawMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string().optional(),
  payload: rawPartSchema,
});
const rawMessageListSchema = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string() })).default([]),
  nextPageToken: z.string().optional(),
});
const rawThreadSchema = z.object({
  id: z.string(),
  messages: z.array(rawMessageSchema).default([]),
});
const rawAttachmentSchema = z.object({ data: z.string() });
const sentMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  internalDate: z.string().optional(),
});

export class GmailProviderError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reconnectRequired: boolean;
  readonly outcomeUnknown: boolean;

  constructor(input: { code: string; status: number; reconnectRequired?: boolean; outcomeUnknown?: boolean }) {
    super(input.code);
    this.name = "GmailProviderError";
    this.code = input.code;
    this.status = input.status;
    this.reconnectRequired = input.reconnectRequired ?? false;
    this.outcomeUnknown = input.outcomeUnknown ?? false;
  }
}

/**
 * Submit a fully constructed Gmail MIME payload once. A connection failure or
 * unreadable successful response can occur after Gmail accepted the message,
 * so callers must surface outcome_unknown and never retry automatically.
 */
export async function sendGmailRawMessage(input: {
  accessToken: string;
  raw: string;
  threadId?: string;
  fetchImpl?: FetchLike;
}) {
  const url = gmailUrl("/users/me/messages/send");
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: input.raw, ...(input.threadId === undefined ? {} : { threadId: input.threadId }) }),
    });
  } catch {
    throw new GmailProviderError({ code: "GMAIL_OUTCOME_UNKNOWN", status: 502, outcomeUnknown: true });
  }
  if (!response.ok) throw await gmailErrorFromResponse(response);
  let body: unknown;
  try { body = await response.json(); } catch {
    throw new GmailProviderError({ code: "GMAIL_OUTCOME_UNKNOWN", status: 502, outcomeUnknown: true });
  }
  const sent = sentMessageSchema.safeParse(body);
  if (!sent.success) throw new GmailProviderError({ code: "GMAIL_OUTCOME_UNKNOWN", status: 502, outcomeUnknown: true });
  return { id: sent.data.id, threadId: sent.data.threadId, createdAt: sent.data.internalDate ?? null };
}

/** Build a Gmail raw-message value without accepting arbitrary MIME headers. */
export function createGmailRawMessage(input: {
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  text: string;
  html?: string;
  replyHeaders?: Readonly<{
    inReplyTo: string;
    references?: string | undefined;
  }> | undefined;
  attachments?: readonly Readonly<{
    filename: string;
    mediaType: string;
    bytes: Buffer;
  }>[] | undefined;
}) {
  const to = addressesForHeader(input.to, "to");
  const cc = addressesForHeader(input.cc ?? [], "cc");
  const subject = headerValue(input.subject, "subject");
  const text = bodyValue(input.text, "text");
  const html = input.html === undefined ? undefined : bodyValue(input.html, "html");
  const lines = [
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${subject}`,
    ...(input.replyHeaders
      ? [
          `In-Reply-To: ${replyHeaderValue(input.replyHeaders.inReplyTo, "in-reply-to")}`,
          ...(input.replyHeaders.references
            ? [`References: ${replyHeaderValue(input.replyHeaders.references, "references")}`]
            : []),
        ]
      : []),
    "MIME-Version: 1.0",
  ];
  const body = messageBody({ to, subject, text, html });
  const attachments = input.attachments ?? [];
  let mime: string;
  if (attachments.length === 0) {
    mime = [...lines, ...body].join("\r\n");
  } else {
    const boundary = mimeBoundary(
      `mixed|${to.join("\u0000")}|${subject}|${text}|${html ?? ""}|${attachments.map((attachment) => `${attachment.filename}:${attachment.mediaType}:${attachment.bytes.toString("base64url")}`).join("|")}`,
    );
    mime = [
      ...lines,
      `Content-Type: multipart/mixed; boundary=\"${boundary}\"`,
      "",
      `--${boundary}`,
      ...body,
      ...attachments.flatMap((attachment) => attachmentMimePart(boundary, attachment)),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }
  return Buffer.from(mime, "utf8").toString("base64url");
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function searchGmailMessages(input: {
  accessToken: string;
  query: string;
  maxResults: number;
  pageToken?: string;
  fetchImpl?: FetchLike;
}) {
  const url = gmailUrl("/users/me/messages");
  url.searchParams.set("q", input.query);
  url.searchParams.set("maxResults", String(input.maxResults));
  if (input.pageToken !== undefined) url.searchParams.set("pageToken", input.pageToken);
  const page = rawMessageListSchema.parse(await gmailJsonRequest({ ...input, url: url.toString() }));
  const messages = await Promise.all(page.messages.map((message) => getGmailMessage({
    accessToken: input.accessToken,
    messageId: message.id,
    fetchImpl: input.fetchImpl,
  })));
  return { messages, nextPageToken: page.nextPageToken ?? null };
}

export async function getGmailMessage(input: { accessToken: string; messageId: string; fetchImpl?: FetchLike }) {
  const value = rawMessageSchema.parse(await gmailJsonRequest({
    ...input,
    url: gmailUrl(`/users/me/messages/${encodeURIComponent(input.messageId)}`).toString(),
  }));
  return normalizeMessage(value);
}

/** Provider-owned recipients and RFC headers for an exact Gmail reply. */
export async function getGmailReplyTarget(input: {
  accessToken: string;
  messageId: string;
  fetchImpl?: FetchLike;
}) {
  const value = rawMessageSchema.parse(await gmailJsonRequest({
    ...input,
    url: gmailUrl(`/users/me/messages/${encodeURIComponent(input.messageId)}`).toString(),
  }));
  const headers = headersFor(value.payload);
  const recipients = addresses(
    headers.get("reply-to") || headers.get("from"),
  ).map((address) => validateReplyRecipient(address.value));
  const messageId = headers.get("message-id");
  if (!recipients.length || !messageId) {
    throw new GmailProviderError({ code: "GMAIL_INVALID_RESPONSE", status: 502 });
  }
  return {
    threadId: value.threadId,
    recipients,
    subject: replySubject(headers.get("subject")),
    inReplyTo: replyHeaderValue(messageId, "message-id"),
    ...(headers.get("references")
      ? { references: replyHeaderValue(headers.get("references")!, "references") }
      : {}),
  };
}

export async function getGmailThread(input: { accessToken: string; threadId: string; fetchImpl?: FetchLike }) {
  const value = rawThreadSchema.parse(await gmailJsonRequest({
    ...input,
    url: gmailUrl(`/users/me/threads/${encodeURIComponent(input.threadId)}`).toString(),
  }));
  return { id: value.id, messages: value.messages.map(normalizeMessage) };
}

/** Fetches provider bytes only for the explicit attachment-import operation. */
export async function getGmailAttachmentBytes(input: {
  accessToken: string;
  messageId: string;
  attachmentId: string;
  fetchImpl?: FetchLike;
}) {
  const result = rawAttachmentSchema.parse(await gmailJsonRequest({
    ...input,
    url: gmailUrl(`/users/me/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.attachmentId)}`).toString(),
  }));
  try {
    return Buffer.from(result.data, "base64url");
  } catch {
    throw new GmailProviderError({ code: "GMAIL_INVALID_RESPONSE", status: 502 });
  }
}

async function gmailJsonRequest(input: {
  accessToken: string;
  url: string;
  fetchImpl?: FetchLike;
}) {
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(input.url, {
      headers: { authorization: `Bearer ${input.accessToken}` },
    });
  } catch {
    throw new GmailProviderError({ code: "GMAIL_UNAVAILABLE", status: 502 });
  }
  if (!response.ok) throw await gmailErrorFromResponse(response);
  return response.json().catch(() => {
    throw new GmailProviderError({ code: "GMAIL_INVALID_RESPONSE", status: 502 });
  });
}

async function gmailErrorFromResponse(response: Response) {
  // Never return provider error content; status is sufficient recovery truth.
  await response.text().catch(() => "");
  return new GmailProviderError({
    code: response.status === 401
      ? "GMAIL_RECONNECT_REQUIRED"
      : response.status === 403
        ? "GMAIL_ACCESS_DENIED"
        : response.status === 429
          ? "GMAIL_RATE_LIMITED"
          : response.status >= 500
            ? "GMAIL_UNAVAILABLE"
            : "GMAIL_REQUEST_REJECTED",
    status: response.status === 429 ? 429 : response.status >= 500 ? 502 : response.status,
    reconnectRequired: response.status === 401,
  });
}

function gmailUrl(path: string) {
  return new URL(`https://gmail.googleapis.com/gmail/v1${path}`);
}

function normalizeMessage(message: z.infer<typeof rawMessageSchema>): GmailMessage {
  const headers = headersFor(message.payload);
  const leaves = flattenParts(message.payload);
  return gmailMessageSchema.parse({
    id: message.id,
    threadId: message.threadId,
    labels: message.labelIds ?? [],
    internalDate: message.internalDate ?? null,
    from: addresses(headers.get("from")),
    to: addresses(headers.get("to")),
    cc: addresses(headers.get("cc")),
    bcc: addresses(headers.get("bcc")),
    replyTo: addresses(headers.get("reply-to")),
    subject: headers.get("subject") || null,
    text: bodyFor(leaves, "text/plain"),
    html: bodyFor(leaves, "text/html"),
    attachments: leaves.flatMap((part) => {
      const attachmentId = part.body?.attachmentId;
      const filename = part.filename?.trim();
      return attachmentId && filename ? [{
        attachmentId,
        filename,
        mediaType: part.mimeType?.trim() || null,
        sizeBytes: part.body?.size ?? 0,
      }] : [];
    }),
  });
}

function headersFor(payload: RawPart) {
  return new Map(payload.headers?.flatMap((header) => {
    const key = header.name?.trim().toLowerCase();
    return key ? [[key, header.value ?? ""] as const] : [];
  }) ?? []);
}

function flattenParts(part: RawPart): RawPart[] {
  return part.parts?.length ? part.parts.flatMap(flattenParts) : [part];
}

function bodyFor(parts: RawPart[], mimeType: string) {
  const part = parts.find((candidate) => candidate.mimeType?.toLowerCase() === mimeType && candidate.body?.data);
  if (!part?.body?.data) return null;
  try {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  } catch {
    throw new GmailProviderError({ code: "GMAIL_INVALID_RESPONSE", status: 502 });
  }
}

function addresses(value: string | undefined) {
  if (!value?.trim()) return [];
  return value.split(",").map((entry) => {
    const match = entry.trim().match(/^(.*)<([^<>]+)>$/u);
    return match ? { name: match[1]!.trim(), value: match[2]!.trim() } : { name: "", value: entry.trim() };
  }).filter((entry) => entry.value.length > 0);
}

function addressesForHeader(values: readonly string[], name: string) {
  if (!values.length && name === "to") throw new Error("Gmail requires a recipient.");
  return values.map((value) => headerValue(value, name));
}
function headerValue(value: string, name: string) {
  if (!value.trim() || /[\r\n]/u.test(value)) throw new Error(`Gmail ${name} is invalid.`);
  return value.trim();
}

function replyHeaderValue(value: string, name: string) {
  if (!value.trim() || /[\r\n]/u.test(value) || value.length > 16_384) {
    throw new GmailProviderError({ code: "GMAIL_INVALID_RESPONSE", status: 502 });
  }
  return value.trim();
}

function bodyValue(value: string, name: string) {
  if (!value.length || value.includes("\u0000")) throw new Error(`Gmail ${name} is invalid.`);
  return value.replace(/\r?\n/gu, "\r\n");
}

function validateReplyRecipient(value: string) {
  const parsed = z.string().email().max(320).safeParse(value);
  if (!parsed.success) {
    throw new GmailProviderError({ code: "GMAIL_INVALID_RESPONSE", status: 502 });
  }
  return parsed.data;
}

function replySubject(subject: string | undefined) {
  const normalized = (subject ?? "").trim();
  return /^re:/iu.test(normalized) ? normalized || "Re:" : `Re: ${normalized}`.trim();
}

function mimeBoundary(seed: string) {
  return `kestrel-${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

function messageBody(input: {
  to: readonly string[];
  subject: string;
  text: string;
  html?: string | undefined;
}) {
  if (input.html === undefined) {
    return ["Content-Type: text/plain; charset=UTF-8", "", input.text];
  }
  const boundary = mimeBoundary(
    `alternative|${input.to.join("\u0000")}|${input.subject}|${input.text}|${input.html}`,
  );
  return [
    `Content-Type: multipart/alternative; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    input.text,
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    input.html,
    `--${boundary}--`,
  ];
}

function attachmentMimePart(
  boundary: string,
  attachment: { filename: string; mediaType: string; bytes: Buffer },
) {
  const filename = headerValue(attachment.filename, "attachment filename");
  const mediaType = headerValue(attachment.mediaType, "attachment media type");
  if (!/^[^/\s]+\/[^/\s;]+$/u.test(mediaType)) {
    throw new Error("Gmail attachment media type is invalid.");
  }
  return [
    `--${boundary}`,
    `Content-Type: ${mediaType}; name*=UTF-8''${encodeURIComponent(filename)}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "",
    attachment.bytes.toString("base64").replace(/.{1,76}/gu, "$&\r\n").trimEnd(),
  ];
}
