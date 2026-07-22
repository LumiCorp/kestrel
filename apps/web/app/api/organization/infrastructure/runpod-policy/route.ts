import { NextResponse } from "next/server";
import { z } from "zod";
import {
  listManagedRunPodOrganizationAccess,
  upsertManagedRunPodOrganizationPolicy,
} from "@/lib/ai/managed-runpod-store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

const bodySchema = z.object({
  enabled: z.boolean(),
  maxActiveDeployments: z.number().int().min(0).max(100),
});

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const access = await listManagedRunPodOrganizationAccess(organizationId);
    return NextResponse.json({ policy: access.policy });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Policy is unavailable." },
      { status: 400 }
    );
  }
}

export async function PUT(request: Request) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const policy = await upsertManagedRunPodOrganizationPolicy({
      organizationId,
      actorUserId: session.user.id,
      ...bodySchema.parse(await request.json()),
    });
    return NextResponse.json({ policy });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Policy update failed." },
      { status: 400 }
    );
  }
}
