import { NextResponse } from "next/server";
import { z } from "zod";
import { assertManagedRunPodEnabled } from "@/lib/ai/managed-runpod-config";
import { managedRunPodErrorResponse } from "@/lib/ai/managed-runpod-http";
import { listManagedRunPodFleet } from "@/lib/ai/managed-runpod-store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import {
  enqueueManagedRunPodReconciliation,
  enqueueManagedRunPodUsageIngestion,
} from "@/lib/knowledge/queue";

const bodySchema = z.object({
  action: z.enum(["reconcile", "ingest-usage"]),
});

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    assertManagedRunPodEnabled();
    return NextResponse.json({ fleet: await listManagedRunPodFleet(organizationId) });
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireOrganizationAdmin();
    assertManagedRunPodEnabled();
    const { action } = bodySchema.parse(await request.json());
    if (action === "reconcile") {
      await enqueueManagedRunPodReconciliation();
    } else {
      await enqueueManagedRunPodUsageIngestion();
    }
    return NextResponse.json({ queued: true }, { status: 202 });
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}
