import { NextResponse } from "next/server";
import { z } from "zod";
import {
  listWorkspaceBackups,
  queueWorkspaceBackup,
} from "@/lib/environments/backups";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
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
    const { organizationId } = await requireOrganizationAdmin();
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
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id, workspaceId } = await context.params;
    const { reason } = backupInputSchema.parse(await request.json());
    return NextResponse.json(
      await queueWorkspaceBackup({
        organizationId,
        environmentId: id,
        workspaceId,
        actorUserId: session.user.id,
        reason,
      }),
      { status: 202 }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
