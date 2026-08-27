import "server-only";

import { Resend } from "resend";
import { z } from "zod";
import { resolveReceivingIngressAuthority } from "@/lib/email/receiving-config";
import { enqueueEmailDeliveryReceipt } from "@/lib/turns/queue";
import {
  createOrFindQueuedEmailDeliveryReceipt,
  EmailDeliveryReceiptConflictError,
  EmailDeliveryReceiptUnavailableError,
} from "./store";

const mailbox = z.string().min(1).max(320);
const mailboxList = z.array(mailbox).max(100);
const attachmentSchema = z
  .object({
    id: z.string().min(1).max(512),
    filename: z.string().max(1024).nullable(),
    content_type: z.string().min(1).max(255),
    content_disposition: z.string().max(255).nullable(),
    content_id: z.string().max(998).nullable(),
  })
  .strict();

export const resendEmailReceivedEventSchema = z
  .object({
    type: z.literal("email.received"),
    created_at: z.iso.datetime({ offset: true }),
    data: z
      .object({
        email_id: z.string().min(1).max(512),
        created_at: z.iso.datetime({ offset: true }),
        from: mailbox,
        to: mailboxList,
        bcc: mailboxList,
        cc: mailboxList,
        message_id: z.string().min(1).max(998),
        received_for: mailboxList.optional().default([]),
        subject: z.string().max(998),
        attachments: z.array(attachmentSchema).max(100),
      })
      .strict(),
  })
  .strict();

type IngressOutcome =
  | "unavailable"
  | "payload_too_large"
  | "invalid_signature"
  | "invalid_event"
  | "accepted"
  | "accepted_dispatch_pending"
  | "receipt_conflict"
  | "internal_failure";

export const RESEND_WEBHOOK_MAX_BODY_BYTES = 2 * 1024 * 1024;

class ResendWebhookBodyTooLargeError extends Error {
  constructor() {
    super("Resend webhook body exceeds the allowed size.");
    this.name = "ResendWebhookBodyTooLargeError";
  }
}

class ResendWebhookInvalidEncodingError extends Error {
  constructor() {
    super("Resend webhook body is not valid UTF-8.");
    this.name = "ResendWebhookInvalidEncodingError";
  }
}

export function recordEmailIngressTelemetry(
  input: {
    outcome: IngressOutcome;
    durationMs: number;
    receiptId?: string;
    created?: boolean;
  },
  sink: (message: string, fields: Record<string, unknown>) => void =
    console.info,
) {
  try {
    sink("Kestrel One email ingress completed.", {
      outcome: input.outcome,
      durationMs: Math.min(
        60_000,
        Math.max(0, Math.round(input.durationMs)),
      ),
      ...(input.receiptId ? { receiptId: input.receiptId } : {}),
      ...(input.created === undefined ? {} : { created: input.created }),
    });
  } catch {
    // Telemetry is secondary evidence and cannot replace the ingress outcome.
  }
}

export async function handleResendInboundWebhook(
  request: Request,
  routeLocator: string,
) {
  const startedAt = performance.now();
  try {
    return await handleResendInboundWebhookRequest(
      request,
      routeLocator,
      startedAt,
    );
  } catch {
    recordEmailIngressTelemetry({
      outcome: "internal_failure",
      durationMs: performance.now() - startedAt,
    });
    return Response.json(
      { error: "Webhook temporarily unavailable." },
      { status: 503 },
    );
  }
}

