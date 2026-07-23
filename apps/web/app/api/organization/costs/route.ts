import { NextResponse } from "next/server";
import { z } from "zod";
import { dashboardRangeSchema } from "@/lib/costs/contracts";
import { getOrganizationDashboardSnapshot } from "@/lib/costs/dashboard";
import {
  canManageOrganization,
  requireActiveOrganization,
} from "@/lib/knowledge/auth";
import { knowledgeDb } from "@/lib/knowledge/db";

const querySchema = z.object({
  range: dashboardRangeSchema.optional().default("mtd"),
}).strict();

export async function GET(request: Request) {
  try {
    const { organizationId, session } = await requireActiveOrganization(request);
    const query = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries())
    );
    const [organization, isOrganizationAdmin] = await Promise.all([
      knowledgeDb.query.organizations.findFirst({
        where: (table, { eq }) => eq(table.id, organizationId),
        columns: { id: true, name: true },
      }),
      canManageOrganization({ organizationId, userId: session.user.id }),
    ]);
    if (!organization) {
      return NextResponse.json({ error: "Organization not found." }, { status: 404 });
    }
    const snapshot = await getOrganizationDashboardSnapshot({
      organization,
      userId: session.user.id,
      isOrganizationAdmin,
      range: query.range,
    });
    return NextResponse.json(snapshot);
  } catch (error) {
    return apiError(error);
  }
}

function apiError(error: unknown) {
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "Invalid cost query." }, { status: 400 });
  }
  if (error instanceof Error && error.message === "Forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (hasErrorCode(error, "UNAUTHORIZED")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ error: "Unable to load organization costs." }, { status: 500 });
}

function hasErrorCode(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
