import "server-only";

import { z } from "zod";
import { RESEND_MANAGEMENT_REQUEST_TIMEOUT_MS } from "@/lib/email/receiving-provider";
import {
  EMAIL_ATTACHMENT_MAX_COUNT,
  EMAIL_PROVIDER_ID_MAX_LENGTH,
} from "./bounds";

export type ReceivedEmailAttachment = {
  providerAttachmentId: string;
  filename: string | null;
  declaredMediaType: string;
  providerSizeBytes: number;
  disposition: string | null;
  contentId: string | null;
};

export type ReceivedEmailHydration = {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  text: string | null;
  html: string | null;
  attachments: ReceivedEmailAttachment[];
};

export interface ReceivedEmailProvider {
  retrieve(apiKey: string, emailId: string): Promise<ReceivedEmailHydration>;
}

export type EmailReceiptProviderFailureCode =
  | "EMAIL_RECEIPT_PROVIDER_TEMPORARY"
  | "EMAIL_RECEIPT_PROVIDER_PERMANENT"
  | "EMAIL_RECEIPT_PROVIDER_RESPONSE_INVALID"
  | "EMAIL_RECEIPT_CONTENT_BOUNDS_EXCEEDED";

export class EmailReceiptProviderError extends Error {
  constructor(
    readonly code: EmailReceiptProviderFailureCode,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "EmailReceiptProviderError";
  }
}

type ProviderFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const receivedEmailSchema = z
  .object({
    object: z.literal("email"),
    id: z.string().min(1).max(EMAIL_PROVIDER_ID_MAX_LENGTH),
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()).nullable(),
    bcc: z.array(z.string()).nullable(),
    reply_to: z.array(z.string()).nullable(),
    subject: z.string(),
    text: z.string().nullable(),
    html: z.string().nullable(),
  })
  .passthrough();

const attachmentSchema = z
  .object({
    id: z.string().min(1).max(EMAIL_PROVIDER_ID_MAX_LENGTH),
    filename: z.string().optional(),
    size: z.number().int().nonnegative().safe(),
    content_type: z.string(),
    content_disposition: z.string(),
    content_id: z.string().optional(),
    download_url: z.url(),
    expires_at: z.string(),
  })
  .passthrough();

const attachmentListSchema = z
  .object({
    object: z.literal("list"),
    has_more: z.boolean(),
    data: z.array(attachmentSchema),
  })
  .passthrough();

export class ResendReceivedEmailProvider implements ReceivedEmailProvider {
  readonly #fetch: ProviderFetch;
  readonly #baseUrl: URL;
  readonly #signal: AbortSignal | undefined;
  readonly #timeoutSignal: (timeoutMs: number) => AbortSignal;

  constructor(
    input: {
      fetchImpl?: ProviderFetch;
      baseUrl?: string;
      signal?: AbortSignal;
      timeoutSignal?: (timeoutMs: number) => AbortSignal;
    } = {},
  ) {
    this.#fetch = input.fetchImpl ?? fetch;
    this.#baseUrl = new URL(input.baseUrl ?? "https://api.resend.com");
    this.#signal = input.signal;
    this.#timeoutSignal =
      input.timeoutSignal ?? ((timeoutMs) => AbortSignal.timeout(timeoutMs));
  }

  async retrieve(
    apiKey: string,
    emailId: string,
  ): Promise<ReceivedEmailHydration> {
    const encodedEmailId = encodeURIComponent(emailId);
    const emailResult = receivedEmailSchema.safeParse(
      await this.#request(apiKey, `/emails/receiving/${encodedEmailId}`),
    );
    if (!(emailResult.success && emailResult.data.id === emailId)) {
      throw invalidProviderResponse();
    }
    const attachments = await this.#listAttachments(apiKey, encodedEmailId);
    return {
      id: emailResult.data.id,
      from: emailResult.data.from,
      to: emailResult.data.to,
      cc: emailResult.data.cc ?? [],
      bcc: emailResult.data.bcc ?? [],
      replyTo: emailResult.data.reply_to ?? [],
      subject: emailResult.data.subject,
      text: emailResult.data.text,
      html: emailResult.data.html,
      attachments,
    };
  }

  async #listAttachments(apiKey: string, encodedEmailId: string) {
    const attachments: ReceivedEmailAttachment[] = [];
    const attachmentIds = new Set<string>();
    const cursors = new Set<string>();
    let after: string | undefined;
    while (true) {
      const pageResult = attachmentListSchema.safeParse(
        await this.#request(
          apiKey,
          `/emails/receiving/${encodedEmailId}/attachments?limit=${EMAIL_ATTACHMENT_MAX_COUNT}${
            after === undefined ? "" : `&after=${encodeURIComponent(after)}`
          }`,
        ),
      );
      if (!pageResult.success) throw invalidProviderResponse();
      for (const attachment of pageResult.data.data) {
        if (attachmentIds.has(attachment.id)) throw invalidProviderResponse();
        attachmentIds.add(attachment.id);
        attachments.push({
          providerAttachmentId: attachment.id,
          filename: attachment.filename ?? null,
          declaredMediaType: attachment.content_type,
          providerSizeBytes: attachment.size,
          disposition: attachment.content_disposition,
          contentId: attachment.content_id ?? null,
        });
        if (attachments.length > EMAIL_ATTACHMENT_MAX_COUNT) {
          throw new EmailReceiptProviderError(
            "EMAIL_RECEIPT_CONTENT_BOUNDS_EXCEEDED",
            false,
          );
        }
      }
      if (!pageResult.data.has_more) return attachments;
      const nextCursor = pageResult.data.data.at(-1)?.id;
      if (!nextCursor || nextCursor === after || cursors.has(nextCursor)) {
        throw invalidProviderResponse();
      }
      cursors.add(nextCursor);
      after = nextCursor;
    }
  }

  async #request(apiKey: string, path: string): Promise<unknown> {
    let response: Response;
    try {
      const deadline = this.#timeoutSignal(
        RESEND_MANAGEMENT_REQUEST_TIMEOUT_MS,
      );
      response = await this.#fetch(new URL(path, this.#baseUrl), {
        signal: combineAbortSignals([this.#signal, deadline]),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "user-agent": "Kestrel-One/1.0",
        },
      });
    } catch {
      throw new EmailReceiptProviderError(
        "EMAIL_RECEIPT_PROVIDER_TEMPORARY",
        true,
      );
    }
    if (
      response.status >= 500 ||
      response.status === 408 ||
      response.status === 429
    ) {
      throw new EmailReceiptProviderError(
        "EMAIL_RECEIPT_PROVIDER_TEMPORARY",
        true,
      );
    }
    if (response.status >= 400 && response.status < 500) {
      throw new EmailReceiptProviderError(
        "EMAIL_RECEIPT_PROVIDER_PERMANENT",
        false,
      );
    }
    if (!response.ok) throw invalidProviderResponse();
    try {
      return await response.json();
    } catch {
      throw invalidProviderResponse();
    }
  }
}

function invalidProviderResponse() {
  return new EmailReceiptProviderError(
    "EMAIL_RECEIPT_PROVIDER_RESPONSE_INVALID",
    false,
  );
}

function combineAbortSignals(signals: Array<AbortSignal | null | undefined>) {
  const present = signals.filter(
    (signal): signal is AbortSignal => signal !== null && signal !== undefined,
  );
  const first = present[0];
  if (!first) throw new Error("A Resend request deadline is required.");
  return present.length === 1 ? first : AbortSignal.any(present);
}
