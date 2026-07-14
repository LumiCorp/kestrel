import { NextResponse } from "next/server";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { mobileProjectDto } from "@/lib/mobile/dto";
import { listProjectsForUser } from "@/lib/projects/store";

export async function GET() {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const projects = await listProjectsForUser({
      organizationId,
      userId: session.user.id,
    });
    return NextResponse.json({
      projects: projects.map(({ project }) => mobileProjectDto({ project })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
