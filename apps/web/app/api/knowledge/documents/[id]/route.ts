import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { deleteKnowledgeDocumentForUser } from "@/lib/knowledge/mutations";

const paramsSchema = z.object({
  id: z.string().min(1),
});

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const user = session.user as { id?: string | null; role?: string | null };
    await deleteKnowledgeDocumentForUser({
      actorUser: user,
      actorUserId: session.user.id,
      documentId: params.id,
      organizationId,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
