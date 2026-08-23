import { Readable } from "node:stream";
import { z } from "zod";
import { getFileByIdForUser } from "@/lib/files/service";
import { getManagedFileStorageProvider } from "@/lib/files/storage-provider";
import { ensureEffectiveFileAvailability } from "@/lib/files/availability";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const paramsSchema = z.object({ fileId: z.string().min(1) });

export async function GET(
  _request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { fileId } = paramsSchema.parse(await context.params);
    const file = await getFileByIdForUser({
      fileId,
      organizationId,
      userId: session.user.id,
    });
    if (file.lifecycleState !== "ready") {
      throw new Error("File content is unavailable.");
    }
    await ensureEffectiveFileAvailability({
      fileId: file.id,
      lifecycleState: file.lifecycleState,
      blobId: file.blobId,
      objectKey: file.objectKey,
      availabilityStatus: file.availabilityStatus,
      blobDeletedAt: file.blobDeletedAt,
    });
    const stream = await getManagedFileStorageProvider().readStream(file.objectKey);
    return new Response(Readable.toWeb(stream as Readable) as unknown as BodyInit, {
      headers: {
        "Content-Type": file.detectedMediaType ?? "application/octet-stream",
        "Content-Length": String(file.sizeBytes),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error, 404);
  }
}
