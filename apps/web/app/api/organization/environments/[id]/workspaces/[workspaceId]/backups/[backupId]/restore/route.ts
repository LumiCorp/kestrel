import { NextResponse } from "next/server";
import { z } from "zod";
import { restoreWorkspaceBackup } from "@/lib/environments/backups";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const restoreInputSchema = z
  .object({
    validationThreadId: z.string().uuid().optional(),
  })
  .strict();

export async function POST(
  request: Request,
  context: {
    params: Promise<{ id: string; workspaceId: string; backupId: string }>;
  }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id, workspaceId, backupId } = await context.params;
    const rawInput = await request.text();
    const input = restoreInputSchema.parse(
      rawInput.trim().length > 0 ? JSON.parse(rawInput) : {}
    );
    return NextResponse.json(
      await restoreWorkspaceBackup({
        organizationId,
        environmentId: id,
        workspaceId,
        backupId,
        actorUserId: session.user.id,
        validationThreadId: input.validationThreadId,
      })
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
