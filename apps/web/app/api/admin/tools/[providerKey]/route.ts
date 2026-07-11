import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAdminToolProvider, saveAdminToolProvider } from "@/lib/admin/tools";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const providerPatchSchema = z.object({
  enabled: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ providerKey: string }> }
) {
  try {
    const { organizationId } = await requireAdminOrganization();
    const { providerKey } = await context.params;
    const provider = await getAdminToolProvider(
      organizationId,
      decodeURIComponent(providerKey),
      request.nextUrl.origin
    );

    if (!provider) {
      return NextResponse.json(
        { error: "Tool provider not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(provider);
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ providerKey: string }> }
) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const { providerKey } = await context.params;
    const body = providerPatchSchema.parse(await request.json());
    const decodedProviderKey = decodeURIComponent(providerKey);

    const provider = await saveAdminToolProvider({
      actorUserId: session.user.id,
      organizationId,
      providerKey: decodedProviderKey,
      enabled: body.enabled,
      settings: body.settings,
      origin: request.nextUrl.origin,
    });

    return NextResponse.json(provider);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
