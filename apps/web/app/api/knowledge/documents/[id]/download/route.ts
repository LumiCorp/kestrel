import path from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { requireKnowledgeDocumentAccess } from "@/lib/knowledge/documents/access";
import { isInlineRenderableMediaType } from "@/lib/knowledge/documents/shared";
import { errorResponse } from "@/lib/knowledge/http";
import { getStorageAdapter } from "@/lib/storage";

const paramsSchema = z.object({
  id: z.string().min(1),
});

function getDispositionFilename(filename: string) {
  return filename.replace(/[\r\n"]/g, "-");
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const document = await requireKnowledgeDocumentAccess({
      organizationId,
      user: session.user,
      documentId: params.id,
    });

    const storage = getStorageAdapter();
    const buffer = await storage.getObjectBuffer(document.storageKey);
    const disposition = isInlineRenderableMediaType(document.mediaType)
      ? "inline"
      : "attachment";

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "content-type": document.mediaType || "application/octet-stream",
        "content-length": String(buffer.length),
        "content-disposition": `${disposition}; filename="${getDispositionFilename(
          path.basename(document.originalFilename)
        )}"`,
      },
    });
  } catch (error) {
    return errorResponse(error, 404);
  }
}
