import { NextResponse } from "next/server";
import { z } from "zod";
import { getEnvironmentAppConfiguration } from "@/lib/apps/service";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({
  environmentId: routeIdSchema,
  appKey: z.string().trim().min(1).max(160),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ environmentId: string; appKey: string }> }
) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const params = paramsSchema.parse(await context.params);
    return NextResponse.json({
      configuration: await getEnvironmentAppConfiguration({
        organizationId,
        environmentId: params.environmentId,
        appKey: decodeURIComponent(params.appKey),
      }),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
