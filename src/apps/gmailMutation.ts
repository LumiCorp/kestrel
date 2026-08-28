import { createHash } from "node:crypto";

export class GmailMutationProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly options: { reconnectRequired?: boolean; outcomeUnknown?: boolean } = {},
  ) {
    super(code);
    this.name = "GmailMutationProviderError";
  }

  get reconnectRequired() { return this.options.reconnectRequired ?? false; }
  get outcomeUnknown() { return this.options.outcomeUnknown ?? false; }
}

/** Gmail write inputs contain approved message content; activity records do not need it. */
export function projectGmailMutationActivityInput(
  toolName: string,
  input: unknown,
): Record<string, unknown> | undefined {
  const operation = toolName === "google_workspace.send_gmail" || toolName === "kestrel_one.gmail_send_message"
    ? "gmail.messages.send"
    : toolName === "google_workspace.reply_gmail" || toolName === "kestrel_one.gmail_reply_message"
      ? "gmail.messages.reply"
      : undefined;
  if (operation === undefined || typeof input !== "object" || input === null || Array.isArray(input)) return;
  const raw = input as Record<string, unknown>;
  const prepared = typeof raw.__kestrelGmailPrepared === "object" && raw.__kestrelGmailPrepared !== null && !Array.isArray(raw.__kestrelGmailPrepared)
    ? raw.__kestrelGmailPrepared as Record<string, unknown>
    : undefined;
  const envelope = typeof prepared?.envelope === "object" && prepared.envelope !== null && !Array.isArray(prepared.envelope)
    ? prepared.envelope as Record<string, unknown>
    : undefined;
  const recipients = Array.isArray(envelope?.to) ? envelope.to.length : Array.isArray(raw.to) ? raw.to.length : 0;
  const cc = Array.isArray(envelope?.cc) ? envelope.cc.length : Array.isArray(raw.cc) ? raw.cc.length : 0;
  const attachments = Array.isArray(prepared?.attachments) ? prepared.attachments.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const attachment = value as Record<string, unknown>;
    return typeof attachment.fileId === "string" && typeof attachment.sha256 === "string"
      ? [{ fileId: attachment.fileId, sha256: attachment.sha256 }]
      : [];
  }) : [];
  return {
    operation,
    recipientCount: recipients + cc,
    attachmentCount: attachments.length,
    attachments,
    ...(typeof envelope?.threadId === "string" ? { providerThreadId: envelope.threadId } : {}),
  };
}

export function createGmailMutationRawMessage(input: {
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  text: string;
  html?: string | undefined;
  replyHeaders?: { inReplyTo: string; references?: string | undefined } | undefined;
  attachments?: readonly { filename: string; mediaType: string; bytes: Buffer }[] | undefined;
}) {
  const header = (value: string, label: string) => {
    if (!value.trim() || /[\r\n]/u.test(value)) throw new Error(`Gmail ${label} is invalid.`);
    return value.trim();
  };
  if (input.to.length === 0) throw new Error("Gmail requires a recipient.");
  const text = input.text.replace(/\r?\n/gu, "\r\n");
  const attachments = input.attachments ?? [];
  const boundary = `kestrel-${createHash("sha256").update(JSON.stringify({ to: input.to, cc: input.cc ?? [], subject: input.subject, text, html: input.html, attachments: attachments.map((attachment) => [attachment.filename, attachment.mediaType, createHash("sha256").update(attachment.bytes).digest("hex")]) })).digest("hex").slice(0, 24)}`;
  const headers = [
    `To: ${input.to.map((value) => header(value, "recipient")).join(", ")}`,
    ...((input.cc ?? []).length === 0 ? [] : [`Cc: ${(input.cc ?? []).map((value) => header(value, "cc")).join(", ")}`]),
    `Subject: ${header(input.subject, "subject")}`,
    ...(input.replyHeaders === undefined ? [] : [`In-Reply-To: ${header(input.replyHeaders.inReplyTo, "reply header")}`, ...(input.replyHeaders.references === undefined ? [] : [`References: ${header(input.replyHeaders.references, "reply header")}`])]),
    "MIME-Version: 1.0",
  ];
  const body = input.html === undefined
    ? ["Content-Type: text/plain; charset=UTF-8", "", text]
    : [`Content-Type: multipart/alternative; boundary=\"${boundary}-alt\"`, "", `--${boundary}-alt`, "Content-Type: text/plain; charset=UTF-8", "", text, `--${boundary}-alt`, "Content-Type: text/html; charset=UTF-8", "", input.html.replace(/\r?\n/gu, "\r\n"), `--${boundary}-alt--`];
  const mime = attachments.length === 0
    ? [...headers, ...body].join("\r\n")
    : [...headers, `Content-Type: multipart/mixed; boundary=\"${boundary}\"`, "", `--${boundary}`, ...body, ...attachments.flatMap((attachment) => [`--${boundary}`, `Content-Type: ${header(attachment.mediaType, "attachment media type")}; name=\"${header(attachment.filename, "attachment filename")}\"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename=\"${header(attachment.filename, "attachment filename")}\"`, "", attachment.bytes.toString("base64")]), `--${boundary}--`, ""].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

export async function sendGmailMutation(input: {
  accessToken: string;
  raw: string;
  threadId?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}) {
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: input.raw, ...(input.threadId === undefined ? {} : { threadId: input.threadId }) }),
    });
  } catch {
    throw new GmailMutationProviderError("GMAIL_OUTCOME_UNKNOWN", 502, { outcomeUnknown: true });
  }
  if (!response.ok) throw await gmailMutationError(response);
  const body = await response.json().catch(() => {
    throw new GmailMutationProviderError("GMAIL_OUTCOME_UNKNOWN", 502, { outcomeUnknown: true });
  });
  if (typeof body !== "object" || body === null || Array.isArray(body) || typeof (body as Record<string, unknown>).id !== "string" || typeof (body as Record<string, unknown>).threadId !== "string") {
    throw new GmailMutationProviderError("GMAIL_OUTCOME_UNKNOWN", 502, { outcomeUnknown: true });
  }
  const sent = body as Record<string, unknown>;
  return { id: sent.id as string, threadId: sent.threadId as string, createdAt: typeof sent.internalDate === "string" ? sent.internalDate : null };
}

async function gmailMutationError(response: Response) {
  await response.text().catch(() => "");
  if (response.status === 401) return new GmailMutationProviderError("GMAIL_RECONNECT_REQUIRED", 401, { reconnectRequired: true });
  if (response.status === 403) return new GmailMutationProviderError("GMAIL_ACCESS_DENIED", 403);
  if (response.status === 429) return new GmailMutationProviderError("GMAIL_RATE_LIMITED", 429);
  return new GmailMutationProviderError(response.status >= 500 ? "GMAIL_UNAVAILABLE" : "GMAIL_REQUEST_REJECTED", response.status >= 500 ? 502 : response.status);
}
