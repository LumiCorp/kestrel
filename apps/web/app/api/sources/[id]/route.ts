import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import {
  deleteKnowledgeSource,
  updateKnowledgeSource,
  updateSourceSchema,
} from "@/lib/knowledge/mutations";

const paramsSchema = z.object({
  id: z.string().min(1),
});

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const params = paramsSchema.parse(await context.params);
    const body = updateSourceSchema.parse(await request.json());

    const source = await updateKnowledgeSource({
      actorUserId: session.user.id,
      body,
      organizationId,
      sourceId: params.id,
    });

    return NextResponse.json(source);
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const params = paramsSchema.parse(await context.params);

    await deleteKnowledgeSource({
      actorUserId: session.user.id,
      organizationId,
      sourceId: params.id,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
