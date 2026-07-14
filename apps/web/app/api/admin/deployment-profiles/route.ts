import { NextResponse } from "next/server";
import { assertManagedRunPodEnabled } from "@/lib/ai/managed-runpod-config";
import { managedRunPodProfileInputSchema } from "@/lib/ai/managed-runpod-contracts";
import { managedRunPodErrorResponse } from "@/lib/ai/managed-runpod-http";
import {
  createManagedRunPodProfile,
  listManagedRunPodProfiles,
} from "@/lib/ai/managed-runpod-store";
import { requireAdmin } from "@/lib/knowledge/auth";

export async function GET() {
  try {
    await requireAdmin();
    assertManagedRunPodEnabled();
    return NextResponse.json({
      profiles: await listManagedRunPodProfiles({ includeInactive: true }),
    });
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();
    assertManagedRunPodEnabled();
    const profile = await createManagedRunPodProfile({
      actorUserId: session.user.id,
      profile: managedRunPodProfileInputSchema.parse(await request.json()),
    });
    return NextResponse.json({ profile }, { status: 201 });
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}
