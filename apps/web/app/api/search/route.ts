import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { searchWorkspace } from "@/lib/search";

const querySchema = z.object({
  q: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().positive().max(20).optional(),
  projectId: z.string().uuid().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const query = querySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries())
    );
    const results = await searchWorkspace({
      organizationId,
      userId: session.user.id,
      query: query.q,
      limit: query.limit,
      projectId: query.projectId,
    });
    return NextResponse.json({ query: query.q, ...results });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