async function handleResendInboundWebhookRequest(
  request: Request,
  routeLocator: string,
  startedAt: number,
) {
  const authority = await resolveReceivingIngressAuthority(routeLocator);
  if (!authority?.available) {
    recordEmailIngressTelemetry({
      outcome: "unavailable",
      durationMs: performance.now() - startedAt,
    });
    return Response.json({ error: "Webhook unavailable." }, { status: 404 });
  }

  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (!(id && timestamp && signature)) {
    recordEmailIngressTelemetry({
      outcome: "invalid_signature",
      durationMs: performance.now() - startedAt,
    });
    return Response.json({ error: "Invalid webhook." }, { status: 400 });
  }

  let rawBody: string;
  try {
    rawBody = await readBoundedResendWebhookBody(request);
  } catch (error) {
    if (error instanceof ResendWebhookBodyTooLargeError) {
      recordEmailIngressTelemetry({
        outcome: "payload_too_large",
        durationMs: performance.now() - startedAt,
      });
      return new Response(null, { status: 413 });
    }
    if (error instanceof ResendWebhookInvalidEncodingError) {
      recordEmailIngressTelemetry({
        outcome: "invalid_signature",
        durationMs: performance.now() - startedAt,
      });
      return Response.json({ error: "Invalid webhook." }, { status: 400 });
    }
    throw error;
  }
  let verified: unknown;
  try {
    verified = new Resend("re_webhook_verification_only").webhooks.verify({
      payload: rawBody,
      headers: { id, timestamp, signature },
      webhookSecret: authority.signingSecret,
    });
  } catch {
    recordEmailIngressTelemetry({
      outcome: "invalid_signature",
      durationMs: performance.now() - startedAt,
    });
    return Response.json({ error: "Invalid webhook." }, { status: 400 });
  }

  const event = resendEmailReceivedEventSchema.safeParse(verified);
  if (!event.success) {
    recordEmailIngressTelemetry({
      outcome: "invalid_event",
      durationMs: performance.now() - startedAt,
    });
    return Response.json({ error: "Invalid webhook." }, { status: 400 });
  }

  try {
    const stored = await createOrFindQueuedEmailDeliveryReceipt({
      organizationId: authority.organizationId,
      receivingConnectionId: authority.connectionId,
      svixId: id,
      resendEmailId: event.data.data.email_id,
      eventAt: new Date(event.data.created_at),
      claimedFrom: event.data.data.from,
      toMailboxes: event.data.data.to,
      ccMailboxes: event.data.data.cc,
      bccMailboxes: event.data.data.bcc,
      receivedForMailboxes: event.data.data.received_for,
      subject: event.data.data.subject,
    });
    let outcome: IngressOutcome = "accepted";
    if (stored.receipt.state === "queued") {
      try {
        await enqueueEmailDeliveryReceipt(stored.receipt.id);
      } catch {
        outcome = "accepted_dispatch_pending";
      }
    }
    recordEmailIngressTelemetry({
      outcome,
      durationMs: performance.now() - startedAt,
      receiptId: stored.receipt.id,
      created: stored.created,
    });
    return Response.json(
      { receiptId: stored.receipt.id, state: stored.receipt.state },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof EmailDeliveryReceiptUnavailableError) {
      recordEmailIngressTelemetry({
        outcome: "unavailable",
        durationMs: performance.now() - startedAt,
      });
      return Response.json({ error: "Webhook unavailable." }, { status: 404 });
    }
    if (error instanceof EmailDeliveryReceiptConflictError) {
      recordEmailIngressTelemetry({
        outcome: "receipt_conflict",
        durationMs: performance.now() - startedAt,
      });
      return Response.json(
        { error: "Webhook temporarily unavailable." },
        { status: 503 },
      );
    }
    throw error;
  }
}

export async function readBoundedResendWebhookBody(request: Request) {
  if (declaredBodyExceedsLimit(request.headers.get("content-length"))) {
    throw new ResendWebhookBodyTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return "";
  }

  const body = new Uint8Array(RESEND_WEBHOOK_MAX_BODY_BYTES);
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    byteLength += value.byteLength;
    if (byteLength > RESEND_WEBHOOK_MAX_BODY_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // Cancellation is best effort; the bounded public outcome is authoritative.
      }
      throw new ResendWebhookBodyTooLargeError();
    }
    body.set(value, byteLength - value.byteLength);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      body.subarray(0, byteLength),
    );
  } catch {
    throw new ResendWebhookInvalidEncodingError();
  }
}

function declaredBodyExceedsLimit(value: string | null) {
  if (!(value && /^\d+$/u.test(value))) {
    return false;
  }
  return BigInt(value) > BigInt(RESEND_WEBHOOK_MAX_BODY_BYTES);
}
