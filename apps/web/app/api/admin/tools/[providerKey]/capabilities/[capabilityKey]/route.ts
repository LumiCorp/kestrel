import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { saveAdminToolCapability } from "@/lib/admin/tools";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const capabilityPatchSchema = z.object({
  enabled: z.boolean().optional(),
  approvalMode: z.enum(["auto", "ask", "deny"]).optional(),
  surfaceAccess: z
    .object({
      chat: z.boolean(),
      admin: z.boolean(),
    })
    .optional(),
  rateLimitMode: z.enum(["default", "strict", "off"]).optional(),
  loggingMode: z.enum(["full", "metadata_only", "minimal"]).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ providerKey: string; capabilityKey: string }> }
) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const { providerKey, capabilityKey } = await context.params;
    const body = capabilityPatchSchema.parse(await request.json());
    const decodedProviderKey = decodeURIComponent(providerKey);
    const decodedCapabilityKey = decodeURIComponent(capabilityKey);

    const provider = await saveAdminToolCapability({
      actorUserId: session.user.id,
      organizationId,
      providerKey: decodedProviderKey,
      capabilityKey: decodedCapabilityKey,
      patch: body,
      origin: request.nextUrl.origin,
    });

    return NextResponse.json(provider);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
