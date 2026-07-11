import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getArtifactSuggestionsByDocumentId } from "@/lib/artifacts/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const paramsSchema = z.object({
  id: z.string().min(1),
});

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const suggestions = await getArtifactSuggestionsByDocumentId({
      documentId: params.id,
      userId: session.user.id,
      organizationId,
    });

    return NextResponse.json(suggestions);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
