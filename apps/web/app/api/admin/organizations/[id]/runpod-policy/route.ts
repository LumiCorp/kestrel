import { NextResponse } from "next/server";
import { z } from "zod";
import { assertManagedRunPodEnabled } from "@/lib/ai/managed-runpod-config";
import { managedRunPodErrorResponse } from "@/lib/ai/managed-runpod-http";
import {
  listManagedRunPodOrganizationAccess,
  upsertManagedRunPodOrganizationPolicy,
} from "@/lib/ai/managed-runpod-store";
import { requireAdmin } from "@/lib/knowledge/auth";

const paramsSchema = z.object({ id: z.string().min(1) });
const bodySchema = z.object({
  enabled: z.boolean(),
  maxActiveDeployments: z.number().int().min(0).max(100),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin();
    assertManagedRunPodEnabled();
    const { id } = paramsSchema.parse(await context.params);
    return NextResponse.json(await listManagedRunPodOrganizationAccess(id));
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireAdmin();
    assertManagedRunPodEnabled();
    const { id } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const policy = await upsertManagedRunPodOrganizationPolicy({
      organizationId: id,
      actorUserId: session.user.id,
      ...body,
    });
    return NextResponse.json({ policy });
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}
