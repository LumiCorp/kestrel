import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { reindexKnowledgeDocumentForUser } from "@/lib/knowledge/mutations";

const paramsSchema = z.object({
  id: z.string().min(1),
});

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const user = session.user as { id?: string | null; role?: string | null };
    const result = await reindexKnowledgeDocumentForUser({
      actorUser: user,
      documentId: params.id,
      organizationId,
      requestedByUserId: session.user.id,
    });

    return NextResponse.json({
      run: result.run,
      message: result.message,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
