import { NextResponse } from "next/server";
import { z } from "zod";
import { startOfficialRemoteOauthApp } from "@/lib/apps/official-remote-connection";
import { getOfficialRemoteOauthApp } from "@/lib/apps/official-remote-apps";
import { getEnvironmentAppConfiguration } from "@/lib/apps/service";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({
  environmentId: routeIdSchema,
  appKey: z.string().trim().min(1).max(160),
});
const bodySchema = z.object({
  capabilityPacks: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ environmentId: string; appKey: string }> }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const params = paramsSchema.parse(await context.params);
    const appKey = decodeURIComponent(params.appKey);
    const app = getOfficialRemoteOauthApp(appKey);
    if (!app) throw new Error("This App does not support connected sign-in.");
    await getEnvironmentAppConfiguration({
      organizationId,
      environmentId: params.environmentId,
      appKey,
    });
    const origin = new URL(request.url).origin;
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const result = await startOfficialRemoteOauthApp({
      organizationId,
      environmentId: params.environmentId,
      appKey,
      actorUserId: session.user.id,
      redirectUri: `${origin}/api/environments/${encodeURIComponent(params.environmentId)}/apps/${encodeURIComponent(appKey)}/oauth/callback`,
      capabilityPacks: body.capabilityPacks,
    });
    if (!result) throw new Error("This App could not start connected sign-in.");
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
