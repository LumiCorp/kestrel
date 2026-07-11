import { type NextRequest, NextResponse } from "next/server";
import { countAdminLogsBefore, parseAdminLogLevel } from "@/lib/admin/logs";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET(request: NextRequest) {
  try {
    const { organizationId } = await requireAdminOrganization();
    const beforeRaw = request.nextUrl.searchParams.get("before");
    const levelRaw = request.nextUrl.searchParams.get("level");

    if (!beforeRaw) {
      return NextResponse.json(
        { error: 'Missing "before" query parameter (ISO date)' },
        { status: 400 }
      );
    }

    const before = new Date(beforeRaw);
    if (Number.isNaN(before.getTime())) {
      return NextResponse.json({ error: "Invalid query" }, { status: 400 });
    }

    let level: ReturnType<typeof parseAdminLogLevel>;
    try {
      level = parseAdminLogLevel(levelRaw);
    } catch {
      return NextResponse.json({ error: "Invalid log level" }, { status: 400 });
    }
    const total = await countAdminLogsBefore(organizationId, before, level);

    return NextResponse.json({ count: total });
  } catch (error) {
    return errorResponse(error);
  }
}
