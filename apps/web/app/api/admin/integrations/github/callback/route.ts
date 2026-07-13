import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  bindGitHubInstallation,
  verifyGitHubSetupState,
} from "@/lib/integrations/github-app";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET(request: Request) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const url = new URL(request.url);
    const installationId = Number.parseInt(
      url.searchParams.get("installation_id") ?? "",
      10
    );
    const state = url.searchParams.get("state") ?? "";
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error("GitHub installation ID is invalid.");
    }
    verifyGitHubSetupState({
      state,
      organizationId,
      actorUserId: session.user.id,
    });
    const result = await bindGitHubInstallation({
      organizationId,
      installationId,
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "integrations",
      action: "github.installation.bound",
      targetType: "github_installation",
      targetId: String(installationId),
      message: `Connected GitHub App installation with ${result.repositoryCount} repositories.`,
      metadata: { repositoryCount: result.repositoryCount },
    });
    return NextResponse.redirect(
      new URL("/admin/environments?github=connected", request.url)
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
