import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileErrorResponse } from "@/lib/mobile/http";

const bodySchema = z.object({
  id: routeIdSchema,
  platform: z.enum(["ios", "android"]),
  expoPushToken: z.string().min(10).max(500),
  appVersion: z.string().min(1).max(50).optional(),
  locale: z.string().min(2).max(50).optional(),
  timezone: z.string().min(1).max(100).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const body = bodySchema.parse(await request.json());
    const now = new Date();
    const [device] = await knowledgeDb
      .insert(schema.mobileDeviceRegistrations)
      .values({
        ...body,
        userId: session.user.id,
        organizationId,
        enabled: true,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.mobileDeviceRegistrations.expoPushToken,
        set: {
          userId: session.user.id,
          organizationId,
          platform: body.platform,
          appVersion: body.appVersion ?? null,
          locale: body.locale ?? null,
          timezone: body.timezone ?? null,
          enabled: true,
          lastSeenAt: now,
          updatedAt: now,
        },
      })
      .returning({ id: schema.mobileDeviceRegistrations.id });
    return NextResponse.json({ deviceId: device?.id ?? body.id });
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { session } = await requireActiveOrganization();
    const id = routeIdSchema.parse(request.nextUrl.searchParams.get("id"));
    const [device] = await knowledgeDb
      .update(schema.mobileDeviceRegistrations)
      .set({ enabled: false, updatedAt: new Date() })
      .where(
        and(
          eq(schema.mobileDeviceRegistrations.id, id),
          eq(schema.mobileDeviceRegistrations.userId, session.user.id)
        )
      )
      .returning({
        id: schema.mobileDeviceRegistrations.id,
        userId: schema.mobileDeviceRegistrations.userId,
      });
    if (!device) {
      return mobileErrorResponse(new Error("Device not found"), 404);
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}
