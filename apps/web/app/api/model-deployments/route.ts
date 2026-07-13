import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertManagedRunPodLaunchAccess,
  getManagedRunPodActor,
} from "@/lib/ai/managed-runpod-access";
import { assertManagedRunPodEnabled } from "@/lib/ai/managed-runpod-config";
import { managedRunPodErrorResponse } from "@/lib/ai/managed-runpod-http";
import {
  createManagedRunPodDeployment,
  listManagedRunPodDeployments,
  listManagedRunPodProfiles,
  sanitizeManagedRunPodProfile,
} from "@/lib/ai/managed-runpod-store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { enqueueManagedRunPodRun } from "@/lib/knowledge/queue";

const bodySchema = z.object({
  profileId: z.string().min(1),
  displayName: z.string().trim().min(1).max(120),
});

export async function GET() {
  try {
    assertManagedRunPodEnabled();
    const actor = await getManagedRunPodActor(
      await requireActiveOrganization()
    );
    let canLaunch = true;
    try {
      await assertManagedRunPodLaunchAccess(actor);
    } catch {
      canLaunch = false;
    }
    const [profiles, deployments] = await Promise.all([
      listManagedRunPodProfiles(),
      listManagedRunPodDeployments(actor.organizationId),
    ]);
    return NextResponse.json({
      profiles: profiles.map(sanitizeManagedRunPodProfile),
      deployments,
      permissions: {
        isOrganizationAdmin: actor.isOrganizationAdmin,
        isPlatformAdmin: actor.isPlatformAdmin,
        canLaunch,
      },
    });
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertManagedRunPodEnabled();
    const actor = await getManagedRunPodActor(
      await requireActiveOrganization()
    );
    await assertManagedRunPodLaunchAccess(actor);
    const body = bodySchema.parse(await request.json());
    const result = await createManagedRunPodDeployment({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      ...body,
    });
    await enqueueManagedRunPodRun(result.run!.id);
    return NextResponse.json(
      { deployment: result.deployment },
      { status: 202 }
    );
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}
