import { type NextRequest, NextResponse } from "next/server";
import { runAdminToolProviderTest } from "@/lib/admin/tools";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ providerKey: string }> }
) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const { providerKey } = await context.params;
    const decodedProviderKey = decodeURIComponent(providerKey);

    const result = await runAdminToolProviderTest({
      actorUserId: session.user.id,
      organizationId,
      origin: request.nextUrl.origin,
      providerKey: decodedProviderKey,
    });

    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
