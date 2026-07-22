import { type NextRequest, NextResponse } from "next/server";
import { deleteAdminApiKey } from "@/lib/admin/api-keys";
import { logAdminEvent } from "@/lib/admin/logs";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id } = await context.params;

    const deleted = await deleteAdminApiKey(id, organizationId);
    if (!deleted) {
      return NextResponse.json({ error: "API key not found" }, { status: 404 });
    }

    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      level: "warn",
      category: "api-keys",
      action: "delete",
      targetType: "admin_api_key",
      targetId: id,
      message: `Deleted admin API key ${deleted.name}.`,
      metadata: { name: deleted.name },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
