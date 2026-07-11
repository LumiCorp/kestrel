import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { searchKnowledgeDocuments } from "@/lib/knowledge/documents/retrieval";
import { errorResponse } from "@/lib/knowledge/http";

const searchQuerySchema = z.object({
  q: z.string().min(3),
  limit: z.coerce.number().int().min(1).max(12).optional(),
  scoreThreshold: z.coerce.number().min(0).max(1).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { organizationId } = await requireActiveOrganization();
    const query = searchQuerySchema.parse({
      q: request.nextUrl.searchParams.get("q"),
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
      scoreThreshold:
        request.nextUrl.searchParams.get("scoreThreshold") ?? undefined,
    });

    const results = await searchKnowledgeDocuments({
      organizationId,
      query: query.q,
      limit: query.limit,
      scoreThreshold: query.scoreThreshold,
    });

    return NextResponse.json({
      query: query.q,
      count: results.length,
      results,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
