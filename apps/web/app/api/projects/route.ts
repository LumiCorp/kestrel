import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { createProject, listProjectsForUser } from "@/lib/projects/store";

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  instructions: z.string().trim().max(20_000).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const includeArchived =
      request.nextUrl.searchParams.get("archived") === "true";
    const projects = await listProjectsForUser({
      organizationId,
      userId: session.user.id,
      includeArchived,
    });
    return NextResponse.json({ projects });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const body = createProjectSchema.parse(await request.json());
    const project = await createProject({
      organizationId,
      userId: session.user.id,
      name: body.name,
      description: body.description,
      instructions: body.instructions,
    });
    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
