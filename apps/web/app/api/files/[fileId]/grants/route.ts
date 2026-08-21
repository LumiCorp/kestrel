import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import {
  publishFileToKnowledge,
  revokeFileFromKnowledge,
} from "@/lib/knowledge/documents/runtime";
import { errorResponse } from "@/lib/knowledge/http";

const paramsSchema = z.object({ fileId: z.string().min(1) });
const bodySchema = z.object({
  scope: z.enum(["project", "organization"]),
  projectId: z.string().min(1).optional(),
}).strict().refine((value) => value.scope !== "project" || Boolean(value.projectId), {
  message: "Project scope requires a project ID.",
});

export async function POST(request: Request, context: { params: Promise<{ fileId: string }> }) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { fileId } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    return NextResponse.json(await publishFileToKnowledge({
      fileId,
      organizationId,
      uploaderUserId: session.user.id,
      projectId: body.scope === "project" ? body.projectId : null,
    }), { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ fileId: string }> }) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { fileId } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    return NextResponse.json(await revokeFileFromKnowledge({
      fileId,
      organizationId,
      userId: session.user.id,
      projectId: body.scope === "project" ? body.projectId : null,
    }));
  } catch (error) {
    return errorResponse(error, 400);
  }
}
