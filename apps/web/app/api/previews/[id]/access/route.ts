import { NextResponse } from "next/server";
import {
  DesktopPreviewError,
  issueDesktopPreviewAccessForProjectMember,
} from "@/lib/environments/desktop-preview";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    return NextResponse.json(
      await issueDesktopPreviewAccessForProjectMember({
        previewId: routeIdSchema.parse((await context.params).id),
        organizationId,
        userId: session.user.id,
      }),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return error instanceof DesktopPreviewError
      ? NextResponse.json(
          { error: { code: error.code } },
          { status: error.status },
        )
      : errorResponse(error);
  }
}
