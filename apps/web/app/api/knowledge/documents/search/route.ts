import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { searchKnowledgeDocuments } from "@/lib/knowledge/documents/retrieval";
import { createHostedKnowledgeReadAuthority } from "@/lib/knowledge/documents/memory-policy";
import { errorResponse } from "@/lib/knowledge/http";

const searchQuerySchema = z.object({
  q: z.string().min(3),
  limit: z.coerce.number().int().min(1).max(12).optional(),
  scoreThreshold: z.coerce.number().min(0).max(1).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const query = searchQuerySchema.parse({
      q: request.nextUrl.searchParams.get("q"),
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
      scoreThreshold:
        request.nextUrl.searchParams.get("scoreThreshold") ?? undefined,
    });

    const taskId = crypto.randomUUID();
    const scope = { kind: "tenant" as const, tenantId: organizationId };
    const authority = createHostedKnowledgeReadAuthority({
      tenantId: organizationId,
      userId: session.user.id,
      agentId: "kestrel-one:hosted-session",
      taskId,
      scope,
      documentAccess: { mode: "scope" },
      issuer: {
        kind: "trusted_hosted",
        authorityId: "kestrel-one:hosted-session",
      },
    });
    const results = await searchKnowledgeDocuments({
      ...authority,
      scope,
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
