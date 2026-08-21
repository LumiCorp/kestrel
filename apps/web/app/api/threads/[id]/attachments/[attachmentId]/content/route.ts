import { Readable } from "node:stream";
import { z } from "zod";
import { getThreadAttachmentForUser } from "@/lib/attachments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { getStorageAdapter } from "@/lib/storage";

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
    if (attachment.lifecycleState !== "ready") {
      throw new Error("Attachment content is unavailable.");
    }
    const stream = await getStorageAdapter().getObjectStream(attachment.objectKey);
    return new Response(Readable.toWeb(stream as Readable) as unknown as BodyInit, {
      headers: {
        "Content-Type": attachment.detectedMediaType ?? "application/octet-stream",
        "Content-Length": String(attachment.sizeBytes),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error, 404);
  }
}
