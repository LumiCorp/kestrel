import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteAdminLogsBefore,
  logAdminEvent,
  parseAdminLogLevel,
} from "@/lib/admin/logs";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const bodySchema = z.object({
  before: z.string().datetime({ offset: true }),
  level: z.string().optional(),
});

export async function DELETE(request: NextRequest) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const body = bodySchema.parse(await request.json());

    const before = new Date(body.before);

    let level: ReturnType<typeof parseAdminLogLevel>;
    try {
      level = parseAdminLogLevel(body.level);
    } catch {
      return NextResponse.json({ error: "Invalid log level" }, { status: 400 });
    }
    const deletedCount = await deleteAdminLogsBefore(
      organizationId,
      before,
      level
    );

    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      level: "warn",
      category: "logs",
      action: "delete",
      targetType: "admin_event_logs",
      message: `Deleted ${deletedCount} admin log rows.`,
      metadata: {
        before: body.before,
        level: level ?? null,
        deletedCount,
      },
    });

    return NextResponse.json({ deletedCount });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
