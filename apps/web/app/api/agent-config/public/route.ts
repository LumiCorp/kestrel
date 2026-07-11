import { NextResponse } from "next/server";
import { getAgentConfigForOrganization } from "@/lib/agent/config";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET() {
  try {
    const { organizationId } = await requireActiveOrganization();
    const config = await getAgentConfigForOrganization(organizationId);
    return NextResponse.json(config);
  } catch (error) {
    return errorResponse(error);
  }
}
