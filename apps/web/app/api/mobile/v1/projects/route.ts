import { NextResponse } from "next/server";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { mobileProjectDto } from "@/lib/mobile/dto";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { listProjectsForUser } from "@/lib/projects/store";

export async function GET(request: Request) {
  try {
    const { session, organizationId } = await requireActiveOrganization(request);
    const projects = await listProjectsForUser({
      organizationId,
      userId: session.user.id,
    });
    return NextResponse.json({
      projects: projects.map(({ project }) => mobileProjectDto({ project })),
    });
  } catch (error) {
    return mobileErrorResponse(error);
  }
}
