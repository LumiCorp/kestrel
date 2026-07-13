import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertManagedRunPodDeleteAccess,
  assertManagedRunPodLaunchAccess,
  getManagedRunPodActor,
} from "@/lib/ai/managed-runpod-access";
import { assertManagedRunPodEnabled } from "@/lib/ai/managed-runpod-config";
import { managedRunPodErrorResponse } from "@/lib/ai/managed-runpod-http";
import {
  getManagedRunPodDeployment,
  queueManagedRunPodDeletion,
  queueManagedRunPodRetry,
  sanitizeManagedRunPodDeployment,
} from "@/lib/ai/managed-runpod-store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { enqueueManagedRunPodRun } from "@/lib/knowledge/queue";

const paramsSchema = z.object({ id: z.string().min(1) });
const actionSchema = z.object({ action: z.literal("retry") });

async function resolveOwnedDeployment(
  context: { params: Promise<{ id: string }> },
  organizationId: string
) {
  const { id } = paramsSchema.parse(await context.params);
  const result = await getManagedRunPodDeployment({
    deploymentId: id,
    organizationId,
  });
  if (!result) {
    throw new Error("Managed RunPod deployment not found.");
  }
  return result;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    assertManagedRunPodEnabled();
    const actor = await getManagedRunPodActor(
      await requireActiveOrganization()
    );
    return NextResponse.json(
      await resolveOwnedDeployment(context, actor.organizationId)
    );
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    assertManagedRunPodEnabled();
    const actor = await getManagedRunPodActor(
      await requireActiveOrganization()
    );
    actionSchema.parse(await request.json());
    const { deployment } = await resolveOwnedDeployment(
      context,
      actor.organizationId
    );
    assertManagedRunPodDeleteAccess({
      creatorUserId: deployment.createdByUserId,
      actorUserId: actor.userId,
      isOrganizationAdmin: actor.isOrganizationAdmin,
      isPlatformAdmin: actor.isPlatformAdmin,
    });
    if (deployment.status === "failed") {
      await assertManagedRunPodLaunchAccess(actor);
    }
    const result = await queueManagedRunPodRetry({
      deploymentId: deployment.id,
      organizationId: actor.organizationId,
    });
    await enqueueManagedRunPodRun(result.run!.id);
    return NextResponse.json(
      { deployment: sanitizeManagedRunPodDeployment(result.deployment!) },
      { status: 202 }
    );
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    assertManagedRunPodEnabled();
    const actor = await getManagedRunPodActor(
      await requireActiveOrganization()
    );
    const { deployment } = await resolveOwnedDeployment(
      context,
      actor.organizationId
    );
    assertManagedRunPodDeleteAccess({
      creatorUserId: deployment.createdByUserId,
      actorUserId: actor.userId,
      isOrganizationAdmin: actor.isOrganizationAdmin,
      isPlatformAdmin: actor.isPlatformAdmin,
    });
    const result = await queueManagedRunPodDeletion({
      deploymentId: deployment.id,
      organizationId: actor.organizationId,
    });
    if (result?.run) {
      await enqueueManagedRunPodRun(result.run.id);
    }
    return NextResponse.json(
      {
        deployment: result?.deployment
          ? sanitizeManagedRunPodDeployment(result.deployment)
          : deployment,
      },
      { status: 202 }
    );
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}
