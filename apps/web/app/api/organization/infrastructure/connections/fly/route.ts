import { NextResponse } from "next/server";
import { z } from "zod";
import {
  configureFlyProviderConnection,
  getFlyProviderConnection,
  sanitizeFlyProviderConnection,
  testFlyProviderConnection,
} from "@/lib/environments/fly-connection";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("configure"),
    apiToken: z.string().trim().min(1).nullable().optional(),
    organizationSlug: z.string().trim().min(1),
    enabled: z.boolean().optional(),
  }),
  z.object({ action: z.literal("test") }),
]);

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    return NextResponse.json({
      connection: sanitizeFlyProviderConnection(
        await getFlyProviderConnection(organizationId)
      ),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Fly connection failed." },
      { status: 400 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const body = bodySchema.parse(await request.json());
    const connection =
      body.action === "test"
        ? await testFlyProviderConnection(organizationId)
        : await configureFlyProviderConnection({ organizationId, ...body });
    return NextResponse.json({ connection });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Fly connection failed." },
      { status: 400 }
    );
  }
}
