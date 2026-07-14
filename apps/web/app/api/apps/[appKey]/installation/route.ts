import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { setAppInstallation } from "@/lib/apps/service";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

async function updateInstallation(
  appKey: string,
  installed: boolean
) {
  const { organizationId, session } = await requireOrganizationAdmin();
  const decodedAppKey = decodeURIComponent(appKey);
  await setAppInstallation({
    organizationId,
    appKey: decodedAppKey,
    actorUserId: session.user.id,
    installed,
  });
  await logAdminEvent({
    organizationId,
    actorUserId: session.user.id,
    category: "apps",
    action: installed ? "app.install" : "app.disable",
    targetType: "app",
    targetId: decodedAppKey,
    message: installed
      ? `Installed App ${decodedAppKey}.`
      : `Disabled App ${decodedAppKey} while retaining its connections and policy.`,
    metadata: { installed },
  });
  return NextResponse.json({ ok: true, installed });
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "App could not be updated.";
  const status = message === "Forbidden" ? 403 : message === "App not found." ? 404 : 400;
  return NextResponse.json({ error: message }, { status });
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ appKey: string }> }
) {
  try {
    const { appKey } = await params;
    return await updateInstallation(appKey, true);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ appKey: string }> }
) {
  try {
    const { appKey } = await params;
    return await updateInstallation(appKey, false);
  } catch (error) {
    return errorResponse(error);
  }
}
