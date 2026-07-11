import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { listConfiguredGitHubRepositories } from "@/lib/knowledge/github";
import { errorResponse } from "@/lib/knowledge/http";

const querySchema = z.object({
  owner: z.string().optional(),
});

export async function GET(request: NextRequest) {
  try {
    await requireAdminOrganization();
    const query = querySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries())
    );

    const repositories = await listConfiguredGitHubRepositories();
    const filtered = query.owner
      ? repositories.filter(
          (repo) => repo.owner.toLowerCase() === query.owner?.toLowerCase()
        )
      : repositories;

    return NextResponse.json({
      count: filtered.length,
      repositories: filtered,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
