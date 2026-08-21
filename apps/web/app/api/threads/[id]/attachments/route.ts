import { NextResponse } from "next/server";
import { z } from "zod";
import { initializeThreadAttachment } from "@/lib/attachments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const paramsSchema = z.object({ id: z.string().min(1) });
const bodySchema = z.object({
  filename: z.string().min(1).max(1024),
  sizeBytes: z.number().int().nonnegative(),
  declaredMediaType: z.string().min(1).max(255).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { id: threadId } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const attachment = await initializeThreadAttachment({
      threadId,
      organizationId,
      userId: session.user.id,
      filename: body.filename,
      sizeBytes: body.sizeBytes,
      ...(body.declaredMediaType ? { declaredMediaType: body.declaredMediaType } : {}),
    });
    return NextResponse.json({
      fileId: attachment.id,
      attachmentId: attachment.id,
      filename: attachment.filename,
      sizeBytes: attachment.sizeBytes,
      status: attachment.lifecycleState,
      uploadUrl: `/api/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachment.id)}`,
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
