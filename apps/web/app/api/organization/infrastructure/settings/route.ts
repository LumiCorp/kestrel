import { NextResponse } from "next/server";
import {
  getOrganizationInfrastructureSettings,
  parseOrganizationInfrastructureSettings,
  saveOrganizationInfrastructureSettings,
} from "@/lib/environments/organization-infrastructure-settings";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    return NextResponse.json({ settings: await getOrganizationInfrastructureSettings(organizationId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Settings unavailable." }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const settings = await saveOrganizationInfrastructureSettings({
      organizationId,
      actorUserId: session.user.id,
      settings: parseOrganizationInfrastructureSettings(await request.json()),
    });
    return NextResponse.json({ settings });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Settings update failed." }, { status: 400 });
  }
}
