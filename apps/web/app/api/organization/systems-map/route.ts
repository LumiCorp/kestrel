import { NextResponse } from "next/server";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import {
  getOrganizationSystemsMapSnapshot,
  getProviderEstateState,
} from "@/lib/organizations/systems-map";

export async function GET(request: Request) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const snapshot = await getOrganizationSystemsMapSnapshot({ organizationId });
    if (!snapshot) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }
    const environmentId = new URL(request.url).searchParams.get("environmentId");
    return NextResponse.json({
      providerStates: await getProviderEstateState({
        organizationId,
        environments: snapshot.environments,
        environmentId,
      }),
    });
  } catch {
    return NextResponse.json({ error: "Systems map refresh failed." }, { status: 400 });
  }
}
