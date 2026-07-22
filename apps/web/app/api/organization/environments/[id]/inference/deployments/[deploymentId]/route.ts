import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertEnvironmentPrivateInferenceEnabled,
  assertManagedRunPodEnabled,
} from "@/lib/ai/managed-runpod-config";
import {
  getManagedRunPodDeployment,
  queueManagedRunPodDeletion,
  queueManagedRunPodRetry,
} from "@/lib/ai/managed-runpod-store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { enqueueManagedRunPodRun } from "@/lib/knowledge/queue";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({
  id: routeIdSchema,
  deploymentId: routeIdSchema,
});
const actionSchema = z.object({ action: z.literal("retry") });

async function resolveParams(context: {
  params: Promise<{ id: string; deploymentId: string }>;
}) {
  const params = paramsSchema.parse(await context.params);
  return { environmentId: params.id, deploymentId: params.deploymentId };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; deploymentId: string }> }
) {
  try {
    assertEnvironmentPrivateInferenceEnabled();
    const { organizationId } = await requireOrganizationAdmin();
    const params = await resolveParams(context);
    const result = await getManagedRunPodDeployment({
      organizationId,
      ...params,
    });
    if (!result) {
      return NextResponse.json(
        { error: "Deployment not found" },
        { status: 404 }
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; deploymentId: string }> }
) {
  try {
    assertEnvironmentPrivateInferenceEnabled();
    const { organizationId } = await requireOrganizationAdmin();
    actionSchema.parse(await request.json());
    const params = await resolveParams(context);
    const current = await getManagedRunPodDeployment({
      organizationId,
      ...params,
    });
    if (!current) {
      return NextResponse.json(
        { error: "Deployment not found" },
        { status: 404 }
      );
    }
    if (current.deployment.status === "failed") {
      assertManagedRunPodEnabled();
    }
    const result = await queueManagedRunPodRetry({
      organizationId,
      ...params,
    });
    await enqueueManagedRunPodRun(result.run!.id);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; deploymentId: string }> }
) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const result = await queueManagedRunPodDeletion({
      organizationId,
      ...(await resolveParams(context)),
    });
    if (!result) {
      return NextResponse.json(
        { error: "Deployment not found" },
        { status: 404 }
      );
    }
    if (result.run) await enqueueManagedRunPodRun(result.run.id);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
