import { NextResponse } from "next/server";
import { z } from "zod";
import {
  connectEnvironmentRunPodEndpoint,
  getEnvironmentPrivateInference,
} from "@/lib/ai/environment-inference";
import {
  assertEnvironmentPrivateInferenceEnabled,
  assertManagedRunPodEnabled,
} from "@/lib/ai/managed-runpod-config";
import {
  createManagedRunPodDeployment,
  sanitizeManagedRunPodDeployment,
} from "@/lib/ai/managed-runpod-store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { enqueueManagedRunPodRun } from "@/lib/knowledge/queue";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({ id: routeIdSchema });
const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("managed"),
    profileId: z.string().min(1),
    displayName: z.string().trim().min(1).max(120),
  }),
  z.object({
    kind: z.literal("connected"),
    endpointId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u),
    displayName: z.string().trim().min(1).max(120),
    apiKey: z.string().trim().min(1),
    servedModelId: z.string().trim().min(1).max(512).optional(),
  }),
]);

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    assertEnvironmentPrivateInferenceEnabled();
    const { organizationId } = await requireOrganizationAdmin();
    const { id: environmentId } = paramsSchema.parse(await context.params);
    return NextResponse.json(
      await getEnvironmentPrivateInference({ organizationId, environmentId })
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    assertEnvironmentPrivateInferenceEnabled();
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id: environmentId } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    if (body.kind === "connected") {
      const state = await connectEnvironmentRunPodEndpoint({
        organizationId,
        environmentId,
        actorUserId: session.user.id,
        ...body,
      });
      return NextResponse.json(state, { status: 201 });
    }
    assertManagedRunPodEnabled();
    const result = await createManagedRunPodDeployment({
      organizationId,
      environmentId,
      actorUserId: session.user.id,
      profileId: body.profileId,
      displayName: body.displayName,
    });
    await enqueueManagedRunPodRun(result.run!.id);
    return NextResponse.json(
      { deployment: sanitizeManagedRunPodDeployment(result.deployment!) },
      { status: 202 }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
