import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { createKnowledgeDocumentFromStoredUpload } from "@/lib/knowledge/documents/runtime";
import { errorResponse } from "@/lib/knowledge/http";

const bodySchema = z.object({
  uploads: z
    .array(
      z.object({
        pathname: z.string().min(1),
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
        const response = await createKnowledgeDocumentFromStoredUpload({
          organizationId,
          uploaderUserId: session.user.id,
          pathname: upload.pathname.split("/").filter(Boolean),
        });

        return {
          pathname: upload.pathname,
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
