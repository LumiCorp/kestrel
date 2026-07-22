import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { costVisibilitySchema } from "@/lib/costs/contracts";
import {
  getOrganizationDashboardSettings,
  saveOrganizationDashboardSettings,
} from "@/lib/costs/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

const settingsSchema = z.object({ costVisibility: costVisibilitySchema }).strict();

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    return NextResponse.json(await getOrganizationDashboardSettings(organizationId));
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const body = settingsSchema.parse(await request.json());
    const settings = await saveOrganizationDashboardSettings({
      organizationId,
      actorUserId: session.user.id,
      costVisibility: body.costVisibility,
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "costs",
      action: "update-visibility",
      targetType: "organization_dashboard_settings",
      targetId: organizationId,
      message: "Updated organization cost visibility.",
      metadata: { costVisibility: settings.costVisibility },
    }).catch(() => {
      console.error("[costs] Settings committed, but audit recording failed.");
    });
    return NextResponse.json({ costVisibility: settings.costVisibility });
  } catch (error) {
    return apiError(error);
  }
}

function apiError(error: unknown) {
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "Invalid cost settings." }, { status: 400 });
  }
  if (error instanceof Error && error.message === "Forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (hasErrorCode(error, "UNAUTHORIZED")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ error: "Unable to update cost settings." }, { status: 500 });
}

function hasErrorCode(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
