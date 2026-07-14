import { NextResponse } from "next/server";
import { listAppsForOrganization } from "@/lib/apps/service";
import {
  canManageOrganization,
  requireActiveOrganization,
} from "@/lib/knowledge/auth";

export async function GET() {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const canManage = await canManageOrganization({
      organizationId,
      userId: session.user.id,
    });
    return NextResponse.json(
      await listAppsForOrganization({
        organizationId,
        userId: session.user.id,
        canManageOrganization: canManage,
      })
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Apps are unavailable." },
      { status: 401 }
    );
  }
}
