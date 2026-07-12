import type { UIMessage } from "ai";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema, uiMessageSchema } from "@/lib/knowledge/validation";
import { resolveProjectRuntimeContext } from "@/lib/projects/runtime-context";
import {
  createThreadForUser,
  listThreadsForUser,
  saveThreadMessages,
} from "@/lib/threads/store";

const createBodySchema = z.object({
  id: routeIdSchema,
  projectId: routeIdSchema.nullable().optional(),
  mode: z.enum(["chat", "admin"]).optional().default("chat"),
  message: (uiMessageSchema as z.ZodType<UIMessage>).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  ending_before: routeIdSchema.optional(),
  project_id: routeIdSchema.optional(),
  standalone: z.enum(["true", "false"]).optional(),
  archived: z.enum(["true", "false"]).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const query = listQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries())
    );
    const pageSize = query.limit ?? 20;
    const threads = await listThreadsForUser(session.user.id, organizationId, {
      limit: pageSize + 1,
      endingBefore: query.ending_before ?? null,
      projectId:
        query.standalone === "true" ? null : (query.project_id ?? undefined),
      includeArchived: query.archived === "true",
    });
    const hasMore = threads.length > pageSize;
    const page = hasMore ? threads.slice(0, pageSize) : threads;

    return NextResponse.json({
      threads: page.map((thread) => ({
        ...thread,
        title: thread.title || "New thread",
        visibility: thread.isPublic ? "public" : "private",
      })),
      hasMore,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const body = createBodySchema.parse(await request.json());
    const user = session.user as { id: string; role?: string | null };
    if (body.mode === "admin" && user.role !== "admin") {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      );
    }

    const thread = await createThreadForUser({
      id: body.id,
      userId: user.id,
      organizationId,
      projectId: body.projectId,
      mode: body.mode,
      title: "",
    });
    if (!thread) {
      throw new Error("Thread creation failed.");
    }
    if (body.message) {
      const projectContext = await resolveProjectRuntimeContext({
        projectId: thread.projectId,
        organizationId,
        userId: user.id,
      });
      await saveThreadMessages([
        {
          id: body.message.id,
          threadId: thread.id,
          role: "user",
          authorUserId: user.id,
          projectContextRevisionId: projectContext?.contextRevision.id ?? null,
          parts: body.message.parts,
        },
      ]);
    }
    return NextResponse.json(thread, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
