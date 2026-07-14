import { NextResponse } from "next/server";
import { getAppForOrganization } from "@/lib/apps/service";
import {
  canManageOrganization,
  requireActiveOrganization,
} from "@/lib/knowledge/auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ appKey: string }> }
) {
  try {
    const { appKey } = await params;
    const { organizationId, session } = await requireActiveOrganization();
    const canManage = await canManageOrganization({
      organizationId,
      userId: session.user.id,
    });
    const app = await getAppForOrganization({
      organizationId,
      userId: session.user.id,
      canManageOrganization: canManage,
      appKey: decodeURIComponent(appKey),
    });
    return app
      ? NextResponse.json(app)
      : NextResponse.json({ error: "App not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "App is unavailable." },
      { status: 401 }
    );
  }
}
