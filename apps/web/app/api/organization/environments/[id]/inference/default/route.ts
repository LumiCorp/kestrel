import { NextResponse } from "next/server";
import { z } from "zod";
import { setEnvironmentDefaultModel } from "@/lib/ai/environment-inference";
import { assertEnvironmentPrivateInferenceEnabled } from "@/lib/ai/managed-runpod-config";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({ id: routeIdSchema });
const bodySchema = z.object({ modelId: routeIdSchema });

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    assertEnvironmentPrivateInferenceEnabled();
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id: environmentId } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    return NextResponse.json({
      default: await setEnvironmentDefaultModel({
        organizationId,
        environmentId,
        modelId: body.modelId,
        actorUserId: session.user.id,
      }),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
