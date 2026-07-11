import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteAdminUser, updateAdminUserRole } from "@/lib/admin/users";
import { getActiveOrganizationId, requireAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const bodySchema = z.object({
  role: z.enum(["admin", "user"]),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireAdmin();
    const { id } = await context.params;
    const body = bodySchema.parse(await request.json());
    const actor = session.user as { id?: string | null };
    const organizationId = getActiveOrganizationId(session);

    if (!id) {
      throw new Error("Invalid body");
    }

    const updated = await updateAdminUserRole({
      actorUserId: actor.id ?? "",
      organizationId,
      role: body.role,
      userId: id,
    });

    return NextResponse.json(updated);
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireAdmin();
    const { id } = await context.params;
    const actor = session.user as { id?: string | null };
    const organizationId = getActiveOrganizationId(session);

    if (!id) {
      throw new Error("Invalid body");
    }

    await deleteAdminUser({
      actorUserId: actor.id ?? "",
      organizationId,
      userId: id,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
