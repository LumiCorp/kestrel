import { NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteDraftThreadAttachment,
  getThreadAttachmentForUser,
  uploadThreadAttachment,
} from "@/lib/attachments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { isKnowledgeDocumentMediaTypeSupported } from "@/lib/knowledge/documents/shared";

const paramsSchema = z.object({
  id: z.string().min(1),
  attachmentId: z.string().min(1),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; attachmentId: string }> },
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const attachment = await getThreadAttachmentForUser({
      attachmentId: params.attachmentId,
      threadId: params.id,
      organizationId,
      userId: session.user.id,
    });
    return NextResponse.json({
      fileId: attachment.id,
      attachmentId: attachment.id,
      filename: attachment.filename,
      sizeBytes: attachment.sizeBytes,
      declaredMediaType: attachment.declaredMediaType,
      detectedMediaType: attachment.detectedMediaType,
      sha256: attachment.sha256,
      status: attachment.lifecycleState,
      representationStatus: attachment.representationStatus,
      metadataOnlyReason: attachment.metadataOnlyReason,
      downloadUrl: `/api/threads/${encodeURIComponent(params.id)}/attachments/${encodeURIComponent(params.attachmentId)}/content`,
      knowledgeEligible: attachment.detectedMediaType
        ? isKnowledgeDocumentMediaTypeSupported(attachment.detectedMediaType, attachment.filename)
        : false,
    });
  } catch (error) {
    return errorResponse(error, 404);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string; attachmentId: string }> },
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const contentLengthHeader = request.headers.get("content-length");
    const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
    if (contentLength !== undefined && Number.isSafeInteger(contentLength) === false) {
      throw new Error("Content-Length is invalid.");
    }
    const attachment = await uploadThreadAttachment({
      attachmentId: params.attachmentId,
      threadId: params.id,
      organizationId,
      userId: session.user.id,
      body: request.body,
      ...(contentLength !== undefined ? { contentLength } : {}),
    });
    if (!attachment) throw new Error("Attachment upload did not complete.");
    return NextResponse.json({
      fileId: attachment.id,
      attachmentId: attachment.id,
      filename: attachment.filename,
      sizeBytes: attachment.sizeBytes,
      detectedMediaType: attachment.detectedMediaType,
      sha256: attachment.sha256,
      status: attachment.lifecycleState,
      representationStatus: attachment.representationStatus,
      metadataOnlyReason: attachment.metadataOnlyReason,
      downloadUrl: `/api/threads/${encodeURIComponent(params.id)}/attachments/${encodeURIComponent(params.attachmentId)}/content`,
      knowledgeEligible: attachment.detectedMediaType
        ? isKnowledgeDocumentMediaTypeSupported(attachment.detectedMediaType, attachment.filename)
        : false,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; attachmentId: string }> },
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const deleted = await deleteDraftThreadAttachment({
      attachmentId: params.attachmentId,
      threadId: params.id,
      organizationId,
      userId: session.user.id,
    });
    return NextResponse.json({ deleted });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
