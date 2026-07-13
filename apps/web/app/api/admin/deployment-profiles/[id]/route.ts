import { NextResponse } from "next/server";
import { z } from "zod";
import { assertManagedRunPodEnabled } from "@/lib/ai/managed-runpod-config";
import { managedRunPodErrorResponse } from "@/lib/ai/managed-runpod-http";
import {
  activateManagedRunPodProfile,
  deprecateManagedRunPodProfile,
  queueManagedRunPodQualification,
} from "@/lib/ai/managed-runpod-store";
import { requireAdmin } from "@/lib/knowledge/auth";
import { enqueueManagedRunPodRun } from "@/lib/knowledge/queue";

const paramsSchema = z.object({ id: z.string().min(1) });
const bodySchema = z.object({
  action: z.enum(["qualify", "activate", "deprecate"]),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireAdmin();
    assertManagedRunPodEnabled();
    const { id } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    if (body.action === "qualify") {
      const run = await queueManagedRunPodQualification({ profileId: id });
      await enqueueManagedRunPodRun(run!.id);
      return NextResponse.json({ run }, { status: 202 });
    }
    const profile =
      body.action === "activate"
        ? await activateManagedRunPodProfile({
            profileId: id,
            actorUserId: session.user.id,
          })
        : await deprecateManagedRunPodProfile(id);
    return NextResponse.json({ profile });
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}
