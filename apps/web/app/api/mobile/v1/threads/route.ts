import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileThreadDtos } from "@/lib/mobile/dto";
import { createThreadForUser, listThreadsForUser } from "@/lib/threads/store";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: routeIdSchema.optional(),
  projectId: routeIdSchema.optional(),
});
const createSchema = z.object({
  id: routeIdSchema,
  projectId: routeIdSchema.nullable().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const query = querySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries())
    );
    const pageSize = query.limit ?? 30;
    const threads = (
      await listThreadsForUser(session.user.id, organizationId, {
        limit: pageSize + 1,
        endingBefore: query.cursor,
        projectId: query.projectId,
      })
    ).filter((thread) => thread.mode === "chat");
    const page = threads.slice(0, pageSize);
    return NextResponse.json({
      threads: await mobileThreadDtos(page),
      nextCursor: threads.length > pageSize ? (page.at(-1)?.id ?? null) : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const body = createSchema.parse(await request.json());
    const thread = await createThreadForUser({
      id: body.id,
      userId: session.user.id,
      organizationId,
      projectId: body.projectId,
      mode: "chat",
      origin: "mobile",
      title: "",
    });
    if (!thread) {
      throw new Error("Thread creation failed.");
    }
    return NextResponse.json(
      { thread: (await mobileThreadDtos([thread]))[0] },
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
