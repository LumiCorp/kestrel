import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import {
  createKnowledgeDocumentFromStoredUpload,
  publishFileToKnowledge,
} from "@/lib/knowledge/documents/runtime";
import { errorResponse } from "@/lib/knowledge/http";

const bodySchema = z.object({
  uploads: z
    .array(
      z.object({
        pathname: z.string().min(1).optional(),
        fileId: z.string().min(1).optional(),
        projectId: z.string().min(1).nullable().optional(),
      }).refine((value) => Boolean(value.fileId || value.pathname), {
        message: "A file ID or legacy pathname is required.",
      })
    )
    .min(1)
    .max(12),
});

export async function POST(request: NextRequest) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const body = bodySchema.parse(await request.json());

    const results = await Promise.all(
      body.uploads.map(async (upload) => {
        const response = upload.fileId
          ? await publishFileToKnowledge({
              organizationId,
              uploaderUserId: session.user.id,
              fileId: upload.fileId,
              projectId: upload.projectId,
            })
          : await createKnowledgeDocumentFromStoredUpload({
              organizationId,
              uploaderUserId: session.user.id,
              pathname: (upload.pathname as string).split("/").filter(Boolean),
            });

        return {
          ...(upload.fileId ? { fileId: upload.fileId } : { pathname: upload.pathname }),
          ...response,
        };
      })
    );

    return NextResponse.json({
      count: results.length,
      results,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
