import { NextResponse } from "next/server";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { listEnabledToolRuntimeNames } from "@/lib/tools/service";

export async function GET(request: Request) {
  try {
    const { organizationId } = await requireActiveOrganization();
    const runtimeNames = await listEnabledToolRuntimeNames({
      organizationId,
      surface: "chat",
      origin: new URL(request.url).origin,
    });

    return NextResponse.json({
      runtimeNames,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
