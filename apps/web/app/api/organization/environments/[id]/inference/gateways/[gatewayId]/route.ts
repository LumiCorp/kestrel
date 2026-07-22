import { NextResponse } from "next/server";
import { z } from "zod";
import {
  removeEnvironmentConnectedEndpoint,
  resyncEnvironmentRunPodEndpoint,
  validateAndEnableEnvironmentRunPodModel,
  validateAndEnableEnvironmentRunPodModelByRawId,
} from "@/lib/ai/environment-inference";
import { assertEnvironmentPrivateInferenceEnabled } from "@/lib/ai/managed-runpod-config";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({ id: routeIdSchema, gatewayId: routeIdSchema });
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sync") }),
  z.object({ action: z.literal("validate"), modelId: routeIdSchema }),
  z.object({
    action: z.literal("validate_served_model"),
    servedModelId: z.string().trim().min(1).max(512),
  }),
]);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; gatewayId: string }> }
) {
  try {
    assertEnvironmentPrivateInferenceEnabled();
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id: environmentId, gatewayId } = paramsSchema.parse(
      await context.params
    );
    const body = actionSchema.parse(await request.json());
    if (body.action === "sync") {
      return NextResponse.json(
        await resyncEnvironmentRunPodEndpoint({
          organizationId,
          environmentId,
          gatewayId,
        })
      );
    }
    if (body.action === "validate_served_model") {
      return NextResponse.json(
        await validateAndEnableEnvironmentRunPodModelByRawId({
          organizationId,
          environmentId,
          gatewayId,
          rawModelId: body.servedModelId,
          actorUserId: session.user.id,
        })
      );
    }
    return NextResponse.json(
      await validateAndEnableEnvironmentRunPodModel({
        organizationId,
        environmentId,
        gatewayId,
        modelId: body.modelId,
        actorUserId: session.user.id,
      })
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; gatewayId: string }> }
) {
  try {
    assertEnvironmentPrivateInferenceEnabled();
    const { organizationId } = await requireOrganizationAdmin();
    const { id: environmentId, gatewayId } = paramsSchema.parse(
      await context.params
    );
    await removeEnvironmentConnectedEndpoint({
      organizationId,
      environmentId,
      gatewayId,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
