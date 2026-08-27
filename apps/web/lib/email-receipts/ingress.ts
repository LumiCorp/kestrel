import "server-only";

import { Resend } from "resend";
import { z } from "zod";
import { resolveReceivingIngressAuthority } from "@/lib/email/receiving-config";
import { enqueueEmailDeliveryReceipt } from "@/lib/turns/queue";
import {
  createOrFindQueuedEmailDeliveryReceipt,
  EmailDeliveryReceiptConflictError,
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
  | "invalid_signature"
  | "invalid_event"
  | "accepted"
  | "accepted_dispatch_pending"
  | "receipt_conflict"
  | "internal_failure";

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

  const rawBody = await request.text();
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
