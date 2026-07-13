import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createWorkspaceBackup,
  listWorkspaceBackups,
} from "@/lib/environments/backups";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const backupInputSchema = z.object({
  reason: z
    .enum(["checkpoint", "daily", "pre_destructive", "pre_promotion"])
    .default("checkpoint"),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; workspaceId: string }> }
) {
  try {
    const { organizationId } = await requireAdminOrganization();
    const { id, workspaceId } = await context.params;
    return NextResponse.json({
      backups: await listWorkspaceBackups({
        organizationId,
        environmentId: id,
        workspaceId,
      }),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; workspaceId: string }> }
) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const { id, workspaceId } = await context.params;
    const { reason } = backupInputSchema.parse(await request.json());
    return NextResponse.json(
      await createWorkspaceBackup({
        organizationId,
        environmentId: id,
        workspaceId,
        actorUserId: session.user.id,
        reason,
      }),
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
