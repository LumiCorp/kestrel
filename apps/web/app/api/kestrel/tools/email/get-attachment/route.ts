import { NextResponse } from "next/server";
import { z } from "zod";
import { parseEmailAttachmentCapabilityRequest } from "@/lib/agent/kestrel-capabilities";
import {
  EmailAttachmentReadError,
  importEmailDeliveryAttachment,
} from "@/lib/email-receipts/attachment-import";
import { openVisibleFileForThread } from "@/lib/files/service";
import { errorResponse } from "@/lib/knowledge/http";

const payloadSchema = z.object({
  attachmentId: z.string().trim().min(1).max(200),
}).strict();

export async function POST(request: Request) {
  try {
    const ticket = parseEmailAttachmentCapabilityRequest({
      request,
      environmentTicketPublicKey:
        process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY,
    });
    const payload = payloadSchema.parse(await request.json());
    const imported = await importEmailDeliveryAttachment({
      ticket,
      attachmentId: payload.attachmentId,
    });
    return NextResponse.json(await openVisibleFileForThread({
      fileId: imported.fileId,
      threadId: ticket.threadId,
      organizationId: ticket.organizationId,
      userId: ticket.actorId,
    }));
  } catch (error) {
    if (error instanceof EmailAttachmentReadError) {
      return NextResponse.json(
        { error: { code: error.code, retryable: error.retryable } },
        { status: error.retryable ? 503 : 409 },
      );
    }
    return errorResponse(error, 400);
  }
}
