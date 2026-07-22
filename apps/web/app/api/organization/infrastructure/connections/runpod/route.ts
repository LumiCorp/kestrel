import { NextResponse } from "next/server";
import { z } from "zod";
import { assertManagedRunPodEnabled } from "@/lib/ai/managed-runpod-config";
import {
  configureRunPodProviderConnection,
  getRunPodProviderConnection,
  sanitizeRunPodProviderConnection,
  testRunPodProviderConnection,
} from "@/lib/ai/managed-runpod-connection";
import { managedRunPodErrorResponse } from "@/lib/ai/managed-runpod-http";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("configure"),
    apiKey: z.string().trim().min(1).nullable().optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({ action: z.literal("test") }),
]);

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    assertManagedRunPodEnabled();
    return NextResponse.json({
      connection: sanitizeRunPodProviderConnection(
        await getRunPodProviderConnection(organizationId)
      ),
    });
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    assertManagedRunPodEnabled();
    const body = bodySchema.parse(await request.json());
    const connection =
      body.action === "test"
        ? await testRunPodProviderConnection({ organizationId })
        : await configureRunPodProviderConnection({
            organizationId,
            apiKey: body.apiKey,
            enabled: body.enabled,
          });
    return NextResponse.json({ connection });
  } catch (error) {
    return managedRunPodErrorResponse(error);
  }
}
