import { NextResponse } from "next/server";
import { z } from "zod";
import { getManagedRunPodActor } from "@/lib/ai/managed-runpod-access";
import { assertManagedRunPodEnabled } from "@/lib/ai/managed-runpod-config";
import { managedRunPodErrorResponse } from "@/lib/ai/managed-runpod-http";
import {
  listManagedRunPodOrganizationAccess,
  setManagedRunPodEntitlement,
} from "@/lib/ai/managed-runpod-store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";

const bodySchema = z.object({
  userId: z.string().min(1),
  entitled: z.boolean(),
});

export async function GET() {
  try {
    assertManagedRunPodEnabled();
    const actor = await getManagedRunPodActor(
      await requireActiveOrganization()
    );
    if (!(actor.isOrganizationAdmin || actor.isPlatformAdmin)) {
      throw new Error("Forbidden");
    }
    return NextResponse.json(
      await listManagedRunPodOrganizationAccess(actor.organizationId)
    );
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertManagedRunPodEnabled();
    const actor = await getManagedRunPodActor(
      await requireActiveOrganization()
    );
    if (!(actor.isOrganizationAdmin || actor.isPlatformAdmin)) {
      throw new Error("Forbidden");
    }
    const body = bodySchema.parse(await request.json());
    const entitlement = await setManagedRunPodEntitlement({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      ...body,
    });
    return NextResponse.json({ entitlement });
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}
