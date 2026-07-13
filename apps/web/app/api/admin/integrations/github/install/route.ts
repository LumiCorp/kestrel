import { NextResponse } from "next/server";
import { createGitHubInstallationUrl } from "@/lib/integrations/github-app";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET() {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    return NextResponse.redirect(
      createGitHubInstallationUrl({
        organizationId,
        actorUserId: session.user.id,
      })
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
